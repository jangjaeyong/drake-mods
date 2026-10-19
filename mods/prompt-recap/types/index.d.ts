// One prompt of yours and the turn it started.
export type RecapEntry = {
  id: number
  turnId: string // the model turn the prompt started; '' until it starts
  head: string // the prompt's first characters, whitespace folded: finds its transcript row
  prompt: string
  followUps: string[] // what you typed while that turn ran
  answer: string // the reply's first line: the summary until where-am-i has one
  summary: string // where-am-i's "now" for the turn
  waiting: string // where-am-i's "waiting on you"
  durationMs: number
  isDone: boolean
}

export type WhereAmIRecap = { goal: string; now: string; waiting: string; next: string }

declare module 'claude-code' {
  interface PluginState {
    'prompt-recap': { entries: RecapEntry[] }
    // Owned by the where-am-i mod, read here. Kept the same as its own contract.
    'where-am-i': { recap: WhereAmIRecap | null; live: string }
  }
}
