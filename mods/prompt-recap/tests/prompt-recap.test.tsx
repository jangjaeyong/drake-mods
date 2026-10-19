import { describe, expect, test } from 'claude-code/testing'

import { addFollowUp, addPrompt, attachRecap, clip, completeTurn, firstLine, startTurn } from '../hooks/register'

const PANE = { component: 'Pane', requestId: 'prompt-recap', props: { title: 'Prompt Recap', isFocused: false, bodyColumns: 80, placement: 'dock' } }
const typed = { kind: 'composer' } as const

describe('the list', () => {
  test('a prompt, a follow-up, the end of its turn and then its recap', async () => {
    let list = addPrompt([], 'rename the user table')
    list = startTurn(list, 't1')
    list = addFollowUp(list, 't1', 'keep the old name as a view')
    list = completeTurn(list, 't1', 'Renamed it.', 12_000)
    expect(list[0]).toMatchObject({ id: 1, turnId: 't1', followUps: ['keep the old name as a view'], answer: 'Renamed it.', isDone: true })

    list = attachRecap(list, 't1', 'renamed users to members', 'review the migration')
    expect(list[0]).toMatchObject({ summary: 'renamed users to members', waiting: 'review the migration' })
    // A second recap (a turn nobody typed for) leaves the first one be.
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
})

describe('prompt-recap', () => {
  test('records your prompt, what you added mid-turn and how the turn ended, newest first', async ($, on) => {
    on('session.start', (_$, e) => ({ cwd: e.cwd }) as any)
    on('prompt.submit', (_$, e) => ({ text: e.text }) as any)
    on('turn.start', (_$, e) => ({ turnId: e.turnId }) as any)
    on('turn.complete', () => ({ text: '' }) as any)
    on('command.register', () => ({ value: undefined }) as any)
    on('ui.open', () => ({ value: { isPlaced: true } }) as any)

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
    await ui.unmount()
  })

  test('an empty pane says how it fills', async ($, on) => {
    on('session.start', (_$, e) => ({ cwd: e.cwd }) as any)
    on('command.register', () => ({ value: undefined }) as any)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

    const ui = await $.ui.mount({ plugin: 'prompt-recap', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /No prompts yet/ })).toBeDefined()
    await ui.unmount()
  })
})
