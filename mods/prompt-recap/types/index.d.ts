// One prompt of yours and the turn it started.
export type RecapEntry = {
  id: number
  turnId: string // the model turn the prompt started; '' until it starts
  head: string // the prompt's first characters, whitespace folded: finds its transcript row
  prompt: string
  followUps: string[] // what you typed while that turn ran
  answer: string // the reply's first line: the summary until the model writes one, or with summaries off
  summary: string // the model's "now" for the turn
  waiting: string // the model's "waiting on you" for the turn
  durationMs: number
  isDone: boolean
}

// The session at a glance, as the model last wrote it after one of your turns.
export type SessionRecap = { goal: string; now: string; waiting: string; next: string }

// The longer recap asked for with the Full recap button or /prompt-recap recap.
export type FullRecap = { text: string; isLoading: boolean }

declare module 'claude-code' {
  interface PluginState {
    'prompt-recap': {
      entries: RecapEntry[]
      recap: SessionRecap | null
      live: string // what Claude is doing right now, from its tool calls
      full: FullRecap | null
    }
  }
}
