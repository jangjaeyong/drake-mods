import { describe, expect, test } from 'claude-code/testing'

import { addFollowUp, addPrompt, attachRecap, clip, completeTurn, describe as label, findRow, firstLine, parseRecap, short, startTurn } from '../hooks/register'

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
    const rows = new Map([['fix the login bug please', 'm1'], ['[Pasted text #1]', 'm2']])
    expect(findRow(rows, 'fix the login bug please')).toBe('m1')
    expect(findRow(rows, 'fix the login bug')).toBe('m1')
    expect(findRow(rows, 'nothing like it')).toBeUndefined()
    expect(findRow(rows, '')).toBeUndefined()
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
    expect(await ui.find({ type: 'Text', text: /→ Added the tests\.$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ {2}\+ / })).toBeUndefined()
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
    expect(await ui.find({ type: 'Text', text: /◆ Goal: ship login/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /→ added the page$/ })).toBeDefined()
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
    expect(await ui.find({ type: 'Text', text: /→ \(error\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /→ \(refused\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /→ \(interrupted\)$/ })).toBeDefined()
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

  test('an empty pane says how it fills', off, async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /No prompts yet/ })).toBeDefined()
    await ui.unmount()
  })
})
