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

// A background agent of the session (a subagent, a review run in the background), as this mod keeps it:
// the engine drops a finished one from its list a while after it ends, this record stays.
export type AgentTask = {
  id: string
  description: string
  type: string // the agent type it was spawned as (general-purpose, Explore, ...)
  model: string // the model it runs on, as the spawn resolved it
  status: string // pending, running, waiting, idle, completed, failed, killed
  startedAt: number
  endedAt: number // 0 while it runs
  tools: number // tool calls it made
  last: string // what it did last
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-recap': {
      entries: RecapEntry[]
      recap: SessionRecap | null
      live: string // what Claude is doing right now, from its tool calls
      full: FullRecap | null
      agents: AgentTask[]
      isAgentsOpen: boolean
      tick: number // bumped to redraw: elapsed times, agent activity, the scrolled list
    }
  }
}
