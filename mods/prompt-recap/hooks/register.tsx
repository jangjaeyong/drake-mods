// Prompt Recap: your prompts, what you added mid-turn and how each turn ended, in a pane.
// Press a prompt to jump back to it in the transcript (the fullscreen view scrolls; the classic one cannot).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RecapEntry } from '../types'

const PANE = 'prompt-recap'
const TITLE = 'Prompt Recap'
const MAX_ENTRIES = 200
const MAX_PROMPT = 300
const MAX_LINE = 200
const HEAD = 80
const INLINE_ENTRIES = 3 // an inline pane sits above the prompt: keep it short

// Held by the host, so the list survives a hot reload of this file.
const entries = atom({ plugin: 'prompt-recap', key: 'entries' } as const, [] as RecapEntry[])
// where-am-i's recap, observed only: its "now" becomes the summary of the turn that just ended.
const recap = { plugin: 'where-am-i', key: 'recap' } as const

export const register: Register = on => {
  let lastTurnId = '' // the main turn that ended last: the one where-am-i is summarizing
  const rows = new Map<string, string>() // a prompt's head -> its transcript row, as last drawn

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'prompt-recap', description: 'Show your prompts and how each turn ended in a pane' }).catch(() => {}) // a name Claude Code already has is refused: start anyway
    return r
  })

  // /clear and /resume go on in this process under another session: its list starts empty.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') await update($, entries, () => []).catch(() => {})
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!isOwn(e)) return next(e)
    if (e.turnId) {
      // Typed while a turn ran: it belongs to that turn.
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
    if (!e.agentId) await update($, entries, list => startTurn(list, e.turnId))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      lastTurnId = e.turnId
      const answer = e.isAborted ? '(interrupted)' : firstLine(e.answer)
      await update($, entries, list => completeTurn(list, e.turnId, answer, e.durationMs))
    }
    return r
  })

  // Observe only: where-am-i's write goes through untouched, whatever happens here.
  on('state.set', recap, async ($, e, next) => {
    const r = await next(e)
    const value = e.value
    if (r.value?.isSet && value && lastTurnId) {
      const turnId = lastTurnId
      void update($, entries, list => attachRecap(list, turnId, value.now, value.waiting)).catch(() => {})
    }
    return r
  }).catch(($, e, next) => next(e)) // nor where-am-i's write

  // Observe only: note which transcript row holds each prompt, so a press can scroll to it.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    if (e.props.origin.kind === 'composer' && e.props.text) rows.set(head(e.props.text), e.requestId)
    return next(e)
  })

  on('command.run', { command: 'prompt-recap' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Prompt Recap opened' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, entries)
    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No prompts yet. Ask something and it shows up here.</Text>
        </Box>
      )
    }

    const shown = e.props.placement === 'inline' ? list.slice(-INLINE_ENTRIES) : list
    return (
      <Box flexDirection="column" gap={1}>
        {[...shown].reverse().map(entry => (
          <Box key={`entry:${entry.id}`} flexDirection="column">
            <Button key={`jump:${entry.id}`} plain onPress={() => void jump($, rows.get(entry.head))}>
              <Text color="cyan" bold>{`#${entry.id} `}</Text>
              {entry.prompt}
            </Button>
            {entry.followUps.map(text => (
              <Text wrap="wrap">
                <Text dimColor>{'  + '}</Text>
                {text}
              </Text>
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

// Scrolls the transcript to a prompt's row; says why when it cannot.
async function jump($: EngineInterface, requestId: string | undefined) {
  if (!requestId) {
    $.ui.toast('prompt-recap: that prompt is not on screen to jump to')
    return
  }
  const r = await $.ui.scroll({ to: { requestId }, block: 'start' })
  if (r.deny) $.ui.toast(`prompt-recap: cannot jump there (${r.deny}). The fullscreen view ("tui": "fullscreen") scrolls.`)
}

// The person's own prompts: typed or sent from a phone, not a slash command, a notification or a plugin's.
function isOwn(e: { command?: unknown; isMeta?: true; origin: { kind: string } }) {
  return !e.command && !e.isMeta && (e.origin.kind === 'composer' || e.origin.kind === 'bridge')
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

// To the entry of that turn, else the newest; a new entry when there is none.
export function addFollowUp(list: RecapEntry[], turnId: string, text: string): RecapEntry[] {
  let i = findLastIndex(list, entry => entry.turnId === turnId)
  if (i < 0) i = list.length - 1
  if (i < 0) return addPrompt(list, text)
  return list.map((entry, k) => (k === i ? { ...entry, followUps: [...entry.followUps, clip(text, MAX_PROMPT)] } : entry))
}

// The newest prompt with no turn yet is the one this turn answers; a turn nobody typed for is left out.
export function startTurn(list: RecapEntry[], turnId: string): RecapEntry[] {
  const last = list.at(-1)
  if (!last || last.turnId !== '' || last.isDone) return list
  return [...list.slice(0, -1), { ...last, turnId }]
}

export function completeTurn(list: RecapEntry[], turnId: string, answer: string, durationMs: number): RecapEntry[] {
  return list.map(entry => (entry.turnId === turnId ? { ...entry, answer, durationMs, isDone: true } : entry))
}

// Only the first recap after the turn: a later one (a turn nobody typed for) leaves it be.
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

function findLastIndex<T>(list: T[], test: (item: T) => boolean) {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i] as T)) return i
  return -1
}
