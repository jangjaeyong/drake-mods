import { describe, expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import { backspace, cellOf, colAt, deleteForward, follow, indentOf, insertText, keyOf, leadingSpace, slice } from '../hooks/editor'
import { branchOf, decodeText, encodeText, iconOf, markFor, parseGitStatus, scrolledTop, sortEntries, treeRows } from '../hooks/register'
import { thumb, topAt } from '../hooks/scrollbar'

const ROOT = 'C:/work/demo'
const PANE = { component: 'Pane', requestId: 'file-tree', props: { title: 'Files', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } }
const GIT_STATUS = ['## main...origin/main', ' M src/App.java', '?? notes.md', '!! build/', ''].join('\0')

// A project on a disk of the test's own: the files by path from the root, folders made of their paths.
// It records what the mod writes, opens, closes and toasts; `git` is what `git status` answers.
function world(on: any, files: Record<string, string>, git: string | null = GIT_STATUS) {
  const disk = {
    files: new Map(Object.entries(files).map(([path, text]) => [`${ROOT}/${path}`, { text, mtimeMs: 1 }])),
    writes: [] as { path: string; text: string }[],
    toasts: [] as string[],
    panes: [] as string[],
    opens: [] as string[],
    clipboard: '', // what the OS's clipboard tool answers
    onList: null as null | (() => Promise<void>), // runs once inside the next listing: a press while it lists
  }
  const norm = (path: string) => String(path).replace(/\\/g, '/').replace(/\/$/, '')
  const isDir = (path: string) => path === ROOT || [...disk.files.keys()].some(file => file.startsWith(`${path}/`))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', (_$: any, e: any) => {
    disk.opens.push(e.id)
    if (!disk.panes.includes(e.id)) disk.panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$: any, e: any) => {
    disk.panes = disk.panes.filter(id => id !== e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: disk.panes.map(id => ({ id, title: id, isShown: true, component: 'Pane' })) }))
  on('ui.toast', (_$: any, e: any) => (disk.toasts.push(e.text), { value: undefined }))
  on('ui.scroll', () => ({}))
  on('fs.list', async (_$: any, e: any) => {
    const job = disk.onList
    disk.onList = null
    await job?.()
    const dir = norm(e.path)
    const names = new Map<string, boolean>()
    for (const file of disk.files.keys()) {
      if (!file.startsWith(`${dir}/`)) continue
      const rest = file.slice(dir.length + 1).split('/')
      names.set(rest[0] as string, rest.length > 1 || names.get(rest[0] as string) === true)
    }
    return { value: [...names].map(([name, isFolder]) => ({ name, kind: isFolder ? 'dir' : 'file', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', (_$: any, e: any) => {
    const path = norm(e.path)
    const file = disk.files.get(path)
    if (file) return { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
    if (isDir(path)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    return { deny: 'no such file' }
  })
  on('fs.read', (_$: any, e: any) => {
    const file = disk.files.get(norm(e.path))
    return file ? { value: file.text } : { deny: 'no such file' }
  })
  on('fs.write', (_$: any, e: any) => {
    const path = norm(e.path)
    disk.files.set(path, { text: e.text, mtimeMs: (disk.files.get(path)?.mtimeMs ?? 0) + 1 })
    disk.writes.push({ path, text: e.text })
    return { value: undefined }
  })
  on('process.run', (_$: any, e: any) => {
    if (e.argv[0] === 'powershell.exe') return { value: { exitCode: 0, stdout: disk.clipboard, stderr: '' } }
    const args = e.argv.slice(1).join(' ')
    if (git === null) return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository' } }
    if (args.startsWith('rev-parse')) return { value: { exitCode: 0, stdout: '\n', stderr: '' } }
    return { value: { exitCode: 0, stdout: git, stderr: '' } }
  })
  on('turn.complete', () => ({ text: '' }))
  on('prompt.edit', (_$: any, e: any) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
  on('tool.call', () => ({ result: {} }))
  return disk
}

const FILES = {
  'src/App.java': 'class App {\n}\n',
  'src/util/Strings.java': 'class Strings {}\n',
  'build/out.txt': 'x',
  '.git/HEAD': 'ref: refs/heads/main\n',
  'README.md': '# demo\n',
  'notes.md': 'todo\n',
  'Zeta.txt': 'z\n',
}

async function opened($: any, on: any, files: Record<string, string> = FILES, git?: string | null) {
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on)
  const disk = world(on, files, git)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'file-tree', args: '' } as any)
  await clock.settle()
  const ui = (await $.ui.mount({ plugin: 'file-tree', surface: 'terminal', ...PANE } as any)) as Mounted<'terminal', 'Pane'>
  return { clock, disk, ui }
}

// A press on a file opens it in the editor, which takes the pane.
async function openInEditor(ui: any, clock: any, path: string) {
  await ui.press({ key: `row:${path}` })
  await clock.settle()
}

describe('the pieces', () => {
  test('folders first, then files, by name ignoring case', async () => {
    const sorted = sortEntries([
      { name: 'b.txt', isDir: false },
      { name: 'Src', isDir: true },
      { name: 'A.txt', isDir: false },
      { name: 'build', isDir: true },
    ])
    expect(sorted.map(entry => entry.name)).toEqual(['build', 'Src', 'A.txt', 'b.txt'])
  })

  test('an open folder lists its rows under it, one deeper', async () => {
    const listings = new Map([
      ['', [{ name: 'src', isDir: true }, { name: 'a.md', isDir: false }]],
      ['src', [{ name: 'main', isDir: true }, { name: 'App.java', isDir: false }]],
      ['src/main', [{ name: 'x.java', isDir: false }]],
    ])
    const rows = treeRows(listings, new Set(['src']), '', 1)
    expect(rows.map(row => `${row.depth}:${row.path}`)).toEqual(['1:src', '2:src/main', '2:src/App.java', '1:a.md'])
    expect(rows[0]?.isOpen).toBe(true)
    expect(rows[1]?.isOpen).toBe(false) // src/main is shut: its file is not listed
  })

  test("reads git's branch and marks, cut to the folder; inside an ignored folder all is ignored", async () => {
    const out = ['## feature/x...origin/feature/x [ahead 1]', ' M app/src/A.java', 'A  app/New.java', 'R  app/B.java', 'app/Old.java', '?? app/tmp/', '!! app/build/', 'UU app/C.java', ' M other/D.java', ''].join('\0')
    const view = parseGitStatus(out, 'app/')
    expect(view.branch).toBe('feature/x')
    expect([...view.marks]).toEqual([
      ['src/A.java', 'modified'],
      ['New.java', 'added'],
      ['B.java', 'modified'],
      ['tmp/', 'untracked'],
      ['build/', 'ignored'],
      ['C.java', 'conflicted'],
    ])
    expect(markFor(view.marks, 'build', true)).toBe('ignored')
    expect(markFor(view.marks, 'build/libs/x.jar', false)).toBe('ignored')
    expect(markFor(view.marks, 'tmp/a.txt', false)).toBe('untracked')
    expect(markFor(view.marks, 'src', true)).toBeUndefined() // a folder with a change in it keeps its colour, as IntelliJ's
    // Renamed in the work tree: the old path that follows is no entry of its own.
    expect([...parseGitStatus(['## main', ' R New.java', 'Main.java', ''].join('\0'), '').marks]).toEqual([['New.java', 'modified']])
  })

  test('names the branch of a new repository and a detached HEAD', async () => {
    expect(branchOf('No commits yet on main')).toBe('main')
    expect(branchOf('HEAD (no branch)')).toBe('HEAD')
    expect(branchOf('main')).toBe('main')
  })

  test('an icon by kind, as IntelliJ tells files apart', async () => {
    expect(iconOf('src', true, false)).toBe('📁')
    expect(iconOf('src', true, true)).toBe('📂')
    expect(iconOf('App.java', false, false)).toBe('☕')
    expect(iconOf('build.gradle', false, false)).toBe('🐘')
    expect(iconOf('application.yml', false, false)).toBe('🔧')
    expect(iconOf('Dockerfile', false, false)).toBe('🐳')
    expect(iconOf('LICENSE', false, false)).toBe('📄')
  })

  test('keeps the line ends and the BOM a file had; refuses binary, non-UTF-8 and too long', async () => {
    const decoded = decodeText('\uFEFFa\r\nb\r\n') as { text: string; eol: string; hasBom: boolean }
    expect(decoded).toEqual({ text: 'a\nb\n', eol: '\r\n', hasBom: true })
    expect(encodeText('a\nb\nc\n', '\r\n', true)).toBe('\uFEFFa\r\nb\r\nc\r\n')
    expect(encodeText('a\nb', '\n', false)).toBe('a\nb')
    expect((decodeText('a\nb\nc\r\n') as { eol: string }).eol).toBe('\n') // mixed: as most of its lines end
    expect(decodeText('PK\u0003\u0004\0\0')).toBe('is a binary file')
    expect(decodeText('caf\uFFFD')).toMatch(/not UTF-8/)
    expect(decodeText('x'.repeat(100_000))).toMatch(/too long/)
  })

  test('the editor inserts, breaks and joins lines, a Hangul syllable one character', async () => {
    let doc = { lines: ['abc'], row: 0, col: 1 }
    doc = insertText(doc, '한')
    expect(doc).toEqual({ lines: ['a한bc'], row: 0, col: 2 })
    doc = insertText(doc, 'x\ny\nz')
    expect(doc).toEqual({ lines: ['a한x', 'y', 'zbc'], row: 2, col: 1 })
    doc = backspace({ ...doc, col: 0 })
    expect(doc).toEqual({ lines: ['a한x', 'yzbc'], row: 1, col: 1 })
    doc = deleteForward({ ...doc, row: 0, col: 3 })
    expect(doc).toEqual({ lines: ['a한xyzbc'], row: 0, col: 3 })
    expect(backspace({ lines: ['a'], row: 0, col: 0 })).toEqual({ lines: ['a'], row: 0, col: 0 })
  })

  test('a new line keeps the indentation; Tab indents as the file does', async () => {
    expect(leadingSpace('    return x', 8)).toBe('    ')
    expect(leadingSpace('\tif (a) {', 9)).toBe('\t')
    expect(indentOf(['class A {', '  int x;', '    y();', '}'])).toBe('  ')
    expect(indentOf(['a', '\tb', '\tc'])).toBe('\t')
    expect(indentOf(['plain'])).toBe('    ')
  })

  test('Ctrl+S, Enter and Backspace whichever way the terminal sends them', async () => {
    expect(keyOf({ key: '\x13' })).toEqual({ key: 's', ctrl: true })
    expect(keyOf({ key: '\r' })).toEqual({ key: 'return' })
    expect(keyOf({ key: '\n', ctrl: true })).toEqual({ key: 'return', ctrl: true })
    expect(keyOf({ key: '\x7f' })).toEqual({ key: 'backspace' })
    expect(keyOf({ key: '\x16' })).toEqual({ key: 'v', ctrl: true }) // Ctrl+V, where the terminal passes it on
    expect(keyOf({ key: 's', ctrl: true })).toEqual({ key: 's', ctrl: true })
  })

  test('draws a line from its scrolled start within the width, the cursor on its character', async () => {
    expect(cellOf('한')).toBe(2)
    expect(cellOf('\t')).toBe(4)
    expect(slice('a한b', 0, 10, 1)).toEqual({ before: 'a', at: '한', after: 'b' })
    expect(slice('ab', 0, 10, 2)).toEqual({ before: 'ab', at: ' ', after: '' }) // at the end: a block
    expect(slice('a\tb', 0, 10, -1)).toEqual({ before: 'a    b', at: '', after: '' })
    expect(slice('abcdef', 2, 3, -1).before).toBe('cde')
    expect(colAt('a한b', 0, 2)).toBe(1) // the second cell of 한 is still 한
    expect(colAt('a한b', 0, 9)).toBe(3)
    expect(follow({ doc: { lines: ['x'.repeat(30)], row: 0, col: 25 }, top: 0, left: 0 }, 5, 10)).toEqual({ top: 0, left: 16 })
    expect(follow({ doc: { lines: Array(40).fill('x'), row: 30, col: 0 }, top: 0, left: 0 }, 10, 10)).toEqual({ top: 21, left: 0 })
    // A wide character under the cursor at the right edge: the view moves on so it is drawn whole.
    const edge = 'a'.repeat(8) + '한'
    expect(slice(edge, follow({ doc: { lines: [edge], row: 0, col: 8 }, top: 0, left: 0 }, 5, 9).left, 9, 8).at).toBe('한')
  })

  test('the tree scrolls between its start and a screen that ends at its last row; the scrollbar maps presses', async () => {
    expect(scrolledTop(0, -3, 50, 10)).toBe(0)
    expect(scrolledTop(38, 5, 50, 10)).toBe(40)
    expect(topAt(0, 8, 50)).toBe(0)
    expect(topAt(7, 8, 50)).toBe(42)
    expect(thumb(10, 5, 0)).toEqual({ start: 0, size: 0 })
  })
})

describe('file-tree', () => {
  test('/file-tree shows the project as IntelliJ does: the root with its branch, folders first, git colours, no .git', async ($, on) => {
    const { ui, disk } = await opened($, on)
    expect(disk.opens).toEqual(['file-tree'])
    expect(await ui.find({ type: 'Button', key: 'root' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'demo' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  main' })).toBeDefined() // the branch
    const names = (await ui.findAll({ type: 'Button' })).map(button => button.key).filter(key => key?.startsWith('row:'))
    expect(names).toEqual(['row:build', 'row:src', 'row:notes.md', 'row:README.md', 'row:Zeta.txt'])
    expect(((await ui.find({ type: 'Text', text: 'build' })) as any)?.props?.color).toBe('#C9915D') // ignored: orange
    expect(((await ui.find({ type: 'Text', text: 'notes.md' })) as any)?.props?.color).toBe('#D1675A') // untracked: red
    expect(((await ui.find({ type: 'Text', text: 'README.md' })) as any)?.props?.color).toBeUndefined()
    await ui.unmount()
  })

  test('a folder opens on a press and shuts on the next; a double click toggles it once', async ($, on) => {
    const { ui, clock } = await opened($, on)
    await ui.press({ key: 'row:src' })
    expect(await ui.find({ type: 'Button', key: 'row:src/App.java' })).toBeDefined()
    expect(((await ui.find({ type: 'Text', text: 'App.java' })) as any)?.props?.color).toBe('#6897BB') // modified: blue
    expect(await ui.find({ type: 'Text', text: '▾ ' })).toBeDefined()

    await clock.advance(600) // the second click of a slow double click
    await ui.press({ key: 'row:src' })
    expect(await ui.find({ type: 'Button', key: 'row:src/App.java' })).toBeDefined()

    await clock.advance(1_000) // a press of its own
    await ui.press({ key: 'row:src' })
    expect(await ui.find({ type: 'Button', key: 'row:src/App.java' })).toBeUndefined()

    // Pressed steadily: the time counts from the press that toggled, not from the one left out.
    await clock.advance(700)
    await ui.press({ key: 'row:src' })
    expect(await ui.find({ type: 'Button', key: 'row:src/App.java' })).toBeUndefined()
    await clock.advance(700)
    await ui.press({ key: 'row:src' })
    expect(await ui.find({ type: 'Button', key: 'row:src/App.java' })).toBeDefined()
    await ui.unmount()
  })

  test('a folder opened while the tree is listed again keeps its rows', async ($, on) => {
    const { ui, clock, disk } = await opened($, on)
    disk.onList = () => ui.press({ key: 'row:src' }).then(() => {})
    await $.command.run({ command: 'file-tree', args: 'refresh' } as any)
    await clock.settle()
    expect(await ui.find({ type: 'Button', key: 'row:src/App.java' })).toBeDefined()
    await ui.unmount()
  })

  test('a file opens in the editor on a press; ← Files goes back to the tree, the file marked', async ($, on) => {
    const { ui } = await opened($, on)
    expect(await ui.find({ type: 'Button', key: 'save' })).toBeUndefined()
    await ui.press({ key: 'row:README.md' })
    // The editor takes the pane: no tab to find behind the tree.
    expect(await ui.find({ type: 'Button', key: 'save' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'row:README.md' })).toBeUndefined()

    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Button', key: 'row:README.md' })).toBeDefined()
    expect(((await ui.find({ type: 'Text', text: 'README.md' })) as any)?.props?.inverse).toBe(true)
    expect((await ui.find({ type: 'Button', key: 'editor' }))?.text).toMatch(/Editor: README\.md/) // and back to the editor
    await ui.press({ key: 'editor' })
    expect(await ui.find({ type: 'Button', key: 'save' })).toBeDefined()
    await ui.unmount()
  })

  test('typing in the editor: Enter breaks the line, Ctrl+S saves with the line ends the file had', async ($, on) => {
    const { ui, clock, disk } = await opened($, on, { ...FILES, 'src/App.java': 'class App {\r\n}\r\n' })
    await ui.press({ key: 'row:src' })
    await clock.advance(1_000)
    await openInEditor(ui, clock, 'src/App.java')
    const editor = ui
    await editor.resize({ in: 'editor', columns: 60, rows: 10 })
    expect(await editor.find({ type: 'Text', text: 'src/App.java' })).toBeDefined()

    // At the end of the first line: Enter, then a field, indented as the file indents.
    await editor.key({ key: 'end', in: 'editor' })
    await editor.key({ key: 'return', in: 'editor' })
    await editor.key({ key: 'tab', in: 'editor' })
    for (const ch of 'int x;') await editor.key({ key: ch === ' ' ? ' ' : ch, in: 'editor' })
    await clock.settle()
    expect(await editor.find({ type: 'Text', text: /modified/ })).toBeDefined()

    // Drawn with line numbers, the cursor after what was typed.
    const texts = (await editor.findAll({ type: 'Text', in: 'editor' })).map(t => t.text)
    expect(texts).toEqual(['1 ', 'class App {', '2 ', '    int x; ', ' ', '3 ', '}', '4 ', ''])
    expect(((await editor.find({ type: 'Text', text: /^ $/, in: 'editor' })) as any)?.props?.inverse).toBe(true) // the cursor

    await editor.key({ key: 's', ctrl: true, in: 'editor' })
    await clock.settle()
    expect(disk.writes).toEqual([{ path: `${ROOT}/src/App.java`, text: 'class App {\r\n    int x;\r\n}\r\n' }])
    expect(await editor.find({ type: 'Text', text: /modified/ })).toBeUndefined()
    expect(await editor.find({ type: 'Text', text: /saved/ })).toBeDefined()
    await ui.unmount()
  })

  test('Save asks first when the file changed on disk since it was read; Overwrite writes it', async ($, on) => {
    const { ui, clock, disk } = await opened($, on)
    await openInEditor(ui, clock, 'notes.md')
    const editor = ui
    await editor.resize({ in: 'editor', columns: 60, rows: 10 })
    await editor.key({ key: '!', in: 'editor' })
    await clock.settle()

    // Claude changes it meanwhile.
    disk.files.set(`${ROOT}/notes.md`, { text: 'todo: by Claude\n', mtimeMs: 7 })
    await editor.press({ key: 'save' })
    expect(disk.writes).toEqual([])
    expect(await editor.find({ type: 'Text', text: /Changed on disk/ })).toBeDefined()

    await editor.press({ key: 'overwrite' })
    expect(disk.writes).toEqual([{ path: `${ROOT}/notes.md`, text: '!todo\n' }])
    expect(await editor.find({ type: 'Text', text: /Changed on disk/ })).toBeUndefined()
    await ui.unmount()
  })

  test("a clean editor takes the file again when Claude's edit changes it on disk", async ($, on) => {
    const { ui, clock, disk } = await opened($, on, { ...FILES, 'notes.md': 'notes\ntodo\n' })
    await openInEditor(ui, clock, 'notes.md')
    const editor = ui
    await editor.resize({ in: 'editor', columns: 60, rows: 10 })
    expect(await editor.find({ type: 'Text', text: 'todo', in: 'editor' })).toBeDefined() // the second line: the cursor is on the first

    disk.files.set(`${ROOT}/notes.md`, { text: 'notes\ndone\n', mtimeMs: 9 })
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/notes.md`, old_string: 'todo', new_string: 'done' } as any)
    await clock.advance(500)
    expect(await editor.find({ type: 'Text', text: 'done', in: 'editor' })).toBeDefined()
    expect(await editor.find({ type: 'Text', text: /Reloaded/ })).toBeDefined()
    await ui.unmount()
  })

  test('what was typed survives ← Files and back, however soon; Ctrl+Z undoes a run of typing at once', async ($, on) => {
    const { ui, clock } = await opened($, on)
    await openInEditor(ui, clock, 'notes.md')
    await ui.resize({ in: 'editor', columns: 60, rows: 10 })
    for (const ch of 'ab') await ui.key({ key: ch, in: 'editor' })
    await ui.key({ key: 'return', in: 'editor' })
    await ui.key({ key: 'c', in: 'editor' })
    await ui.key({ key: 'z', ctrl: true, in: 'editor' }) // the c goes
    expect(await ui.find({ type: 'Text', text: /^c/, in: 'editor' })).toBeUndefined()
    await ui.key({ key: 'z', ctrl: true, in: 'editor' }) // the line break goes
    await ui.key({ key: 'y', ctrl: true, in: 'editor' }) // and comes back
    await ui.key({ key: 'd', in: 'editor' })

    // At once, before the draft is kept: the editor drawn again starts from what it last posted.
    await ui.press({ key: 'back' })
    await ui.press({ key: 'editor' })
    await ui.resize({ in: 'editor', columns: 60, rows: 10 })
    const texts = (await ui.findAll({ type: 'Text', in: 'editor' })).map(t => t.text)
    expect(texts).toContain('ab')
    expect(texts).toContain('dtodo') // drawn afresh, its cursor back at the start
    expect(await ui.find({ type: 'Text', text: /modified/ })).toBeDefined()
    await ui.unmount()
  })

  test("undone back to the file's text, the editor drawn again is clean: Ctrl+S writes nothing", async ($, on) => {
    const { ui, clock, disk } = await opened($, on)
    await openInEditor(ui, clock, 'notes.md')
    await ui.resize({ in: 'editor', columns: 60, rows: 10 })
    await ui.key({ key: 'x', in: 'editor' })
    await clock.advance(1_100) // kept as the draft
    await ui.key({ key: 'z', ctrl: true, in: 'editor' })
    expect(await ui.find({ type: 'Text', text: /modified/ })).toBeUndefined()
    await ui.press({ key: 'back' })
    await ui.press({ key: 'editor' })
    await ui.resize({ in: 'editor', columns: 60, rows: 10 })
    expect((await ui.findAll({ type: 'Text', in: 'editor' })).some(t => /x/.test(t.text ?? ''))).toBe(false)
    expect(await ui.find({ type: 'Text', text: /modified/ })).toBeUndefined()
    await ui.key({ key: 's', ctrl: true, in: 'editor' })
    await clock.settle()
    expect(disk.writes).toEqual([])
    await ui.unmount()
  })

  test("what the editor posted before Claude's edit loaded the file again is not taken, so not saved", async ($, on) => {
    const { ui, clock, disk } = await opened($, on)
    await openInEditor(ui, clock, 'notes.md')
    await ui.resize({ in: 'editor', columns: 60, rows: 10 })
    disk.files.set(`${ROOT}/notes.md`, { text: 'done\n', mtimeMs: 9 })
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/notes.md`, old_string: 'todo', new_string: 'done' } as any)
    await clock.advance(500)
    // A key pressed as it reloaded: the editor drawn before posts the old text with it.
    await ui.post({ text: 'xtodo\n', version: 1, saves: 0, pasted: 0, paste: false }, { in: 'editor' })
    expect(await ui.find({ type: 'Text', text: /modified/ })).toBeUndefined()
    await ui.press({ key: 'save' })
    expect(disk.writes).toEqual([])
    await ui.unmount()
  })

  test('Ctrl+S on a text too long to cross is not made later, when it is short again', async ($, on) => {
    const { ui, clock, disk } = await opened($, on, { ...FILES, 'big.txt': `${'a'.repeat(87)}\n`.repeat(1_000) })
    await openInEditor(ui, clock, 'big.txt')
    await ui.resize({ in: 'editor', columns: 60, rows: 10 })
    await ui.key({ key: 'y', in: 'editor' })
    await ui.key({ key: 'left', in: 'editor' }) // the typing after it is an undo step of its own
    await ui.key({ key: `${'x'.repeat(49)}\n`.repeat(140), in: 'editor' }) // past what a post holds
    await ui.key({ key: 's', ctrl: true, in: 'editor' })
    await ui.press({ key: 'save' }) // nor by the button: the pane's copy is behind what is drawn
    expect(await ui.find({ type: 'Text', text: /too long to save/ })).toBeDefined()
    await ui.key({ key: 'z', ctrl: true, in: 'editor' }) // short again, still changed
    await clock.settle()
    expect(disk.writes).toEqual([])
    expect(await ui.find({ type: 'Text', text: /modified/ })).toBeDefined()
    await ui.unmount()
  })

  test("End on a long line (a minified file's) goes there at once", async ($, on) => {
    const { ui, clock } = await opened($, on, { ...FILES, 'min.js': `${'x'.repeat(30_000)}y\n` })
    await openInEditor(ui, clock, 'min.js')
    await ui.resize({ in: 'editor', columns: 60, rows: 10 })
    await ui.key({ key: 'end', in: 'editor' })
    expect((await ui.findAll({ type: 'Text', in: 'editor' })).some(t => /xy $/.test(t.text ?? ''))).toBe(true)
    await ui.unmount()
  })

  test('keys that are no text (F1, F5, Insert) type nothing', async ($, on) => {
    const { ui, clock } = await opened($, on)
    await openInEditor(ui, clock, 'notes.md')
    await ui.resize({ in: 'editor', columns: 60, rows: 10 })
    for (const key of ['\x1bOP', '\x1b[15~', '\x1b[2~', 'f5']) await ui.key({ key, in: 'editor' })
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: /modified/ })).toBeUndefined()
    await ui.unmount()
  })

  test("Paste and Alt+V put the clipboard's text in the editor at its cursor; a terminal paste stays the prompt box's", async ($, on) => {
    const { ui, clock, disk } = await opened($, on)
    await openInEditor(ui, clock, 'notes.md')
    await ui.resize({ in: 'editor', columns: 60, rows: 10 })

    disk.clipboard = 'P1\r\nP2 ' // as Windows keeps it
    await ui.press({ key: 'paste' })
    await clock.settle()
    let texts = (await ui.findAll({ type: 'Text', in: 'editor' })).map(t => t.text)
    expect(texts).toContain('P1')
    expect(texts).toContain('P2 todo') // the cursor after the paste, on its 't'
    expect(await ui.find({ type: 'Text', text: /modified/ })).toBeDefined()

    disk.clipboard = 'Q'
    await ui.key({ key: 'v', meta: true, in: 'editor' }) // Alt+V
    await clock.settle()
    texts = (await ui.findAll({ type: 'Text', in: 'editor' })).map(t => t.text)
    expect(texts).toContain('P2 Qtodo')

    // Ctrl+V is the terminal's, whichever key it pastes with: reaching the editor it does nothing, and the
    // terminal's paste goes to the prompt box, the editor clicked or not.
    disk.clipboard = 'R'
    await ui.key({ key: 'v', ctrl: true, in: 'editor' })
    await clock.settle()
    texts = (await ui.findAll({ type: 'Text', in: 'editor' })).map(t => t.text)
    expect(texts).toContain('P2 Qtodo')

    await ui.pointer({ in: 'editor', type: 'down', x: 2, y: 0, button: 'left' })
    await ui.pointer({ in: 'editor', type: 'up', x: 2, y: 0, button: 'left' })
    const pasted = await ($.prompt as any).edit({ origin: { kind: 'composer' }, text: 'hi', cursor: 2, start: 2, end: 2, inputText: 'XY' })
    expect(pasted).toEqual({ text: 'hiXY', cursor: 4 })

    disk.clipboard = ''
    await ui.press({ key: 'paste' })
    expect(await ui.find({ type: 'Text', text: /holds no text/ })).toBeDefined()
    await ui.unmount()
  })

  test('Close over unsaved changes asks; pressed again it discards them', async ($, on) => {
    const { ui, clock, disk } = await opened($, on)
    await openInEditor(ui, clock, 'notes.md')
    const editor = ui
    await editor.resize({ in: 'editor', columns: 60, rows: 10 })
    await editor.key({ key: 'x', in: 'editor' })
    await clock.settle()

    await editor.press({ key: 'close' })
    expect(await editor.find({ type: 'Button', key: 'save' })).toBeDefined()
    expect(await editor.find({ type: 'Text', text: /press Close again/ })).toBeDefined()
    await editor.press({ key: 'close' })
    expect(await editor.find({ type: 'Button', key: 'save' })).toBeUndefined() // the tree is back
    expect(await editor.find({ type: 'Button', key: 'row:notes.md' })).toBeDefined()
    expect(await editor.find({ type: 'Button', key: 'editor' })).toBeUndefined()
    expect(disk.writes).toEqual([])
    await ui.unmount()
  })

  test('another file waits while one has unsaved changes; a binary one is refused', async ($, on) => {
    const { ui, clock, disk } = await opened($, on, { ...FILES, 'logo.png': '\u0089PNG\0\0' })
    await openInEditor(ui, clock, 'notes.md')
    const editor = ui
    await editor.resize({ in: 'editor', columns: 60, rows: 10 })
    await editor.key({ key: 'x', in: 'editor' })
    await clock.settle()

    await editor.press({ key: 'back' })
    await clock.advance(1_000)
    await openInEditor(ui, clock, 'README.md')
    expect(disk.toasts.at(-1)).toMatch(/notes\.md has unsaved changes/)
    expect(await editor.find({ type: 'Text', text: 'notes.md' })).toBeDefined() // the editor it was, back

    await editor.press({ key: 'revert' }) // the disk's text again: nothing unsaved
    await editor.press({ key: 'back' })
    await clock.advance(1_000)
    await openInEditor(ui, clock, 'logo.png')
    expect(disk.toasts.at(-1)).toMatch(/logo\.png is a binary file/)
    await ui.unmount()
  })

  test('without git the tree still shows, uncoloured', async ($, on) => {
    const { ui } = await opened($, on, FILES, null)
    expect(await ui.find({ type: 'Button', key: 'row:src' })).toBeDefined()
    expect(((await ui.find({ type: 'Text', text: 'build' })) as any)?.props?.color).toBeUndefined()
    await ui.unmount()
  })

  test('docked, the tree holds to its height and scrolls by its scrollbar', async ($, on) => {
    const many: Record<string, string> = {}
    for (let i = 0; i < 40; i++) many[`f${String(i).padStart(2, '0')}.txt`] = ''
    const { ui } = await opened($, on, many, null)
    const tree = (await ui.drawn()) as any
    expect(tree.props).toMatchObject({ height: 20, overflow: 'hidden' })
    await ui.resize({ in: 'scrollbar', columns: 1, rows: 10 })
    expect(await ui.find({ type: 'Button', key: 'row:f00.txt' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'row:f39.txt' })).toBeUndefined()
    await ui.pointer({ in: 'scrollbar', type: 'down', x: 0, y: 9, button: 'left' })
    await ui.pointer({ in: 'scrollbar', type: 'up', x: 0, y: 9, button: 'left' })
    expect(await ui.find({ type: 'Button', key: 'row:f39.txt' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'row:f00.txt' })).toBeUndefined()
    await ui.unmount()
  })
})
