// Prompt Recap: your prompts, what you added mid-turn and how each turn ended, with the session at a
// glance on top (goal, now, waiting on you, next), in a pane. Press a prompt to jump back to it in the
// transcript (the fullscreen view scrolls; the classic one cannot). Summaries can be turned off.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FullRecap, RecapEntry, SessionRecap } from '../types'

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
const INLINE_ENTRIES = 3 // an inline pane sits above the prompt: keep it short

// Held by the host, so they survive a hot reload of this file and a change of the option.
const entries = atom({ plugin: 'prompt-recap', key: 'entries' } as const, [] as RecapEntry[])
const recap = atom({ plugin: 'prompt-recap', key: 'recap' } as const, null as SessionRecap | null)
const live = atom({ plugin: 'prompt-recap', key: 'live' } as const, '')
const full = atom({ plugin: 'prompt-recap', key: 'full' } as const, null as FullRecap | null)

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
    return r
  })

  // /clear and /resume go on in this process under another session: it starts empty.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') await clearAll($).catch(() => {})
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!isOwn(e)) return next(e)
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
      if (list.some(entry => entry.turnId === e.turnId)) await update($, live, () => 'reading your message')
    }
    return next(e)
  })

  // Observe only: note what is happening, then let the call run untouched. Only Claude's own calls
  // count: one another mod makes in the background names that plugin as its origin, not the engine.
  on('tool.call', async ($, e, next) => {
    if (next.origin.plugin !== 'engine') return next(e)
    const line = describe(e as unknown as Record<string, unknown>)
    log = [...log, e.agentId ? `(agent) ${line}` : line].slice(-MAX_LOG)
    if (!e.agentId) await update($, live, () => line)
    return next(e)
  }).catch(($, e, next) => next(e)) // nor a tool call

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    await update($, live, () => '')
    const answer = e.isAborted ? '(interrupted)' : e.reason === 'error' ? '(error)' : e.reason === 'refusal' ? '(refused)' : firstLine(e.answer)
    const list = await update($, entries, all => completeTurn(all, e.turnId, answer, e.durationMs))
    const entry = list.find(one => one.turnId === e.turnId)
    if (!entry) return r // a turn nobody typed for (a notification's) is not "the last one" either
    lastTurnId = e.turnId
    // Only answered turns you typed for are summarized, in the background, so the turn ends at once.
    if (isSummaryOn && e.reason === 'answer' && e.answer !== '') {
      void summarize($, entry, log, e.answer, turnId => turnId === lastTurnId).catch(() => {})
    }
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
      await clearAll($)
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
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, entries)
    const now = await read($, live)
    const glance = isSummaryOn ? await read($, recap) : null
    const longer = await read($, full)
    const isInline = e.props.placement === 'inline'
    const shown = isInline ? list.slice(-INLINE_ENTRIES) : list
    const nowText = now || glance?.now || ''

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {glance && glance.goal !== '' && (
            <Text wrap="wrap">
              <Text color="cyan" bold>{'◆ Goal: '}</Text>
              {glance.goal}
            </Text>
          )}
          {nowText !== '' && (
            <Text wrap="wrap">
              <Text dimColor>{'  now: '}</Text>
              {nowText}
            </Text>
          )}
          {glance && glance.next !== '' && (
            <Text wrap="wrap">
              <Text dimColor>{'  next: '}</Text>
              {glance.next}
            </Text>
          )}
          {glance && glance.waiting !== '' && <Text color="yellow" wrap="wrap">{`  waiting on you: ${glance.waiting}`}</Text>}
          <Box flexDirection="row" gap={1}>
            {!isInline && <Button key="full" label="Full recap" hotkey="r" dimColor onPress={() => void fullRecap($).catch(() => {})} />}
            <Button key="summary" label={`Summary: ${isSummaryOn ? 'on' : 'off'}`} hotkey="s" dimColor onPress={() => void toggleSummary($, !isSummaryOn)} />
            {/* No hotkey: a letter typed while the pane holds the keys must not wipe the list. */}
            <Button key="clear" label="Clear" dimColor onPress={() => void clearAll($)} />
          </Box>
        </Box>

        {longer && (
          <Box flexDirection="column">
            <Text bold>Full recap</Text>
            {longer.isLoading ? (
              <Text dimColor>writing…</Text>
            ) : (
              longer.text
                .split('\n')
                .filter(line => line.trim() !== '')
                .map(line => <Text wrap="wrap">{line}</Text>)
            )}
            <Button key="hide" label="Hide" hotkey="h" dimColor onPress={() => void update($, full, () => null)} />
          </Box>
        )}

        {list.length === 0 && <Text dimColor>No prompts yet. Ask something and it shows up here.</Text>}
        {[...shown].reverse().map(entry => (
          <Box key={`entry:${entry.id}`} flexDirection="column">
            <Button key={`jump:${entry.id}`} plain onPress={() => void jump($, findRow(rows, entry.head))}>
              <Text color="cyan" bold>{`#${entry.id} `}</Text>
              {entry.prompt}
            </Button>
            {entry.followUps.map((text, i) => (
              <Button key={`jump:${entry.id}:${i + 1}`} plain onPress={() => void jump($, findRow(rows, head(text)))}>
                <Text dimColor>{'  + '}</Text>
                {text}
              </Button>
            ))}
            {entry.isDone ? (
              <Text wrap="wrap">
                <Text color="green">{`  → ${entry.summary || entry.answer || '(no reply)'}`}</Text>
                {entry.durationMs > 0 && <Text dimColor>{`  · ${duration(entry.durationMs)}`}</Text>}
              </Text>
            ) : (
              <Text dimColor>{'  … working'}</Text>
            )}
            {entry.waiting !== '' && <Text color="yellow" wrap="wrap">{`  ⏳ ${entry.waiting}`}</Text>}
          </Box>
        ))}
      </Box>
    )
  })
}

// The model reads a turn and writes its summary and the session's recap. `isLatest` says whether the
// turn is still the last one to end: an older turn's late answer leaves the newer recap on top.
async function summarize($: EngineInterface, entry: RecapEntry, tools: string[], answer: string, isLatest: (turnId: string) => boolean) {
  const before = await read($, recap)
  const r = await $.model.complete({
    model: MODEL,
    maxTokens: 600, // four fields of Korean take more tokens than of English
    system:
      'You keep a one-glance recap of a coding session. Plain words, no em dashes, each field at most 70 ' +
      'characters, written in the language the person writes in. Reply with JSON only, no code fence: {"goal","now","waiting","next"}. ' +
      '"goal": what the person is working toward now, judged from their latest messages (keep the previous goal ' +
      'while they stay on it, and replace it once they move on to another task or a new stage of it). ' +
      '"now": what this turn did, as its result. "waiting": what the assistant is waiting on from the person, or "". ' +
      '"next": the next step.',
    prompt: [
      `Previous recap: ${before ? JSON.stringify(before) : 'none'}`,
      `The person's message: ${entry.prompt}`,
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
}

// The longer recap: the last messages of the conversation in a few bullets, shown in the pane.
async function fullRecap($: EngineInterface) {
  if ((await read($, full))?.isLoading) return
  await update($, full, () => ({ text: '', isLoading: true }))
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
    await update($, full, () => ({ text: r.isAnswered ? r.text.trim() : 'Could not build a recap right now.', isLoading: false }))
  } catch {
    await update($, full, () => ({ text: 'Could not build a recap right now.', isLoading: false }))
  }
}

// Empties the pane: the list, the recap on top, what is happening now and the full recap.
async function clearAll($: EngineInterface) {
  await Promise.all([update($, entries, () => []), update($, recap, () => null), update($, live, () => ''), update($, full, () => null)])
}

// Writes the option as the /config menu would; the module then reloads with it. Answers why it did not.
// Turning summaries off drops the recap on top first (the write reloads this module), so turning them
// on again shows no stale one.
async function setSummary($: EngineInterface, isOn: boolean): Promise<string | undefined> {
  try {
    if (!isOn) await update($, recap, () => null)
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
