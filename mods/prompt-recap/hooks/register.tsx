// Prompt Recap: your prompts, what you added mid-turn and how each turn ended, with the session at a
// glance on top (goal, now, waiting on you, next) and the background agents at work, in a pane. Press a
// prompt to jump back to it in the transcript (the fullscreen view scrolls; the classic one cannot), an
// agent to watch its transcript. Docked, the top stays put and the list scrolls in its own frame.
// Summaries can be turned off.
import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import type { AgentTask, FullRecap, RecapEntry, SessionRecap } from '../types'

const PANE = 'prompt-recap'
const TITLE = 'Prompt Recap'
const CONFIG_KEY = 'prompt-recap.summary'
const MODEL = 'haiku'
const MAX_ENTRIES = 200
const MAX_PROMPT = 300
const MAX_LINE = 200
const MAX_LOG = 20
const HEAD = 80
const LOOSE_MIN = 20 // the shortest head a jump matches loosely
const PROMOTE_WITHIN = 3 // how far back a message typed over an ended turn is looked for
const RECENT_PROMPTS = 4 // your last prompts the summary reads, so the goal follows where you are now
const INLINE_ENTRIES = 3 // an inline pane sits above the prompt: keep it short
const AGENTS_SHOWN = 5 // the agents the top shows: running first, then the latest to end
const MAX_ENDED = 50 // the ended agents kept on record
const TICK_MS = 3000 // how often the agents are checked and elapsed times move on
const WHEEL_ROWS = 3 // screen lines one wheel tick moves
const SAVED_SESSIONS = 10 // the latest sessions whose list is kept for a resume
const SAVED_ENTRIES = 100 // the latest prompts kept of each
const SAVED_FOLLOW_UPS = 10 // the latest follow-ups kept of each prompt
const INDEX_KEY = 'sessions' // the saved sessions, latest first

// A session's list as kept in this plugin's store for a resume, and the store's index of them.
type SavedSession = { entries: RecapEntry[]; recap: SessionRecap | null }
type SavedIndex = { id: string; savedAt: number }[]

// Held by the host, so they survive a hot reload of this file and a change of the option.
const entries = atom({ plugin: 'prompt-recap', key: 'entries' } as const, [] as RecapEntry[])
const recap = atom({ plugin: 'prompt-recap', key: 'recap' } as const, null as SessionRecap | null)
const live = atom({ plugin: 'prompt-recap', key: 'live' } as const, '')
const full = atom({ plugin: 'prompt-recap', key: 'full' } as const, null as FullRecap | null)
const agents = atom({ plugin: 'prompt-recap', key: 'agents' } as const, [] as AgentTask[])
const isAgentsOpen = atom({ plugin: 'prompt-recap', key: 'isAgentsOpen' } as const, true)
const tick = atom({ plugin: 'prompt-recap', key: 'tick' } as const, 0)

// What moves faster than it is worth a write, and the list's scrolling: this module's own.
const rt = {
  activity: new Map<string, { tools: number; last: string }>(), // per agent, folded into `agents` each tick
  top: 0, // the first list line on screen, docked; 0 shows the newest prompt
  listRows: 0, // the lines the list has on screen, as its scrollbar measured them
  totalRows: 0, // the list's lines, as last drawn
  isPinned: false, // the pane is docked and held to its height, so its list scrolls here
  sessionId: '', // the session the list belongs to: another at a prompt is a resume or a /clear
}

export const register: Register = (on, options) => {
  const isSummaryOn = options.summary !== 'off'
  let lastTurnId = '' // the main turn that ended last: only its summary may replace the one on top
  let log: string[] = [] // this turn's tool calls, for the summary
  const rows = new Map<string, string>() // a prompt's head -> its transcript row, as last drawn

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({
      name: 'prompt-recap',
      description: 'Show your prompts and how each turn ended in a pane',
      argumentHint: '[recap | clear | summary on|off]',
    }).catch(() => {}) // a name Claude Code already has is refused: start anyway
    // The agents' status and the elapsed times, kept current while the session runs; and once now, for
    // any already at work when this mod loaded.
    $.clock.every(TICK_MS, () => void refreshAgents($).catch(() => {}))
    void refreshAgents($, true).catch(() => {})
    // `claude --resume` and `--continue` go on under the same session id: its list comes back.
    void $.session
      .id()
      .then(id => restoreSession($, id))
      .catch(() => {})
    return r
  })

  // /clear and /resume go on in this process under another session: it starts empty, its transcript too.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      lastTurnId = '' // a summary still on its way belongs to the session that ended
      rows.clear()
      rt.activity.clear()
      await clearAll($).catch(() => {})
      await update($, agents, () => []).catch(() => {})
    }
    return next(e)
  })

  // A background agent starts: kept here with what it is for and the model it runs on.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if ('agentId' in r && r.agentId) {
      const agentId = r.agentId
      const startedAt = await $.clock.now()
      await update($, agents, list => addAgent(list, { id: agentId, description: e.description, type: e.subagentType, model: r.model ?? '', startedAt }))
    }
    return r
  }).catch(($, e, next) => next(e)) // observe only: a failure here never holds an agent back

  on('prompt.submit', async ($, e, next) => {
    if (!isOwn(e)) return next(e)
    // A /resume or /clear goes on under another session with no session.start: the first prompt there
    // brings back the list that session left, if any, before it goes in.
    await followSession($).catch(() => {})
    if (e.turnId && !e.wait) {
      // Typed while a turn ran: it belongs to that turn. One asked to wait (ctrl+x enter) gets a turn of its own.
      const r = await next(e)
      if (!r.drop) await update($, entries, list => addFollowUp(list, e.turnId!, e.text))
      return r
    }
    // A new prompt goes in before next(e): its turn starts inside it.
    let id = 0
    await update($, entries, list => {
      const added = addPrompt(list, e.text)
      id = added.at(-1)!.id
      return added
    })
    const r = await next(e)
    if (r.drop) await update($, entries, list => list.filter(entry => entry.id !== id))
    return r
  }).catch(($, e, next) => next(e)) // a failure here never holds a prompt back

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      log = []
      const list = await update($, entries, all => startTurn(all, e.turnId, e.text))
      if (list.some(entry => entry.turnId === e.turnId)) {
        await update($, live, () => 'reading your message')
        void saveSession($).catch(() => {}) // left mid-turn, a resume shows it cut off
      }
    } else await reviveAgent($, e.agentId).catch(() => {}) // a known agent at work again
    return next(e)
  })

  // Observe only: note what is happening, then let the call run untouched. Only Claude's own calls
  // count: one another mod makes in the background names that plugin as its origin, not the engine.
  on('tool.call', async ($, e, next) => {
    if (next.origin.plugin !== 'engine') return next(e)
    const line = describe(e as unknown as Record<string, unknown>)
    log = [...log, e.agentId ? `(agent) ${line}` : line].slice(-MAX_LOG)
    if (!e.agentId) await update($, live, () => line)
    else {
      // An agent's calls come fast: counted here, shown on the next tick.
      const seen = rt.activity.get(e.agentId) ?? { tools: 0, last: '' }
      rt.activity.set(e.agentId, { tools: seen.tools + 1, last: line })
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // nor a tool call

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) {
      // An agent's run ended: done, failed or stopped, whatever its list entry says later.
      const endedAt = await $.clock.now()
      const agentId = e.agentId
      const status = e.reason === 'answer' ? 'completed' : e.reason === 'aborted' ? 'killed' : 'failed'
      await update($, agents, list => endAgent(list, agentId, status, endedAt))
      return r
    }
    await update($, live, () => '')
    const answer = e.isAborted ? '(interrupted)' : e.reason === 'error' ? '(error)' : e.reason === 'refusal' ? '(refused)' : firstLine(e.answer)
    const list = await update($, entries, all => completeTurn(all, e.turnId, answer, e.durationMs))
    const entry = list.find(one => one.turnId === e.turnId)
    if (!entry) return r // a turn nobody typed for (a notification's) is not "the last one" either
    lastTurnId = e.turnId
    // With summaries off the recap on top goes stale with each turn: drop it, so none shows when they come back.
    if (!isSummaryOn) await update($, recap, () => null)
    // Only answered turns you typed for are summarized, in the background, so the turn ends at once.
    else if (e.reason === 'answer' && e.answer !== '') {
      const recent = list.slice(-RECENT_PROMPTS).map(one => one.prompt)
      void summarize($, entry, recent, log, e.answer, turnId => turnId === lastTurnId).catch(() => {})
    }
    void saveSession($).catch(() => {}) // kept for a resume
    return r
  })

  // Observe only: note which transcript row holds each prompt, so a press can scroll to it.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    if (e.props.origin.kind === 'composer' && e.props.text) rows.set(head(e.props.text), e.requestId)
    return next(e)
  })

  on('command.run', { command: 'prompt-recap' }, async ($, e) => {
    const args = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (args[0] === 'summary' && (args[1] === 'on' || args[1] === 'off')) {
      const deny = await setSummary($, args[1] === 'on')
      return { text: deny ? `Summaries not changed: ${deny}` : `Summaries ${args[1]}` }
    }
    if (args[0] === 'clear') {
      lastTurnId = '' // a summary still on its way is dropped, not shown over the empty list
      await clearAll($)
      await forgetSession($).catch(() => {}) // a resume brings back nothing either
      return { text: 'Prompt Recap cleared' }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    if (args[0] === 'recap') {
      void fullRecap($).catch(() => {}) // asked for: it runs with summaries off too
      return { text: 'Writing a full recap in the Prompt Recap pane' }
    }
    return { text: 'Prompt Recap opened' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Client = 'Client' in table ? table.Client : null // the scrollbar takes the pointer where a surface has it
    // Where something is at work: a still hourglass, highlighted. Nothing animates, so nothing redraws for it.
    const busy = () => <Text color="yellow">{'⏳'}</Text>
    await read($, tick) // redraws as agents work and the list scrolls
    const list = await read($, entries)
    const now = await read($, live)
    const glance = isSummaryOn ? await read($, recap) : null
    const longer = await read($, full)
    const tasks = await read($, agents)
    const isOpen = await read($, isAgentsOpen)
    const at = tasks.length > 0 ? await $.clock.now() : 0 // the time agents have run, read only when there are any
    const isInline = e.props.placement === 'inline'
    const viewing = e.props.view?.agentId
    // Docked, the pane is held to its body's height: the top stays put and only the list scrolls, by this
    // mod (ui.scroll below), not by the engine. Inline above the prompt it keeps its natural height.
    const bodyRows = e.props.scroll?.bodyRows ?? 0
    rt.isPinned = !isInline && bodyRows > 0
    const shownEntries = isInline ? list.slice(-INLINE_ENTRIES) : list
    const nowText = now || glance?.now || ''
    const running = tasks.filter(task => isRunning(task.status)).length
    const picked = pickAgents(tasks, AGENTS_SHOWN)

    // The list as rows, newest prompt first: each row one thing to draw and the text it wraps by.
    const listRows: ListRow[] = []
    if (longer) {
      listRows.push({ text: 'Full recap', node: <Text bold>{'📋 Full recap'}</Text> })
      const lines = longer.isLoading ? ['writing…'] : longer.text.split('\n').filter(line => line.trim() !== '')
      for (const line of lines) listRows.push({ text: line, node: <Text wrap="wrap" dimColor={longer.isLoading}>{line}</Text> })
      listRows.push({ text: 'Hide', node: <Button key="hide" label="Hide" hotkey="h" dimColor onPress={() => void update($, full, () => null)} /> })
      listRows.push({ text: '', node: <Text>{' '}</Text> })
    }
    if (list.length === 0) listRows.push({ text: 'No prompts yet.', node: <Text dimColor>No prompts yet. Ask something and it shows up here.</Text> })
    ;[...shownEntries].reverse().forEach((entry, i) => {
      // The prompt at work is marked down its left side and drawn bright, with an hourglass.
      const isWorking = !entry.isDone
      const bar = isWorking ? <Text color="yellow">{'▌'}</Text> : <Text>{' '}</Text>
      if (i > 0) listRows.push({ text: '', node: <Text>{' '}</Text> })
      listRows.push({
        text: ` #${entry.id} ${entry.prompt}`,
        node: (
          <Box key={`p:${entry.id}`} flexDirection="row">
            {bar}
            <Button key={`jump:${entry.id}`} plain onPress={() => {}}>
              <Text color={isWorking ? 'yellow' : 'cyan'} bold>{`#${entry.id} `}</Text>
              <Text bold={isWorking}>{entry.prompt}</Text>
            </Button>
          </Box>
        ),
      })
      entry.followUps.forEach((text, n) => {
        listRows.push({
          text: `   ↳ ${text}`,
          node: (
            <Box key={`f:${entry.id}:${n + 1}`} flexDirection="row">
              {bar}
              <Button key={`jump:${entry.id}:${n + 1}`} plain onPress={() => {}}>
                <Text dimColor>{'  ↳ '}</Text>
                {text}
              </Button>
            </Box>
          ),
        })
      })
      const result = entry.summary || entry.answer || '(no reply)'
      listRows.push(
        entry.isDone
          ? {
              text: `   ✓ ${result}${entry.durationMs > 0 ? `  · ${duration(entry.durationMs)}` : ''}`,
              node: (
                <Text wrap="wrap">
                  <Text color="green">{`   ✓ ${result}`}</Text>
                  {entry.durationMs > 0 && <Text dimColor>{`  · ${duration(entry.durationMs)}`}</Text>}
                </Text>
              ),
            }
          : {
              text: '   ⏳ working…', // cut to one line
              node: (
                <Box key={`w:${entry.id}`} flexDirection="row">
                  {bar}
                  <Text>{'  '}</Text>
                  {busy()}
                  <Text color="yellow" bold wrap="truncate-end">
                    {' working…'}
                    {now !== '' && <Text color="yellow">{` · ${now}`}</Text>}
                  </Text>
                </Box>
              ),
            },
      )
      if (entry.waiting !== '') listRows.push({ text: `   🔔 ${entry.waiting}`, node: <Text color="yellow" wrap="wrap">{`   🔔 ${entry.waiting}`}</Text> })
    })
    // Scrolled by screen lines: each row's, as it wraps inside the frame, its scrollbar and the bar to its left.
    const lines = listRows.map(row => lineCount(row.text, e.props.bodyColumns - 4))
    rt.totalRows = lines.reduce((sum, n) => sum + n, 0)
    rt.top = scrolledTop(rt.top, 0, rt.totalRows, rt.listRows)
    const visible = rt.isPinned ? rowsFrom(listRows, lines, rt.top, rt.listRows > 0 ? rt.listRows : bodyRows) : listRows
    const pin = rt.isPinned ? { height: bodyRows, overflow: 'hidden' as const } : {}
    const frame = rt.isPinned ? { flexGrow: 1, overflow: 'hidden' as const } : {}
    const inside = rt.isPinned ? { flexGrow: 1, overflow: 'hidden' as const } : {}

    return (
      <Box flexDirection="column" gap={1} {...pin}>
        <Box flexDirection="column" flexShrink={0}>
          {glance && glance.goal !== '' && (
            <Text wrap="wrap">
              <Text color="cyan" bold>{'🎯 Goal: '}</Text>
              {glance.goal}
            </Text>
          )}
          {nowText !== '' && (
            <Box flexDirection="row">
              <Text>{'  '}</Text>
              {now !== '' ? busy() : <Text dimColor>{'⚡'}</Text>}
              <Text wrap="wrap">
                <Text dimColor>{' now: '}</Text>
                <Text color={now !== '' ? 'yellow' : undefined}>{nowText}</Text>
              </Text>
            </Box>
          )}
          {glance && glance.next !== '' && (
            <Text wrap="wrap">
              <Text dimColor>{'  ⏭ next: '}</Text>
              {glance.next}
            </Text>
          )}
          {glance && glance.waiting !== '' && <Text color="yellow" wrap="wrap">{`  🔔 waiting on you: ${glance.waiting}`}</Text>}
          <Box flexDirection="row" gap={1}>
            {!isInline && <Button key="full" label="📋 Full recap" hotkey="r" dimColor onPress={() => void fullRecap($).catch(() => {})} />}
            <Button key="summary" label={`Summary: ${isSummaryOn ? 'on' : 'off'}`} hotkey="s" dimColor onPress={() => void toggleSummary($, !isSummaryOn)} />
            {/* No hotkey: a letter typed while the pane holds the keys must not wipe the list. */}
            <Button
              key="clear"
              label="🧹 Clear"
              dimColor
              onPress={() => {
                lastTurnId = '' // a summary still on its way is dropped, not shown over the empty list
                void clearAll($)
                  .then(() => forgetSession($)) // a resume brings back nothing either
                  .catch(() => {})
              }}
            />
            {tasks.length > 0 && (
              <Button key="agents" label={`🤖 Agents ${running}/${tasks.length} ${isOpen ? '▴' : '▾'}`} dimColor onPress={() => void update($, isAgentsOpen, v => !v)} />
            )}
          </Box>
          {viewing && <Button key="back" label="← Back to main" variant="primary" onPress={() => {}} />}
          {isOpen && picked.shown.length > 0 && (
            <Box flexDirection="column">
              {picked.shown.map(task => {
                const mark = statusMark(task.status)
                const spent = duration((task.endedAt || at) - task.startedAt)
                const isAtWork = isRunning(task.status)
                return (
                  <Box key={`row:${task.id}`} flexDirection="column">
                    <Box flexDirection="row">
                      <Text color={isAtWork ? 'yellow' : undefined}>{task.id === viewing ? '▶' : isAtWork ? '▌' : ' '}</Text>
                      <Text color={mark.color}>{mark.icon}</Text>
                      <Text>{' '}</Text>
                      <Button key={`agent:${task.id}`} plain onPress={() => {}}>
                        <Text color={isAtWork ? 'yellow' : undefined} bold={isAtWork}>{task.description || task.type}</Text>
                        <Text dimColor>{`  ${modelLabel(task)} · ${spent} · ${task.tools} tools`}</Text>
                      </Button>
                    </Box>
                    {isAtWork && task.last !== '' && <Text dimColor wrap="truncate-end">{`     ↳ ${task.last}`}</Text>}
                  </Box>
                )
              })}
              {picked.more > 0 && <Text dimColor>{`   +${picked.more} more`}</Text>}
            </Box>
          )}
        </Box>

        <Box key="list" flexDirection="row" borderStyle="round" borderDimColor {...frame}>
          <Box flexDirection="column" flexGrow={1} {...inside}>
            {visible.map(row => row.node)}
          </Box>
          {rt.isPinned && Client && (
            <Client key="scrollbar" module="./scrollbar.tsx" props={{ total: rt.totalRows, top: rt.top }} width={1} height="100%" />
          )}
        </Box>
      </Box>
    )
  })

  // A press on a prompt jumps to it, on an agent shows its transcript, on Back the main one again. Done
  // here, with this press's own $: the engine moves the transcript and the view only for the person's input.
  on('ui.press', { plugin: 'prompt-recap', component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.element.startsWith('agent:')) await openView($, e.element.slice('agent:'.length))
    else if (e.element === 'back') await openView($, '')
    else if (e.element.startsWith('jump:')) {
      const [, id, n] = e.element.split(':')
      const entry = (await read($, entries)).find(one => String(one.id) === id)
      const text = entry && (n ? entry.followUps[Number(n) - 1] : entry.prompt)
      await jump($, text === undefined ? undefined : findRow(rows, head(text)))
    } else return next(e) // the Buttons whose own onPress does the work
    // Answered here: these Buttons' onPress is empty, and the pane drawn since (Back gone once the main
    // view is back) may hold no closure of the one pressed for the engine to run.
    return { element: e.element }
  })

  // Docked, the list scrolls itself: the wheel, the arrows and the page keys move it, and the engine's
  // window stays at the top, where the buttons are. Inline, the engine scrolls as usual.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (!rt.isPinned) return next(e)
    rt.top = scrolledTop(rt.top, e.pointer ? e.by * WHEEL_ROWS : e.by, rt.totalRows, rt.listRows)
    void update($, tick, n => n + 1).catch(() => {})
    return next({ ...e, offset: 0 })
  })

  // The scrollbar says where to look (a press or a drag) and how many rows the list has on screen.
  on('ui.message', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const data = (e.data ?? {}) as { top?: unknown; rows?: unknown }
    let isMoved = false
    if (typeof data.rows === 'number' && data.rows > 0 && data.rows !== rt.listRows) {
      rt.listRows = data.rows
      isMoved = true
    }
    if (typeof data.top === 'number') {
      rt.top = scrolledTop(data.top, 0, rt.totalRows, rt.listRows)
      isMoved = true
    }
    if (isMoved) void update($, tick, n => n + 1).catch(() => {})
    return next(e)
  })
}

// The model reads a turn and writes its summary and the session's recap. `recent` is your last few
// prompts, oldest first, so the goal follows where you are now rather than where you started. `isLatest`
// says whether the turn is still the last one to end: an older turn's late answer leaves the newer recap
// on top, and after Clear none is.
async function summarize(
  $: EngineInterface,
  entry: RecapEntry,
  recent: string[],
  tools: string[],
  answer: string,
  isLatest: (turnId: string) => boolean,
) {
  const before = await read($, recap)
  const r = await $.model.complete({
    model: MODEL,
    maxTokens: 600, // four fields of Korean take more tokens than of English
    system:
      'You keep a one-glance recap of a coding session. Plain words, no em dashes, each field at most 70 ' +
      'characters, written in the language the person writes in. Reply with JSON only, no code fence: {"goal","now","waiting","next"}. ' +
      '"goal": what the person is working toward now. Write it fresh from their recent messages; reuse the ' +
      "previous goal's wording only while those messages still serve it. " +
      '"now": what this turn did, as its result. "waiting": what the assistant is waiting on from the person, or "". ' +
      '"next": the next step.',
    prompt: [
      `Previous goal: ${before?.goal || 'none'}`,
      `The person's recent messages, oldest first:\n${recent.map(text => `- ${text}`).join('\n')}`,
      `The person's message this turn: ${entry.prompt}`,
      entry.followUps.length > 0 ? `What the person added while the turn ran: ${entry.followUps.join(' / ')}` : '',
      `Tools used this turn: ${tools.join('; ') || 'none'}`,
      `The assistant's reply: ${answer.slice(0, 2500)}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  })
  if (!r.isAnswered) return
  const parsed = parseRecap(r.text)
  if (!parsed) return
  await update($, entries, list => attachRecap(list, entry.turnId, parsed.now, parsed.waiting))
  if (isLatest(entry.turnId)) await update($, recap, () => parsed)
  await saveSession($) // with its summary
}

let fullAsked = 0 // which Full recap is the one waited for: a Hide, a Clear or a newer ask drops the others

// The longer recap: the last messages of the conversation in a few bullets, shown in the pane.
async function fullRecap($: EngineInterface) {
  if ((await read($, full))?.isLoading) return
  const asked = ++fullAsked
  await update($, full, () => ({ text: '', isLoading: true }))
  // Lands only if it is still the one waited for: hidden or cleared meanwhile, it stays gone.
  const land = (text: string) => update($, full, now => (now?.isLoading && asked === fullAsked ? { text, isLoading: false } : now))
  try {
    const messages = (await $.session.messages()).slice(-12)
    const r = await $.model.complete({
      model: MODEL,
      maxTokens: 500,
      system:
        'Write a recap of this coding session for someone who lost track. Plain words, no em dashes, written in ' +
        'the language the person writes in. At most 6 short bullets: the goal, what is done, what is happening now, ' +
        'what is waiting on them, the next step.',
      prompt: [
        `<transcript>\n${messages
          .filter(m => m.text.trim() !== '')
          .map(m => `[${m.role === 'user' ? 'person' : 'assistant'}] ${m.text.slice(0, 800)}`)
          .join('\n')}\n</transcript>`,
        'Write the recap of the transcript above now: the bullets only, not a reply to it.',
      ].join('\n\n'),
    })
    await land(r.isAnswered ? r.text.trim() : 'Could not build a recap right now.')
  } catch {
    await land('Could not build a recap right now.')
  }
}

// Empties the pane: the list, the recap on top, what is happening now and the full recap.
// Empties the list and the top; of the agents only those still at work stay.
async function clearAll($: EngineInterface) {
  rt.top = 0
  await Promise.all([
    update($, entries, () => []),
    update($, recap, () => null),
    update($, live, () => ''),
    update($, full, () => null),
    update($, agents, all => all.filter(task => isRunning(task.status))),
  ])
}

// Writes the option as the /config menu would; the module then reloads with it. Answers why it did not.
// The recap on top is left alone here: a refused write changes nothing, and with summaries off each turn
// that ends drops it (turn.complete), so none is stale when they come back.
async function setSummary($: EngineInterface, isOn: boolean): Promise<string | undefined> {
  try {
    return (await $.config.set({ key: CONFIG_KEY, value: isOn ? 'on' : 'off' })).deny
  } catch (err) {
    return (err as Error).message
  }
}

async function toggleSummary($: EngineInterface, isOn: boolean) {
  const deny = await setSummary($, isOn)
  if (deny) $.ui.toast(`prompt-recap: summaries not changed (${deny})`)
}

// The transcript row of a prompt by its head; loosely, where the row's text and the typed text part
// ways after their start (a paste, a rewrite), but only for heads long enough not to match by chance
// ("ok" is no start of "ok, go ahead"). The same head typed twice finds the row drawn last.
export function findRow(rows: Map<string, string>, key: string): string | undefined {
  const exact = rows.get(key)
  if (exact || key.length < LOOSE_MIN) return exact
  let found: string | undefined
  for (const [text, requestId] of rows) {
    if (text.length >= LOOSE_MIN && (text.startsWith(key) || key.startsWith(text))) found = requestId
  }
  return found
}

// Scrolls the transcript to a prompt's row; says why when it cannot.
async function jump($: EngineInterface, requestId: string | undefined) {
  if (!requestId) {
    $.ui.toast('prompt-recap: that prompt is not on screen to jump to')
    return
  }
  const deny = await $.ui.scroll({ to: { requestId }, block: 'start' }).then(
    r => r.deny,
    (err: Error) => err.message,
  )
  if (deny) $.ui.toast(`prompt-recap: cannot jump there (${deny}). The fullscreen view ("tui": "fullscreen") scrolls.`)
}

// The person's own prompts: typed or sent from a phone, not a slash command, a notification or a plugin's.
function isOwn(e: { command?: unknown; isMeta?: true; origin: { kind: string } }) {
  return !e.command && !e.isMeta && (e.origin.kind === 'composer' || e.origin.kind === 'bridge')
}

// A short label for one tool call: what a person would say Claude is doing.
export function describe(e: Record<string, unknown>): string {
  const tool = String(e.tool)
  const s = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  const file = (p: string) => p.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
  if (tool === 'Bash' || tool === 'PowerShell') return `running ${s('description') || s('command').slice(0, 60)}`
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return `editing ${file(s('file_path') || s('notebook_path'))}`
  if (tool === 'Read') return `reading ${file(s('file_path'))}`
  if (tool === 'Grep' || tool === 'Glob') return `searching for ${s('pattern').slice(0, 40)}`
  if (tool === 'Agent') return `starting an agent: ${s('description')}`
  if (tool === 'AskUserQuestion') return 'asking you a question'
  if (tool.startsWith('mcp__')) return `using ${tool.split('__').slice(1).join(' ')}`
  return `using ${tool}`
}

// The model's JSON, tolerating a code fence around it; null without a goal.
export function parseRecap(text: string): SessionRecap | null {
  const body = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  try {
    const o = JSON.parse(body) as Record<string, unknown>
    const field = (k: string) => (typeof o[k] === 'string' ? short((o[k] as string).replace(/\s*—\s*/g, ', ').trim()) : '')
    if (!field('goal')) return null
    return { goal: field('goal'), now: field('now'), waiting: field('waiting'), next: field('next') }
  } catch {
    return null
  }
}

// One sentence of at most 70 characters, cut at a word: the model does not always keep to the limit.
export function short(text: string, max = 70) {
  const first = text.split(/(?<=[.!?])\s/)[0] ?? text
  if (first.length <= max) return first.replace(/\.$/, '')
  const cut = first.lastIndexOf(' ', max - 1)
  return `${first.slice(0, cut > 0 ? cut : max - 1)}…`
}

export function addPrompt(list: RecapEntry[], text: string): RecapEntry[] {
  const id = (list.at(-1)?.id ?? 0) + 1
  const entry: RecapEntry = {
    id,
    turnId: '',
    head: head(text),
    prompt: clip(text, MAX_PROMPT),
    followUps: [],
    answer: '',
    summary: '',
    waiting: '',
    durationMs: 0,
    isDone: false,
  }
  return [...list, entry].slice(-MAX_ENTRIES)
}

// To the entry of that turn. A turn with no entry (a notification's, which your message was delivered
// into) gets one, with the message as its prompt, so the turn's end finds it.
export function addFollowUp(list: RecapEntry[], turnId: string, text: string): RecapEntry[] {
  const i = findLastIndex(list, entry => entry.turnId === turnId)
  if (i < 0) return withTurn(addPrompt(list, text), turnId)
  return list.map((entry, k) => (k === i ? { ...entry, followUps: [...entry.followUps, clip(text, MAX_PROMPT)] } : entry))
}

// The newest prompt with no turn yet is the one this turn answers; a turn nobody typed for is left out.
// A turn with no text (a continuation) answers no prompt. A message typed over a turn that ended before
// taking it starts this one: it leaves that entry's follow-ups and becomes a prompt of its own.
export function startTurn(list: RecapEntry[], turnId: string, text: string): RecapEntry[] {
  const last = list.at(-1)
  if (!last) return list
  if (last.turnId === '' && !last.isDone) return text !== '' || last.prompt === '' ? withTurn(list, turnId) : list
  if (text === '') return list
  const i = findLastIndex(list, (entry, k) => k >= list.length - PROMOTE_WITHIN && entry.isDone && head(entry.followUps.at(-1) ?? '') === head(text))
  if (i < 0) return list
  const kept = list.map((entry, k) => (k === i ? { ...entry, followUps: entry.followUps.slice(0, -1) } : entry))
  return withTurn(addPrompt(kept, text), turnId)
}

// The newest entry, with that turn.
function withTurn(list: RecapEntry[], turnId: string): RecapEntry[] {
  const last = list.at(-1)
  return last ? [...list.slice(0, -1), { ...last, turnId }] : list
}

export function completeTurn(list: RecapEntry[], turnId: string, answer: string, durationMs: number): RecapEntry[] {
  return list.map(entry => (entry.turnId === turnId ? { ...entry, answer, durationMs, isDone: true } : entry))
}

// Only the first summary of a turn sticks.
export function attachRecap(list: RecapEntry[], turnId: string, now: string, waiting: string): RecapEntry[] {
  return list.map(entry => (entry.turnId === turnId && entry.isDone && entry.summary === '' ? { ...entry, summary: now, waiting } : entry))
}

// The reply's first line of words, without markdown's marks.
export function firstLine(answer: string) {
  const line = answer
    .split('\n')
    .map(l => l.replace(/^[\s>#*\-•|`]+/, '').trim())
    .find(l => l !== '')
  return clip(line ?? '', MAX_LINE)
}

export function head(text: string) {
  return fold(text).slice(0, HEAD)
}

export function clip(text: string, max: number) {
  const folded = fold(text)
  return folded.length <= max ? folded : `${folded.slice(0, max - 1)}…`
}

function fold(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

export function duration(ms: number) {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

function findLastIndex<T>(list: T[], test: (item: T, index: number) => boolean) {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i] as T, i)) return i
  return -1
}

// One row of the list: what it draws, and its text, to count the screen lines it wraps to.
type ListRow = { text: string; node: JSX.Element }

// Hangul, CJK, full-width forms and most emoji (⏳ 🔔 among them) take two cells; joiners and marks none.
const WIDE = /[ᄀ-ᅟ⌚⌛⏩-⏬⏰⏳◽◾☔☕⚡⚪⚫⚽⚾⛄⛅⛔⛪⛲⛳⛵⛺⛽✅✊✋✨❌❎❓-❕❗➕-➗➰➿⬛⬜⭐⭕⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u
const ZERO_WIDTH = /[̀-ͯ​-‍︀-️]/u

// The cells text takes on screen.
export function cells(text: string) {
  let n = 0
  for (const ch of text) n += ZERO_WIDTH.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1
  return n
}

// The screen lines text takes at `columns`, wrapped at its spaces as the terminal wraps it, a word too
// long for a line broken where the line ends.
export function lineCount(text: string, columns: number) {
  const width = Math.max(1, columns)
  let lines = 1
  let used = 0
  text.split(' ').forEach((word, i) => {
    const size = cells(word)
    const gap = i > 0 ? 1 : 0
    if (used > 0 && used + gap + size > width) {
      lines++
      used = size
    } else used += gap + size
    while (used > width) {
      lines++
      used -= width
    }
  })
  return lines
}

// The rows on screen from line `top`, `lines` being each row's screen lines: from the first row that starts
// there or after, as many as fill `rows` lines. Scrolled to the end, the last row ends the screen.
export function rowsFrom<T>(list: T[], lines: number[], top: number, rows: number): T[] {
  let i = 0
  for (let start = 0; i < list.length && start < top; i++) start += lines[i] ?? 1
  const out: T[] = []
  for (let used = 0; i < list.length && used < rows; i++) {
    out.push(list[i] as T)
    used += lines[i] ?? 1
  }
  return out
}

// The first line on screen after a scroll of `by` lines (positive is down): between the list's start and
// the place where its last line ends a screen of `visible` lines.
export function scrolledTop(top: number, by: number, total: number, visible: number): number {
  return Math.min(Math.max(top + by, 0), Math.max(0, total - Math.max(1, visible)))
}

// Where an agent's status stands: still at work, or not. A teammate `idle` between turns waits for a
// message, so it is not: its time stops and nothing redraws for it.
export function isRunning(status: string) {
  return status === 'pending' || status === 'running' || status === 'waiting'
}

export function statusMark(status: string): { icon: string; color?: string } {
  if (status === 'completed') return { icon: '✓', color: 'green' }
  if (status === 'failed') return { icon: '✗', color: 'red' }
  if (status === 'killed') return { icon: '■', color: 'gray' }
  if (status === 'idle' || status === 'waiting') return { icon: '◌', color: 'yellow' }
  return { icon: '⏳', color: 'yellow' }
}

// The model an agent runs on, by its family (fable, opus, sonnet, haiku), else its type.
export function modelLabel(task: AgentTask) {
  return /fable|opus|sonnet|haiku/i.exec(task.model)?.[0].toLowerCase() ?? task.type
}

// A started agent joins; one known already (resumed, or first seen in the engine's list) runs again, and
// what it lacked is filled in.
export function addAgent(list: AgentTask[], spawned: { id: string; description: string; type: string; model: string; startedAt: number }): AgentTask[] {
  if (!list.some(task => task.id === spawned.id)) return [...list, { ...spawned, status: 'running', endedAt: 0, tools: 0, last: '' }]
  return startAgent(list, spawned.id, spawned.startedAt).map(task =>
    task.id === spawned.id ? { ...task, model: task.model || spawned.model, description: task.description || spawned.description } : task,
  )
}

// A known agent that ended is at work again from `now`: its time counts from this run.
export function startAgent(list: AgentTask[], id: string, now: number): AgentTask[] {
  return list.map(task => (task.id === id && !isRunning(task.status) ? { ...task, status: 'running', startedAt: now, endedAt: 0 } : task))
}

export function endAgent(list: AgentTask[], id: string, status: string, endedAt: number): AgentTask[] {
  return list.map(task => (task.id === id ? { ...task, status, endedAt: task.endedAt || endedAt } : task))
}

// The records brought up to date: the engine's list says how each listed agent stands; one gone from it has
// ended; their activity is folded in. Only one at work joins (started before this mod loaded): a finished
// one Clear dropped stays out though the engine still lists it. One that ended stays ended though the list
// has yet to catch up: a new run comes by turn.start or agent.spawn.
export function mergeAgents(list: AgentTask[], listed: readonly AgentInfo[], activity: ReadonlyMap<string, { tools: number; last: string }>, now: number): AgentTask[] {
  const known = new Set(list.map(task => task.id))
  const joined = listed
    .filter(info => !known.has(info.id) && isRunning(info.status))
    .map(info => ({ id: info.id, description: info.description, type: info.type, model: '', status: info.status, startedAt: now, endedAt: 0, tools: 0, last: '' }))
  const merged = [...list, ...joined].map(task => {
    const info = listed.find(one => one.id === task.id)
    const hasEnded = !isRunning(task.status) && task.endedAt > 0
    const status = !info ? (isRunning(task.status) ? 'completed' : task.status) : hasEnded && isRunning(info.status) ? task.status : info.status
    const seen = activity.get(task.id)
    return {
      ...task,
      status,
      endedAt: isRunning(status) ? 0 : task.endedAt || now,
      tools: seen ? Math.max(task.tools, seen.tools) : task.tools,
      last: seen?.last ?? task.last,
    }
  })
  return trimAgents(merged)
}

// Every agent at work, and the latest MAX_ENDED to end: the rest are long past showing.
export function trimAgents(list: AgentTask[]): AgentTask[] {
  const ended = list.filter(task => !isRunning(task.status))
  if (ended.length <= MAX_ENDED) return list
  const kept = new Set(ended.sort((a, b) => b.endedAt - a.endedAt).slice(0, MAX_ENDED).map(task => task.id))
  return list.filter(task => isRunning(task.status) || kept.has(task.id))
}

// The agents the top shows: running ones first, newest first, then the latest to end; and how many more.
export function pickAgents(list: AgentTask[], most: number): { shown: AgentTask[]; more: number } {
  const running = list.filter(task => isRunning(task.status)).sort((a, b) => b.startedAt - a.startedAt)
  const ended = list.filter(task => !isRunning(task.status)).sort((a, b) => b.endedAt - a.endedAt)
  const all = [...running, ...ended]
  return { shown: all.slice(0, most), more: Math.max(0, all.length - most) }
}

// Each tick: the agents' status from the engine's list, and a redraw only while one runs (its time moves on).
// With no agent known it asks nothing (a new one arrives by agent.spawn), but once at the start.
async function refreshAgents($: EngineInterface, isFirst = false) {
  const before = await read($, agents)
  if (before.length === 0 && !isFirst) return
  const listed = await $.agent.list()
  const now = await $.clock.now()
  const next = mergeAgents(before, listed, rt.activity, now)
  const isChanged = JSON.stringify(next) !== JSON.stringify(before)
  if (isChanged) await update($, agents, () => next)
  if (isChanged || next.some(task => isRunning(task.status))) await update($, tick, n => n + 1)
}

// The list, kept in this plugin's store under the session it belongs to, for a resume: its latest
// SAVED_ENTRIES prompts and the recap on top. Only the latest SAVED_SESSIONS sessions are kept. An empty
// list writes nothing: after a /resume or /clear the list is empty until the next prompt, and the session
// it belonged to keeps its record (only Clear forgets it).
async function saveSession($: EngineInterface) {
  const id = rt.sessionId
  const list = await read($, entries)
  if (!id || list.length === 0) return
  // The oldest go before the new one is written, so the store never holds more than its share.
  const kept = keepSessions(await savedIndex($), id, await $.clock.now())
  for (const dropped of kept.dropped) await $.store.delete(sessionKey(dropped))
  await $.store.set(sessionKey(id), { entries: toSave(list), recap: await read($, recap) } satisfies SavedSession)
  await $.store.set(INDEX_KEY, kept.index)
}

// What is saved of a list: its latest prompts, each with its latest follow-ups.
export function toSave(list: RecapEntry[]): RecapEntry[] {
  return list.slice(-SAVED_ENTRIES).map(entry => ({ ...entry, followUps: entry.followUps.slice(-SAVED_FOLLOW_UPS) }))
}

// Clear: the session's record goes too.
async function forgetSession($: EngineInterface) {
  const id = rt.sessionId
  if (!id) return
  await $.store.delete(sessionKey(id))
  await $.store.set(INDEX_KEY, (await savedIndex($)).filter(one => one.id !== id))
}

// The session the list belongs to, from now on; and its saved list, when the pane holds none.
async function restoreSession($: EngineInterface, id: string) {
  rt.sessionId = id
  if ((await read($, entries)).length > 0) return // a hot reload: the list is still here
  const saved = (await $.store.get(sessionKey(id))) as SavedSession | undefined
  if (!saved?.entries?.length) return
  rt.top = 0
  await update($, entries, list => (list.length > 0 ? list : restored(saved.entries)))
  if (saved.recap) await update($, recap, now => now ?? saved.recap)
}

// At a prompt: another session than the list's is a /resume or a /clear; an empty list may be a /resume
// to this same session.
async function followSession($: EngineInterface) {
  const id = await $.session.id()
  if (id !== rt.sessionId || (await read($, entries)).length === 0) await restoreSession($, id)
}

async function savedIndex($: EngineInterface): Promise<SavedIndex> {
  const index = await $.store.get(INDEX_KEY)
  return Array.isArray(index) ? (index as SavedIndex) : []
}

function sessionKey(id: string) {
  return `session:${id}`
}

// The index with this session saved now, latest first, cut to SAVED_SESSIONS; and the ids cut off.
export function keepSessions(index: SavedIndex, id: string, savedAt: number): { index: SavedIndex; dropped: string[] } {
  const all = [{ id, savedAt }, ...index.filter(one => one.id !== id)]
  return { index: all.slice(0, SAVED_SESSIONS), dropped: all.slice(SAVED_SESSIONS).map(one => one.id) }
}

// A saved list as it comes back: a prompt still at work when the session left was cut off there. Their
// turns are over, so none is matched by a turn of this run.
export function restored(list: RecapEntry[]): RecapEntry[] {
  return list.map(entry => ({ ...entry, turnId: '', isDone: true, answer: entry.isDone ? entry.answer : entry.answer || '(interrupted)' }))
}

// A known agent that ended is at work again (resumed, or a teammate a message woke).
async function reviveAgent($: EngineInterface, agentId: string) {
  if (!(await read($, agents)).some(task => task.id === agentId && !isRunning(task.status))) return
  const now = await $.clock.now()
  await update($, agents, list => startAgent(list, agentId, now))
}

// Shows an agent's transcript in the main view, or the main conversation again with ''; says why not.
async function openView($: EngineInterface, agentId: string) {
  const r = await $.ui.view(agentId ? { agentId } : {}).catch((err: Error) => ({ deny: err.message }))
  if ('deny' in r && r.deny) $.ui.toast(`prompt-recap: cannot open that (${r.deny})`)
}
