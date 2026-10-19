import { describe, expect, test } from 'claude-code/testing'

import { addFollowUp, addPrompt, attachRecap, clip, completeTurn, describe as label, firstLine, parseRecap, short, startTurn } from '../hooks/register'

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
}

describe('the list', () => {
  test('a prompt, a follow-up, the end of its turn and then its summary', async () => {
    let list = addPrompt([], 'rename the user table')
    list = startTurn(list, 't1')
    list = addFollowUp(list, 't1', 'keep the old name as a view')
    list = completeTurn(list, 't1', 'Renamed it.', 12_000)
    expect(list[0]).toMatchObject({ id: 1, turnId: 't1', followUps: ['keep the old name as a view'], answer: 'Renamed it.', isDone: true })

    list = attachRecap(list, 't1', 'renamed users to members', 'review the migration')
    expect(list[0]).toMatchObject({ summary: 'renamed users to members', waiting: 'review the migration' })
    list = attachRecap(list, 't1', 'something else', '')
    expect(list[0]!.summary).toBe('renamed users to members')
  })

  test('a turn nobody typed for takes no entry', async () => {
    let list = completeTurn(startTurn(addPrompt([], 'first'), 't1'), 't1', 'done', 1)
    list = startTurn(list, 't2') // a background task's notification
    list = completeTurn(list, 't2', 'task finished', 1)
    expect(list).toHaveLength(1)
    expect(list[0]!.answer).toBe('done')
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
    expect(await ui.find({ type: 'Text', text: /use the existing form styles/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /→ Added the login page\.$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1m 23s/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /… working/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'summary', text: 'Summary: off' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'full' })).toBeUndefined() // it needs the model
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
    expect(await ui.find({ type: 'Text', text: /^ {2}\+ / })).toBeUndefined()
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
    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /◆ Goal: 로그인 기능 완성/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /next: 로그아웃 버튼/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /waiting on you: 화면 확인/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /→ 로그인 페이지 추가$/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'summary', text: 'Summary: on' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'full' })).toBeDefined()
    await ui.unmount()
  })

  test('with summaries off, the model is never called', off, async ($, on) => {
    engine(on)
    let calls = 0
    on('model.complete', () => (calls++, { value: { isAnswered: true, text: '{}', usage } }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.prompt.submit({ text: 'hello', origin: typed, wait: false } as any)
    await $.turn.start({ text: 'hello', turnId: 't1' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'hi', durationMs: 1, isAborted: false, turnId: 't1' } as any)
    await settle()
    expect(calls).toBe(0)
    expect((await $.command.run({ command: 'prompt-recap', args: 'recap' } as any)).text).toBe('Summaries are off: /prompt-recap summary on')
  })

  test('/prompt-recap summary off writes the option', async ($, on) => {
    engine(on)
    const writes: unknown[] = []
    on('config.set', (_$: any, e: any) => (writes.push({ key: e.key, value: e.value }), { value: e.value }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    expect((await $.command.run({ command: 'prompt-recap', args: 'summary off' } as any)).text).toBe('Summaries off')
    expect(writes).toEqual([{ key: 'prompt-recap.summary', value: 'off' }])
  })

  test('an empty pane says how it fills', off, async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /No prompts yet/ })).toBeDefined()
    await ui.unmount()
  })
})
