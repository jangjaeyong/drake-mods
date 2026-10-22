import { describe, expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

// The pane this fork draws in place of cc-arcade's band above the prompt.
const PANE = { component: 'Pane', requestId: 'arcade', props: { title: 'Arcade', isFocused: false, bodyColumns: 56, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } }

function world(on: any) {
  const ui = { opens: [] as string[], closes: [] as string[] }
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', (_$: any, e: any) => (ui.opens.push(e.id), { value: { isPlaced: true } }))
  on('ui.close', (_$: any, e: any) => (ui.closes.push(e.id), { value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  return ui
}

async function started($: any, on: any) {
  mock.clock(on, { now: 1_000 })
  mock.store(on)
  const ui = world(on)
  await $.session.start({ cwd: 'C:/work/demo', surface: 'terminal', isInteractive: true })
  return ui
}

const board = (pane: Mounted<'terminal', 'Pane'>, name: string) => pane.find({ type: 'Client', key: `board:${name}` }) as Promise<any>

describe('arcade', () => {
  test('/arcade opens a pane with the picker; a game takes the pane, sized to it', async ($, on) => {
    const ui = await started($, on)
    const r = await $.command.run({ command: 'arcade', args: '' } as any)
    expect(ui.opens).toEqual(['arcade'])
    expect((r as any).text).toMatch(/click a game in the pane/)

    const pane = (await $.ui.mount({ plugin: 'arcade', surface: 'terminal', ...PANE } as any)) as Mounted<'terminal', 'Pane'>
    expect(await pane.find({ type: 'Button', key: 'pick:tetris' })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'pick:doom' })).toBeDefined()

    await pane.press({ key: 'pick:tetris' })
    const tetris = await board(pane, 'tetris')
    expect(tetris?.props).toMatchObject({ module: 'hooks/boards/tetris.tsx', width: 56, height: 23 })
    expect(await pane.find({ type: 'Button', key: 'pick:tetris' })).toBeUndefined()

    // doom takes every row the pane has, less the one for its buttons
    await pane.press({ key: 'arcade:back' })
    await pane.press({ key: 'pick:doom' })
    expect((await board(pane, 'doom'))?.props).toMatchObject({ width: 56, height: 39 })
    await pane.unmount()
  })

  test('/arcade <game> opens the pane on that game; close and /arcade stop close the pane', async ($, on) => {
    const ui = await started($, on)
    await $.command.run({ command: 'arcade', args: 'snake' } as any)
    expect(ui.opens).toEqual(['arcade'])
    const pane = (await $.ui.mount({ plugin: 'arcade', surface: 'terminal', ...PANE } as any)) as Mounted<'terminal', 'Pane'>
    expect(await board(pane, 'snake')).toBeDefined()

    await pane.press({ key: 'arcade:close' })
    expect(ui.closes).toEqual(['arcade'])
    await $.command.run({ command: 'arcade', args: 'stop' } as any)
    expect(ui.closes).toEqual(['arcade', 'arcade'])
    await pane.unmount()
  })

  test('the pet board gets the time as a number ($.clock.now() answers a promise)', async ($, on) => {
    await started($, on)
    await $.command.run({ command: 'arcade', args: 'pet' } as any)
    const pane = (await $.ui.mount({ plugin: 'arcade', surface: 'terminal', ...PANE } as any)) as Mounted<'terminal', 'Pane'>
    const props = (await board(pane, 'pet'))?.props?.props
    expect(props?.now).toBe(1_000)
    expect(props?.pet?.at).toBe(1_000)
    await pane.unmount()
  })

  test("the main turn's end pauses the game; a subagent's does not", async ($, on) => {
    await started($, on)
    await $.command.run({ command: 'arcade', args: 'tetris' } as any)
    const pane = (await $.ui.mount({ plugin: 'arcade', surface: 'terminal', ...PANE } as any)) as Mounted<'terminal', 'Pane'>
    const done = async () => (await board(pane, 'tetris'))?.props?.props?.done
    expect(await done()).toBe(0)
    const turn = { reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't1' }
    await $.turn.complete({ ...turn, agentId: 'agent-1' } as any)
    await pane.redraw()
    expect(await done()).toBe(0)
    await $.turn.complete(turn as any)
    await pane.redraw()
    expect(await done()).toBe(1)
    await pane.unmount()
  })
})
