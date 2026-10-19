import { describe, expect, mock, test } from 'claude-code/testing'

import type { Mounted } from 'claude-code/testing'
import { addAgent, addFollowUp, addPrompt, attachRecap, cells, clip, completeTurn, describe as label, endAgent, findRow, firstLine, isRunning, keepSessions, lineCount, mergeAgents, modelLabel, parseRecap, pickAgents, restored, rowsFrom, scrolledTop, short, startAgent, startTurn, statusMark, toSave, trimAgents } from '../hooks/register'
import { thumb, topAt } from '../hooks/scrollbar'

const PANE = { component: 'Pane', requestId: 'prompt-recap', props: { title: 'Prompt Recap', isFocused: false, bodyColumns: 80, placement: 'dock' } }
const typed = { kind: 'composer' } as const
const off = { options: { summary: 'off' } }

// Lets work a hook left running in the background (the summary) finish.
declare const setTimeout: (run: () => void, ms: number) => unknown // the test runner has it; a hooks module does not
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 20))
const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// The engine's answers beneath the mod, for a session with one turn of yours.
function engine(on: any) {
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return mock.clock(on, { now: 1_000 }) // the agents' tick and their elapsed times
}

describe('the list', () => {
  test('a prompt, a follow-up, the end of its turn and then its summary', async () => {
    let list = addPrompt([], 'rename the user table')
    list = startTurn(list, 't1', 'rename the user table')
    list = addFollowUp(list, 't1', 'keep the old name as a view')
    list = completeTurn(list, 't1', 'Renamed it.', 12_000)
    expect(list[0]).toMatchObject({ id: 1, turnId: 't1', followUps: ['keep the old name as a view'], answer: 'Renamed it.', isDone: true })

    list = attachRecap(list, 't1', 'renamed users to members', 'review the migration')
    expect(list[0]).toMatchObject({ summary: 'renamed users to members', waiting: 'review the migration' })
    list = attachRecap(list, 't1', 'something else', '')
    expect(list[0]!.summary).toBe('renamed users to members')
  })

  test('a turn nobody typed for takes no entry', async () => {
    let list = completeTurn(startTurn(addPrompt([], 'first'), 't1', 'first'), 't1', 'done', 1)
    list = startTurn(list, 't2', 'A background task finished') // a notification's turn
    list = completeTurn(list, 't2', 'task finished', 1)
    expect(list).toHaveLength(1)
    expect(list[0]!.answer).toBe('done')
  })

  test('a turn with no text (a continuation) does not take a waiting prompt', async () => {
    const waiting = addPrompt(completeTurn(startTurn(addPrompt([], 'first'), 't1', 'first'), 't1', 'done', 1), 'second, queued')
    expect(startTurn(waiting, 't2', '').at(-1)!.turnId).toBe('')
    expect(startTurn(waiting, 't3', 'second, queued').at(-1)!.turnId).toBe('t3')
  })

  test('a message typed as the last turn ended starts the next turn as a prompt of its own', async () => {
    let list = startTurn(addPrompt([], 'add a login page'), 't1', 'add a login page')
    list = addFollowUp(list, 't1', 'add tests too')
    list = completeTurn(list, 't1', 'Added it.', 1)
    list = startTurn(list, 't2', 'add tests too')
    expect(list.map(entry => [entry.prompt, entry.turnId, entry.followUps])).toEqual([
      ['add a login page', 't1', []],
      ['add tests too', 't2', []],
    ])
  })

  test('a message delivered into a turn nobody typed for gets an entry of its own for that turn', async () => {
    const list = addFollowUp(completeTurn(startTurn(addPrompt([], 'first'), 't1', 'first'), 't1', 'done', 1), 'n1', 'what failed?')
    expect(list.at(-1)).toMatchObject({ prompt: 'what failed?', turnId: 'n1', followUps: [] })
    expect(list[0]!.followUps).toEqual([])
  })

  test('finds a prompt row by its head, loosely when the texts part ways', async () => {
    const rows = new Map([['fix the login bug on the settings page', 'm1'], ['[Pasted text #1]', 'm2']])
    expect(findRow(rows, 'fix the login bug on the settings page')).toBe('m1')
    expect(findRow(rows, 'fix the login bug on the')).toBe('m1')
    expect(findRow(rows, 'nothing like it at all, really')).toBeUndefined()
    expect(findRow(rows, '')).toBeUndefined()
  })

  test('a short head never jumps loosely, and of several loose matches the last drawn wins', async () => {
    expect(findRow(new Map([['ok, go ahead with the migration', 'm1']]), 'ok')).toBeUndefined()
    expect(findRow(new Map([['o', 'm1']]), 'ok, go ahead with the migration')).toBeUndefined()
    const rows = new Map([['update the readme with install steps', 'old'], ['update the readme with install steps and a gif', 'new']])
    expect(findRow(rows, 'update the readme with install')).toBe('new')
  })

  test('a real new prompt with the same words as an earlier follow-up is not mistaken for it', async () => {
    let list = startTurn(addPrompt([], 'migrate the table'), 't1', 'migrate the table')
    list = completeTurn(addFollowUp(list, 't1', 'ok'), 't1', 'done', 1)
    list = startTurn(addPrompt(list, 'ok'), 't2', 'ok')
    expect(list.map(entry => [entry.prompt, entry.turnId, entry.followUps])).toEqual([
      ['migrate the table', 't1', ['ok']],
      ['ok', 't2', []],
    ])
  })

  test('a message typed over a turn is found again after a queued prompt took the next turn', async () => {
    let list = startTurn(addPrompt([], 'first'), 't1', 'first')
    list = addPrompt(list, 'queued question') // ctrl+x enter: its own entry, waiting
    list = addFollowUp(list, 't1', 'and one more thing') // a plain Enter over t1
    list = completeTurn(list, 't1', 'done', 1)
    list = completeTurn(startTurn(list, 't2', 'queued question'), 't2', 'answered', 1)
    list = startTurn(list, 't3', 'and one more thing') // t1 ended before taking it
    expect(list.map(entry => [entry.prompt, entry.turnId, entry.followUps])).toEqual([
      ['first', 't1', []],
      ['queued question', 't2', []],
      ['and one more thing', 't3', []],
    ])
  })

  test('clips long prompts and takes the first line of words from a reply', async () => {
    expect(clip('a   b\n\nc', 10)).toBe('a b c')
    expect(clip('x'.repeat(20), 10)).toBe(`${'x'.repeat(9)}…`)
    expect(firstLine('\n## Done\n\nmore')).toBe('Done')
    expect(firstLine('| a | b |')).toBe('a | b |')
  })

  test('reads the model JSON inside a code fence and keeps each field short', async () => {
    expect(parseRecap('```json\n{"goal":"ship login","now":"added the form","waiting":"","next":"tests"}\n```')).toEqual({
      goal: 'ship login',
      now: 'added the form',
      waiting: '',
      next: 'tests',
    })
    expect(parseRecap('{"now":"no goal"}')).toBeNull()
    expect(parseRecap('not json')).toBeNull()
    expect(short(`${'word '.repeat(30)}end`)).toBe(`${'word '.repeat(13)}word…`)
    expect(short('첫 문장입니다. 두 번째 문장')).toBe('첫 문장입니다')
  })

  test('names a tool call by what it does, whatever the path separator', async () => {
    expect(label({ tool: 'Edit', file_path: 'C:\\work\\app\\src\\main.ts' })).toBe('editing src/main.ts')
    expect(label({ tool: 'Read', file_path: '/home/me/app/README.md' })).toBe('reading app/README.md')
    expect(label({ tool: 'Bash', command: 'npm test', description: 'Run tests' })).toBe('running Run tests')
    expect(label({ tool: 'PowerShell', command: 'Get-ChildItem' })).toBe('running Get-ChildItem')
    expect(label({ tool: 'mcp__github__search' })).toBe('using github search')
  })
})

describe('prompt-recap', () => {
  test('records your prompt, what you added mid-turn and how the turn ended, newest first', off, async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

    await $.prompt.submit({ text: 'add a login page', origin: typed, wait: false } as any)
    await $.turn.start({ text: 'add a login page', turnId: 't1' } as any)
    await $.prompt.submit({ text: 'use the existing form styles', origin: typed, wait: false, turnId: 't1' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'Added the login page.\n\nDetails...', durationMs: 83_000, isAborted: false, turnId: 't1' } as any)

    await $.prompt.submit({ text: '/reload-plugins', origin: typed, wait: false, command: { name: 'reload-plugins' } } as any)
    await $.prompt.submit({ text: 'now the logout button', origin: typed, wait: false } as any)
    await $.turn.start({ text: 'now the logout button', turnId: 't2' } as any)

    expect((await $.command.run({ command: 'prompt-recap', args: '' } as any)).text).toBe('Prompt Recap opened')

    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: '#1 ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '#2 ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '#3 ' })).toBeUndefined() // the slash command is not a prompt
    expect(await ui.find({ type: 'Button', key: 'jump:1:1', text: /use the existing form styles/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✓ Added the login page\.$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1m 23s/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /working…/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'summary', text: 'Summary: off' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'full' })).toBeDefined() // asked for, so it runs with summaries off too
    expect(await ui.find({ type: 'Button', key: 'clear' })).toBeDefined()
    await ui.unmount()
  })

  test('a prompt asked to wait its turn is a prompt of its own, not a follow-up', off, async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.prompt.submit({ text: 'first question', origin: typed, wait: false } as any)
    await $.turn.start({ text: 'first question', turnId: 't1' } as any)
    await $.prompt.submit({ text: 'second question, queued', origin: typed, wait: true, turnId: 't1' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'one', durationMs: 1, isAborted: false, turnId: 't1' } as any)

    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: '#2 ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ {2}↳ / })).toBeUndefined()
    await ui.unmount()
  })

  test('with summaries on, the model writes the turn summary and the recap on top', async ($, on) => {
    engine(on)
    const asked: string[] = []
    on('model.complete', (_$: any, e: any) => {
      asked.push(e.prompt)
      return { value: { isAnswered: true, text: '{"goal":"로그인 기능 완성","now":"로그인 페이지 추가","waiting":"화면 확인","next":"로그아웃 버튼"}', usage } }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.prompt.submit({ text: '로그인 페이지 추가해줘', origin: typed, wait: false } as any)
    await $.turn.start({ text: '로그인 페이지 추가해줘', turnId: 't1' } as any)
    await $.turn.complete({ reason: 'answer', answer: '추가했습니다.', durationMs: 5_000, isAborted: false, turnId: 't1' } as any)
    await settle()

    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('로그인 페이지 추가해줘')
    expect(asked[0]).toContain("The person's recent messages, oldest first:\n- 로그인 페이지 추가해줘")
    expect(asked[0]).toContain('Previous goal: none')
    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /🎯 Goal: 로그인 기능 완성/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /next: 로그아웃 버튼/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /waiting on you: 화면 확인/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✓ 로그인 페이지 추가$/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'summary', text: 'Summary: on' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'full' })).toBeDefined()
    await ui.unmount()
  })

  test('with summaries off, turns cost no model call; a full recap asked for costs one', off, async ($, on) => {
    engine(on)
    let calls = 0
    on('model.complete', () => (calls++, { value: { isAnswered: true, text: '- the goal\n- what is done', usage } }))
    on('session.messages', () => ({ value: [{ role: 'user', text: 'hello', toolUses: [] }] }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.prompt.submit({ text: 'hello', origin: typed, wait: false } as any)
    await $.turn.start({ text: 'hello', turnId: 't1' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'hi', durationMs: 1, isAborted: false, turnId: 't1' } as any)
    await settle()
    expect(calls).toBe(0)

    expect((await $.command.run({ command: 'prompt-recap', args: 'recap' } as any)).text).toBe('Writing a full recap in the Prompt Recap pane')
    await settle()
    expect(calls).toBe(1)
    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: '- what is done' })).toBeDefined()
    await ui.press({ key: 'hide' })
    expect(await ui.find({ type: 'Text', text: '- what is done' })).toBeUndefined()
    await ui.unmount()
  })

  test('Clear and /prompt-recap clear empty the pane', async ($, on) => {
    engine(on)
    on('model.complete', () => ({ value: { isAnswered: true, text: '{"goal":"ship login","now":"added it","waiting":"","next":"tests"}', usage } }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    const ask = async (text: string, turnId: string) => {
      await $.prompt.submit({ text, origin: typed, wait: false } as any)
      await $.turn.start({ text, turnId } as any)
      await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId } as any)
      await settle()
    }
    await ask('add a login page', 't1')

    let ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /🎯 Goal: ship login/ })).toBeDefined()
    await ui.press({ key: 'clear' })
    expect(await ui.find({ type: 'Text', text: /No prompts yet/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /🎯 Goal/ })).toBeUndefined()
    await ui.unmount()

    await ask('add a logout button', 't2')
    ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: '#1 ' })).toBeDefined() // numbering starts over
    expect(await ui.find({ type: 'Text', text: '#2 ' })).toBeUndefined()
    await ui.unmount()
    expect((await $.command.run({ command: 'prompt-recap', args: 'clear' } as any)).text).toBe('Prompt Recap cleared')
    ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /No prompts yet/ })).toBeDefined()
    await ui.unmount()
  })

  test('a summary still on its way when you Clear does not bring the recap back', async ($, on) => {
    engine(on)
    let release = () => {}
    const gate = new Promise<void>(resolve => (release = resolve))
    on('model.complete', async () => {
      await gate
      return { value: { isAnswered: true, text: '{"goal":"back from the dead","now":"x","waiting":"","next":"y"}', usage } }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.prompt.submit({ text: 'first', origin: typed, wait: false } as any)
    await $.turn.start({ text: 'first', turnId: 't1' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't1' } as any)
    await $.command.run({ command: 'prompt-recap', args: 'clear' } as any)
    release()
    await settle()

    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /🎯 Goal/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /No prompts yet/ })).toBeDefined()
    await ui.unmount()
  })

  test('a full recap still on its way when you Clear or Hide stays gone', async ($, on) => {
    engine(on)
    let release = () => {}
    let gate = new Promise<void>(resolve => (release = resolve))
    on('model.complete', async () => {
      await gate
      return { value: { isAnswered: true, text: '- should not show', usage } }
    })
    on('session.messages', () => ({ value: [] }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

    await $.command.run({ command: 'prompt-recap', args: 'recap' } as any)
    await $.command.run({ command: 'prompt-recap', args: 'clear' } as any)
    release()
    await settle()
    let ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: '- should not show' })).toBeUndefined()
    await ui.unmount()

    gate = new Promise<void>(resolve => (release = resolve))
    await $.command.run({ command: 'prompt-recap', args: 'recap' } as any)
    ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: 'writing…' })).toBeDefined()
    await ui.press({ key: 'hide' })
    release()
    await settle()
    expect(await ui.find({ type: 'Text', text: '- should not show' })).toBeUndefined()
    await ui.unmount()
  })

  test('a refused option write leaves the recap on top as it was', async ($, on) => {
    engine(on)
    on('model.complete', () => ({ value: { isAnswered: true, text: '{"goal":"keep me","now":"x","waiting":"","next":"y"}', usage } }))
    on('config.set', () => ({ deny: 'a managed setting owns it' }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.prompt.submit({ text: 'first', origin: typed, wait: false } as any)
    await $.turn.start({ text: 'first', turnId: 't1' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't1' } as any)
    await settle()

    expect((await $.command.run({ command: 'prompt-recap', args: 'summary off' } as any)).text).toBe('Summaries not changed: a managed setting owns it')
    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /🎯 Goal: keep me/ })).toBeDefined()
    await ui.unmount()
  })

  test('/prompt-recap summary off writes the option', async ($, on) => {
    engine(on)
    const writes: unknown[] = []
    on('config.set', (_$: any, e: any) => (writes.push({ key: e.key, value: e.value }), { value: e.value }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    expect((await $.command.run({ command: 'prompt-recap', args: 'summary off' } as any)).text).toBe('Summaries off')
    expect(writes).toEqual([{ key: 'prompt-recap.summary', value: 'off' }])
  })

  test('a message typed as the turn ended shows as its own prompt with its own result', off, async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.prompt.submit({ text: 'add a login page', origin: typed, wait: false } as any)
    await $.turn.start({ text: 'add a login page', turnId: 't1' } as any)
    await $.prompt.submit({ text: 'add tests too', origin: typed, wait: false, turnId: 't1' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'Added the page.', durationMs: 1, isAborted: false, turnId: 't1' } as any)
    await $.turn.start({ text: 'add tests too', turnId: 't2' } as any) // the engine's queue started a turn for it
    await $.turn.complete({ reason: 'answer', answer: 'Added the tests.', durationMs: 1, isAborted: false, turnId: 't2' } as any)

    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: '#2 ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✓ Added the tests\.$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ {2}↳ / })).toBeUndefined()
    await ui.unmount()
  })

  test('a late summary still updates the top when a turn nobody typed for ended meanwhile', async ($, on) => {
    engine(on)
    let release = () => {}
    const gate = new Promise<void>(resolve => (release = resolve))
    on('model.complete', async () => {
      await gate
      return { value: { isAnswered: true, text: '{"goal":"ship login","now":"added the page","waiting":"","next":"tests"}', usage } }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.prompt.submit({ text: 'add a login page', origin: typed, wait: false } as any)
    await $.turn.start({ text: 'add a login page', turnId: 't1' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'Added it.', durationMs: 1, isAborted: false, turnId: 't1' } as any)
    await $.turn.start({ text: 'A background task finished', turnId: 'n1' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'Noted.', durationMs: 1, isAborted: false, turnId: 'n1' } as any)
    release()
    await settle()

    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /🎯 Goal: ship login/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✓ added the page$/ })).toBeDefined()
    await ui.unmount()
  })

  test('turns that end in an error, a refusal or an interrupt cost no model call', async ($, on) => {
    engine(on)
    let calls = 0
    on('model.complete', () => (calls++, { value: { isAnswered: true, text: '{}', usage } }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    const ends = [
      { reason: 'error', answer: '', isAborted: false },
      { reason: 'refusal', answer: '', isAborted: false, refusal: {} },
      { reason: 'aborted', answer: 'half', isAborted: true },
    ]
    for (const [i, end] of ends.entries()) {
      await $.prompt.submit({ text: `question ${i}`, origin: typed, wait: false } as any)
      await $.turn.start({ text: `question ${i}`, turnId: `t${i}` } as any)
      await $.turn.complete({ ...end, durationMs: 1, turnId: `t${i}` } as any)
    }
    await settle()
    expect(calls).toBe(0)

    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /✓ \(error\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✓ \(refused\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✓ \(interrupted\)$/ })).toBeDefined()
    await ui.unmount()
  })

  test('a dropped prompt leaves no entry, and /clear empties the list', off, async ($, on) => {
    on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
    on('prompt.submit', (_$: any, e: any) => (e.text === 'blocked' ? { drop: 'a settings hook said no' } : { text: e.text }))
    on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
    on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
    on('command.register', () => ({ value: undefined }) as any)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

    await $.prompt.submit({ text: 'blocked', origin: typed, wait: false } as any)
    let ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /No prompts yet/ })).toBeDefined()
    await ui.unmount()

    await $.prompt.submit({ text: 'kept', origin: typed, wait: false } as any)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as any)
    ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /No prompts yet/ })).toBeDefined()
    await ui.unmount()
  })

  // The scroll itself is the engine's (a transcript row is no site of the plugin's, so the kit does not
  // raise it to a test's hooks): this checks the mod's half, that a press finds the row it was drawn in.
  test('pressing a prompt finds the transcript row it was drawn in, and says so when it was never drawn', off, async ($, on) => {
    engine(on)
    const toasts: string[] = []
    on('ui.toast', (_$: any, e: any) => (toasts.push(e.text), { value: undefined }))
    on('ui.render', { component: 'UserMessage' }, (_$: any, e: any) => ({ type: 'Text', props: {}, children: [e.props.text] })) // the engine's own drawing of the row
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.prompt.submit({ text: 'add a login page', origin: typed, wait: false } as any)
    await $.prompt.submit({ text: 'never drawn', origin: typed, wait: false } as any)

    const row = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', component: 'UserMessage', requestId: 'msg-1', props: { text: 'add a login page', origin: typed, isExpanded: false } } as any)
    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    await ui.press({ key: 'jump:1' })
    expect(toasts.some(text => text.includes('not on screen'))).toBe(false)
    await ui.press({ key: 'jump:2' })
    expect(toasts.at(-1)).toBe('prompt-recap: that prompt is not on screen to jump to')
    await ui.unmount()
    await row.unmount()
  })

  test('pressing a message added mid-turn finds its own transcript row', off, async ($, on) => {
    engine(on)
    const toasts: string[] = []
    on('ui.toast', (_$: any, e: any) => (toasts.push(e.text), { value: undefined }))
    on('ui.render', { component: 'UserMessage' }, (_$: any, e: any) => ({ type: 'Text', props: {}, children: [e.props.text] }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.prompt.submit({ text: 'add a login page', origin: typed, wait: false } as any)
    await $.turn.start({ text: 'add a login page', turnId: 't1' } as any)
    await $.prompt.submit({ text: 'use the existing form styles', origin: typed, wait: false, turnId: 't1' } as any)
    await $.prompt.submit({ text: 'and a remember-me box', origin: typed, wait: false, turnId: 't1' } as any)

    const row = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', component: 'UserMessage', requestId: 'msg-2', props: { text: 'use the existing form styles', origin: typed, isExpanded: false } } as any)
    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    await ui.press({ key: 'jump:1:1' })
    expect(toasts.some(text => text.includes('not on screen'))).toBe(false)
    await ui.press({ key: 'jump:1:2' }) // its row was never drawn
    expect(toasts.at(-1)).toBe('prompt-recap: that prompt is not on screen to jump to')
    await ui.unmount()
    await row.unmount()
  })

  test('an empty pane says how it fills', off, async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /No prompts yet/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('the agents and the scrolled list', () => {
  const task = (over: Record<string, unknown>) => ({ id: 'a1', description: 'review', type: 'general-purpose', model: '', status: 'running', startedAt: 0, endedAt: 0, tools: 0, last: '', ...over }) as any

  test('counts Hangul, CJK and emoji two cells wide, and the lines a text wraps to at its spaces', async () => {
    expect(cells('abc')).toBe(3)
    expect(cells('로그인 화면')).toBe(11) // 5 syllables and a space
    expect(cells('⏳ working…')).toBe(11)
    expect(cells('🔔 확인')).toBe(7)
    expect(lineCount('', 10)).toBe(1)
    expect(lineCount('a'.repeat(10), 10)).toBe(1)
    expect(lineCount('aaaa bbbb cccc', 10)).toBe(2) // the third word moves down whole
    expect(lineCount('a'.repeat(25), 10)).toBe(3) // a word longer than a line breaks where it ends
    expect(lineCount('로그인 페이지 상단 배너 클릭', 10)).toBe(4)
  })

  test('fills the screen lines from the first row that starts at or after the top line', async () => {
    const list = Array.from({ length: 10 }, (_, i) => `row ${i}`)
    const ones = list.map(() => 1)
    expect(rowsFrom(list, ones, 0, 3)).toEqual(['row 0', 'row 1', 'row 2'])
    expect(rowsFrom(list, ones, 7, 5)).toEqual(['row 7', 'row 8', 'row 9'])
    expect(rowsFrom(['x', 'y', 'z'], [3, 1, 1], 0, 2)).toEqual(['x']) // 3 lines already
    expect(rowsFrom(['x', 'y', 'z'], [3, 1, 1], 1, 2)).toEqual(['y', 'z']) // x starts above line 1
  })

  test('scrolled to the end, the oldest row is on screen, wide and wrapped rows and all', async () => {
    const texts = ['#3 한글 질문 하나', '   ✓ 로그인 페이지 상단 배너 클릭 시 상세 팝업이 안 뜨는 문제 수정', '', '#2 짧은 질문', '   ✓ 끝', '', '#1 가장 오래된 질문입니다', '   ✓ 마지막 줄']
    const lines = texts.map(text => lineCount(text, 20))
    const total = lines.reduce((sum, n) => sum + n, 0)
    expect(total).toBeGreaterThan(texts.length) // some wrap
    const top = scrolledTop(0, 1000, total, 5)
    const shown = rowsFrom(texts, lines, top, 5)
    expect(shown.at(-1)).toBe('   ✓ 마지막 줄')
    expect(shown.reduce((sum, text) => sum + lineCount(text, 20), 0)).toBeLessThanOrEqual(5) // nothing cut by the frame
  })

  test('scrolls from the newest row down to a screen that ends at the oldest', async () => {
    expect(scrolledTop(0, 3, 100, 10)).toBe(3)
    expect(scrolledTop(3, -5, 100, 10)).toBe(0)
    expect(scrolledTop(80, 50, 100, 10)).toBe(90)
    expect(scrolledTop(0, 3, 5, 10)).toBe(0) // it all fits
  })

  test('the scrollbar: a press at the top shows the start, at the bottom the end; the thumb is the share on screen', async () => {
    expect(topAt(0, 10, 100)).toBe(0)
    expect(topAt(9, 10, 100)).toBe(90)
    expect(topAt(20, 10, 100)).toBe(90) // dragged past the edge
    expect(thumb(10, 100, 0)).toEqual({ start: 0, size: 1 })
    expect(thumb(10, 100, 90)).toEqual({ start: 9, size: 1 })
    expect(thumb(10, 20, 0)).toEqual({ start: 0, size: 5 })
    expect(thumb(10, 8, 0)).toEqual({ start: 0, size: 0 }) // it all fits: no thumb
  })

  test('marks each agent status, at work with an hourglass, and names its model', async () => {
    expect(isRunning('running') && isRunning('pending') && isRunning('waiting')).toBe(true)
    expect(isRunning('idle')).toBe(false) // a teammate between turns: its time stops, nothing redraws for it
    expect(isRunning('completed') || isRunning('failed') || isRunning('killed')).toBe(false)
    expect(statusMark('running')).toEqual({ icon: '⏳', color: 'yellow' })
    expect(statusMark('completed')).toEqual({ icon: '✓', color: 'green' })
    expect(statusMark('failed')).toEqual({ icon: '✗', color: 'red' })
    expect(statusMark('killed')).toEqual({ icon: '■', color: 'gray' })
    expect(modelLabel(task({ model: 'claude-fable-5-1' }))).toBe('fable')
    expect(modelLabel(task({ model: '', type: 'Explore' }))).toBe('Explore')
  })

  test('keeps an agent the engine has dropped from its list, as ended, and folds in its activity', async () => {
    const list = addAgent([], { id: 'a1', description: 'review', type: 'general-purpose', model: 'claude-fable-5-1', startedAt: 100 })
    expect(addAgent(list, { id: 'a1', description: 'again', type: 't', model: '', startedAt: 999 })).toHaveLength(1)
    const activity = new Map([['a1', { tools: 7, last: 'reading a.ts' }]])
    const listed = [{ id: 'a1', description: 'review', type: 'general-purpose', status: 'running' }, { id: 'a2', description: 'explore', type: 'Explore', status: 'running' }] as any
    const merged = mergeAgents(list, listed, activity, 500)
    expect(merged.map(t => [t.id, t.status, t.tools, t.last, t.startedAt])).toEqual([
      ['a1', 'running', 7, 'reading a.ts', 100],
      ['a2', 'running', 0, '', 500], // one started before the mod loaded joins
    ])
    const gone = mergeAgents(merged, [], activity, 900)
    expect(gone.map(t => [t.id, t.status, t.endedAt])).toEqual([
      ['a1', 'completed', 900],
      ['a2', 'completed', 900],
    ])
    expect(endAgent(gone, 'a1', 'failed', 1000)[0]).toMatchObject({ status: 'failed', endedAt: 900 }) // its first end stays
  })

  test('an ended agent stays ended while the list catches up; a finished one the engine still lists does not come back', async () => {
    const ended = endAgent(addAgent([], { id: 'a1', description: 'review', type: 't', model: '', startedAt: 100 }), 'a1', 'completed', 300)
    const listed = [{ id: 'a1', description: 'review', type: 't', status: 'running' }, { id: 'old', description: 'cleared', type: 't', status: 'completed' }] as any
    expect(mergeAgents(ended, listed, new Map(), 400).map(t => [t.id, t.status, t.endedAt])).toEqual([['a1', 'completed', 300]])
    expect(mergeAgents(ended, [{ ...listed[0], status: 'idle' }], new Map(), 400)[0]).toMatchObject({ status: 'idle', endedAt: 300 })
  })

  test('a known agent at work again counts its time from the new run; a resumed spawn fills in what it lacked', async () => {
    const joined = mergeAgents([], [{ id: 'a1', description: 'review', type: 't', status: 'running' }] as any, new Map(), 100)
    expect(startAgent(joined, 'a1', 500)[0]).toMatchObject({ status: 'running', startedAt: 100 }) // running: untouched
    const ended = endAgent(joined, 'a1', 'completed', 200)
    expect(startAgent(ended, 'a1', 500)[0]).toMatchObject({ status: 'running', startedAt: 500, endedAt: 0 })
    const resumed = addAgent(ended, { id: 'a1', description: 'review', type: 't', model: 'claude-fable-5-1', startedAt: 600 })
    expect(resumed).toHaveLength(1)
    expect(resumed[0]).toMatchObject({ status: 'running', startedAt: 600, model: 'claude-fable-5-1' })
  })

  test('keeps every agent at work and the latest 50 to end', async () => {
    const list = [
      ...Array.from({ length: 60 }, (_, i) => ({ id: `done${i}`, description: '', type: 't', model: '', status: 'completed', startedAt: 0, endedAt: i + 1, tools: 0, last: '' })),
      { id: 'run', description: '', type: 't', model: '', status: 'running', startedAt: 0, endedAt: 0, tools: 0, last: '' },
    ]
    const kept = trimAgents(list)
    expect(kept).toHaveLength(51)
    expect(kept.some(t => t.id === 'run')).toBe(true)
    expect(kept.some(t => t.id === 'done0')).toBe(false)
    expect(kept.some(t => t.id === 'done59')).toBe(true)
  })

  test('shows running agents first, newest first, then the latest to end, up to a count', async () => {
    const list = [
      task({ id: 'old-done', status: 'completed', endedAt: 10 }),
      task({ id: 'run-old', startedAt: 1 }),
      task({ id: 'new-done', status: 'failed', endedAt: 50 }),
      task({ id: 'run-new', startedAt: 5 }),
    ]
    const picked = pickAgents(list, 3)
    expect(picked.shown.map(t => t.id)).toEqual(['run-new', 'run-old', 'new-done'])
    expect(picked.more).toBe(1)
  })
})

describe('prompt-recap agents and layout', () => {
  test('an agent that starts shows at the top, at work, with its model; when it ends it is done', async ($, on) => {
    engine(on)
    on('agent.spawn', () => ({ model: 'claude-fable-5-1', agentId: 'a1' }))
    on('agent.list', () => ({ value: [{ id: 'a1', description: 'Fable review', type: 'general-purpose', status: 'running' }] }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.agent.spawn({ prompt: 'review', description: 'Fable review', subagentType: 'general-purpose' } as any)

    let ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect((await ui.find({ type: 'Button', key: 'agent:a1' }))?.text).toMatch(/^Fable review {2}fable · \d+s · 0 tools$/)
    expect(await ui.find({ type: 'Text', text: '⏳' })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'agents' }))?.text).toBe('🤖 Agents 1/1 ▴')
    await ui.unmount()

    await $.turn.complete({ reason: 'answer', answer: 'all good', durationMs: 1, isAborted: false, turnId: 'x', agentId: 'a1' } as any)
    ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: '✓' })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'agents' }))?.text).toBe('🤖 Agents 0/1 ▴')
    await ui.unmount()
  })

  test('pressing an agent opens its transcript; Back goes to the main one; a refusal is said', async ($, on) => {
    engine(on)
    const views: unknown[] = []
    const toasts: string[] = []
    on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
    on('ui.view', (_$: any, e: any) => (views.push(e), e.agentId === 'gone' ? { deny: 'the tasks list shows no row for it' } : { value: {} }))
    on('ui.toast', (_$: any, e: any) => (toasts.push(e.text), { value: undefined }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.agent.spawn({ prompt: 'look', description: 'Explore code', subagentType: 'Explore' } as any)

    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    await ui.press({ key: 'agent:a1' })
    expect(views).toEqual([{ agentId: 'a1' }])
    await ui.unmount()

    const viewed = { ...PANE, props: { ...PANE.props, view: { agentId: 'a1' } } }
    const back = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...viewed } as any)
    expect(await back.find({ type: 'Text', text: '▶' })).toBeDefined() // the row in view
    await back.press({ key: 'back' })
    expect(views.at(-1)).toEqual({})
    await back.unmount()
    expect(toasts).toEqual([])
  })

  test('docked: the top stays, the list sits in a frame and scrolls by its scrollbar; the prompt at work is highlighted', async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    for (let i = 1; i <= 12; i++) {
      await $.prompt.submit({ text: `question ${i}`, origin: typed, wait: false } as any)
      await $.turn.start({ text: `question ${i}`, turnId: `t${i}` } as any)
      if (i < 12) await $.turn.complete({ reason: 'answer', answer: `answer ${i}`, durationMs: 1, isAborted: false, turnId: `t${i}` } as any)
    }

    const docked = { ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 14 } } }
    const ui = (await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...docked } as any)) as Mounted<'terminal', 'Pane'>
    expect(((await ui.drawn()) as any).props).toMatchObject({ height: 14, overflow: 'hidden' })
    expect((await ui.find({ type: 'Box', key: 'list' })) as any).toMatchObject({ props: { borderStyle: 'round' } })
    expect(await ui.find({ type: 'Text', text: '▌' })).toBeDefined() // #12 is at work
    expect(await ui.find({ type: 'Text', text: /working…/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '#12 ' })).toBeDefined() // newest first
    expect(await ui.find({ type: 'Text', text: '#1 ' })).toBeUndefined()

    await ui.resize({ in: 'scrollbar', columns: 1, rows: 10 })
    await ui.pointer({ in: 'scrollbar', type: 'down', x: 0, y: 9, button: 'left' }) // the bottom: the oldest
    await ui.pointer({ in: 'scrollbar', type: 'up', x: 0, y: 9, button: 'left' })
    expect(await ui.find({ type: 'Text', text: '#1 ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '#12 ' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('prompt-recap agents over time', () => {
  test('an agent’s tool calls show on the next tick; gone from the engine’s list, it is done', async ($, on) => {
    const clock = engine(on)
    let listed: any[] = [{ id: 'a1', description: 'Fable review', type: 'general-purpose', status: 'running' }]
    on('agent.spawn', () => ({ model: 'claude-fable-5-1', agentId: 'a1' }))
    on('agent.list', () => ({ value: listed }))
    on('tool.call', () => ({ result: 'ok' }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.agent.spawn({ prompt: 'review', description: 'Fable review', subagentType: 'general-purpose' } as any)
    await $.tool.call({ tool: 'Read', file_path: '/work/src/a.ts', agentId: 'a1' } as any)
    await $.tool.call({ tool: 'Read', file_path: '/work/src/login.tsx', agentId: 'a1' } as any)
    await clock.advance(3_000)

    let ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect((await ui.find({ type: 'Button', key: 'agent:a1' }))?.text).toMatch(/^Fable review {2}fable · 3s · 2 tools$/)
    expect(await ui.find({ type: 'Text', text: /↳ .*login\.tsx/ })).toBeDefined()
    await ui.unmount()

    listed = []
    await clock.advance(3_000)
    ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: '✓' })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'agents' }))?.text).toBe('🤖 Agents 0/1 ▴')
    expect(await ui.find({ type: 'Text', text: /↳ .*login\.tsx/ })).toBeUndefined() // the last action shows only at work
    await ui.unmount()
  })

  test('Clear and /prompt-recap clear keep the agents at work and drop those done; /clear drops them all', async ($, on) => {
    engine(on)
    let n = 0
    on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: `a${++n}` }))
    on('agent.list', () => ({ value: [] }))
    on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    const spawn =(description: string) => $.agent.spawn({ prompt: 'go', description, subagentType: 'Explore' } as any)
    const done = (agentId: string) => $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: agentId, agentId } as any)
    await spawn('still at work')
    await spawn('done first')
    await done('a2')

    let ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect((await ui.find({ type: 'Button', key: 'agents' }))?.text).toBe('🤖 Agents 1/2 ▴')
    await ui.press({ key: 'clear' })
    expect((await ui.find({ type: 'Button', key: 'agents' }))?.text).toBe('🤖 Agents 1/1 ▴')
    expect(await ui.find({ type: 'Button', key: 'agent:a2' })).toBeUndefined()
    await ui.unmount()

    await spawn('done next')
    await done('a3')
    await $.command.run({ command: 'prompt-recap', args: 'clear' } as any)
    ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Button', key: 'agent:a1' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'agent:a3' })).toBeUndefined()
    await ui.unmount()

    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as any)
    ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Button', key: 'agents' })).toBeUndefined()
    await ui.unmount()
  })

  test('an agent that ended and runs again shows at work, its time counted from the new run', async ($, on) => {
    const clock = engine(on)
    on('agent.spawn', () => ({ model: 'claude-fable-5-1', agentId: 'a1' }))
    on('agent.list', () => ({ value: [] }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.agent.spawn({ prompt: 'review', description: 'Fable review', subagentType: 'general-purpose' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 'r1', agentId: 'a1' } as any)
    await clock.advance(60_000)
    await $.turn.start({ text: 'one more thing', turnId: 'r2', agentId: 'a1' } as any)

    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect((await ui.find({ type: 'Button', key: 'agents' }))?.text).toBe('🤖 Agents 1/1 ▴')
    expect((await ui.find({ type: 'Button', key: 'agent:a1' }))?.text).toMatch(/fable · 0s · 0 tools$/)
    await ui.unmount()
  })

  test('inline above the prompt: its natural height and the last 3 prompts', async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    for (let i = 1; i <= 5; i++) {
      await $.prompt.submit({ text: `question ${i}`, origin: typed, wait: false } as any)
      await $.turn.start({ text: `question ${i}`, turnId: `t${i}` } as any)
      await $.turn.complete({ reason: 'answer', answer: `answer ${i}`, durationMs: 1, isAborted: false, turnId: `t${i}` } as any)
    }
    const inline = { ...PANE, props: { ...PANE.props, placement: 'inline', scroll: { offset: 0, bodyRows: 14 } } }
    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...inline } as any)
    expect(((await ui.drawn()) as any).props.height).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '#5 ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '#3 ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '#2 ' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'full' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('the list kept for a resume', () => {
  test('keeps the latest 10 sessions, the one saved now first', async () => {
    const index = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, savedAt: 100 - i }))
    const again = keepSessions(index, 's5', 200)
    expect(again.index.map(one => one.id)).toEqual(['s5', 's0', 's1', 's2', 's3', 's4', 's6', 's7', 's8', 's9'])
    expect(again.dropped).toEqual([])
    const added = keepSessions(index, 'new', 200)
    expect(added.index).toHaveLength(10)
    expect(added.index[0]).toEqual({ id: 'new', savedAt: 200 })
    expect(added.dropped).toEqual(['s9'])
  })

  test('a prompt still at work when the session left comes back cut off', async () => {
    let list = addPrompt([], 'first')
    list = completeTurn(startTurn(list, 't1', 'first'), 't1', 'done', 5)
    list = startTurn(addPrompt(list, 'second'), 't2', 'second')
    expect(restored(list).map(entry => [entry.isDone, entry.answer, entry.turnId])).toEqual([
      [true, 'done', ''],
      [true, '(interrupted)', ''], // their turns are over: none of this run matches them
    ])
  })

  test('saves the latest 100 prompts, each with its latest 10 follow-ups', async () => {
    let list: ReturnType<typeof addPrompt> = []
    for (let i = 1; i <= 120; i++) list = addPrompt(list, `prompt ${i}`)
    list = startTurn(list, 't', 'prompt 120')
    for (let i = 1; i <= 15; i++) list = addFollowUp(list, 't', `more ${i}`)
    const saved = toSave(list)
    expect(saved).toHaveLength(100)
    expect(saved[0]?.prompt).toBe('prompt 21')
    expect(saved.at(-1)?.followUps).toEqual(Array.from({ length: 10 }, (_, i) => `more ${i + 6}`))
    expect(list.at(-1)?.followUps).toHaveLength(15) // the pane keeps them all
  })
})

describe('prompt-recap across a resume', () => {
  const ask = async ($: any, text: string, turnId: string) => {
    await $.prompt.submit({ text, origin: typed, wait: false })
    await $.turn.start({ text, turnId })
    await $.turn.complete({ reason: 'answer', answer: `answered ${text}`, durationMs: 1, isAborted: false, turnId })
    await settle()
  }
  const shows = async ($: any, text: string) => {
    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE })
    const found = (await ui.findAll({ type: 'Text' })).some((one: any) => one.text === text)
    await ui.unmount()
    return found
  }

  test('claude --resume starts with the list the session left, the recap on top too', async ($, on) => {
    engine(on)
    on('session.id', () => ({ value: 's1' }))
    const left = completeTurn(startTurn(addPrompt([], 'add a login page'), 't1', 'add a login page'), 't1', 'added it', 5)
    mock.store(on, {
      'session:s1': { entries: startTurn(addPrompt(left, 'add a logout button'), 't2', 'add a logout button'), recap: { goal: 'ship login', now: 'added it', waiting: '', next: 'logout' } },
      sessions: [{ id: 's1', savedAt: 1 }],
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await settle()

    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /🎯 Goal: ship login/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '#1 ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '#2 ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✓ \(interrupted\)$/ })).toBeDefined() // #2 was at work
    expect(await ui.find({ type: 'Text', text: /working…/ })).toBeUndefined()
    await ui.unmount()
  })

  test('/resume: each session gets its own list back at its first prompt; Clear forgets it', off, async ($, on) => {
    engine(on)
    let sid = 's1'
    on('session.id', () => ({ value: sid }))
    on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
    mock.store(on)
    const resume = async (to: string) => {
      await $.session.end({ reason: 'resume', sessionId: sid, resume: { id: sid } } as any)
      sid = to
    }
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await settle()
    await ask($, 'question one', 't1')

    await resume('s2')
    expect(await shows($, 'question one')).toBe(false) // a resume empties the pane
    await ask($, 'question two', 't2')
    expect(await shows($, 'question one')).toBe(false)

    await resume('s1')
    await ask($, 'question three', 't3')
    expect(await shows($, 'question one')).toBe(true)
    expect(await shows($, 'question three')).toBe(true)
    expect(await shows($, 'question two')).toBe(false)

    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    await ui.press({ key: 'clear' })
    await ui.unmount()
    await settle()
    await resume('s2')
    await ask($, 'question four', 't4')
    expect(await shows($, 'question two')).toBe(true) // s2 kept its own
    await resume('s1')
    await ask($, 'question five', 't5')
    expect(await shows($, 'question one')).toBe(false) // cleared: forgotten
    expect(await shows($, 'question five')).toBe(true)
  })

  test('a prompt left at work comes back cut off; a /resume to the same session brings its list back', off, async ($, on) => {
    engine(on)
    let sid = 's1'
    on('session.id', () => ({ value: sid }))
    on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
    mock.store(on)
    const resume = async (to: string) => {
      await $.session.end({ reason: 'resume', sessionId: sid, resume: { id: sid } } as any)
      sid = to
    }
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await settle()
    await ask($, 'question one', 't1')
    await $.prompt.submit({ text: 'question two', origin: typed, wait: false } as any)
    await $.turn.start({ text: 'question two', turnId: 't2' } as any) // left before it ended
    await settle()

    await resume('s2')
    await ask($, 'elsewhere', 'x1')
    await resume('s1')
    await ask($, 'question three', 't3')
    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect((await ui.findAll({ type: 'Text' })).map(one => one.text).filter(text => /^#\d+ $/.test(text))).toEqual(['#3 ', '#2 ', '#1 '])
    expect(await ui.find({ type: 'Text', text: /✓ \(interrupted\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✓ answered question three$/ })).toBeDefined()
    await ui.unmount()

    await resume('s1') // the same one again
    await ask($, 'question four', 't4')
    expect(await shows($, 'question one')).toBe(true)
    expect(await shows($, 'question four')).toBe(true)
  })

  test('a store that refuses to write never holds a turn back', off, async ($, on) => {
    engine(on)
    on('session.id', () => ({ value: 's1' }))
    on('store.get', () => ({ value: undefined }))
    on('store.set', () => {
      throw new Error('over 4 MiB')
    })
    on('store.delete', () => ({ value: undefined }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await settle()
    await ask($, 'question one', 't1')
    expect(await shows($, 'question one')).toBe(true)
    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /✓ answered question one$/ })).toBeDefined()
    await ui.unmount()
  })
})
