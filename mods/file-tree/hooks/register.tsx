// File Tree: the session's folder as a tree in a pane, as IntelliJ's Project view or VS Code's Explorer
// draw it, each name in git's colour for it. A folder opens on a press; a file on a press (a double click
// too) in this mod's own editor, which takes the pane until `← Files`: Enter breaks the line, Ctrl+S
// saves. An image or a document (PDF, Word, Excel, ...) opens in the OS's own app for it instead. The
// editor shares the tree's pane rather than opening one of its own: a pane opened from a press in another
// stays a tab behind it, and nothing on $ brings it forward.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { EditStatus, GitMark, OpenFile, TreeEntry } from '../types'

const PANE = 'file-tree'
const TITLE = 'Files'
const HIDDEN = new Set(['.git']) // what the tree leaves out
const MAX_ROWS = 2000 // inline, the whole tree is drawn: no more rows than this
const MAX_EDIT_BYTES = 1_000_000 // a file this big is not even read
const MAX_EDIT_JSON = 90_000 // the text crosses to the editor whole, its escapes counted: room left under a prop's 100,000
const WHEEL_ROWS = 3 // rows one wheel tick moves
const REFRESH_MS = 300 // a burst of edits refreshes the tree once
const DRAFT_MS = 1000 // the editor's text is kept for a reload this long after its last edit
const AGAIN_MS = 800 // a folder's second press this soon is the rest of a slow double click: one toggle
// Files only their own app reads (images, office documents, PDF): pressed, they open in it, not the editor.
const OUTSIDE = new Set('png jpg jpeg gif bmp webp ico tif tiff avif heic pdf doc docx xls xlsx xlsm ppt pptx hwp hwpx odt ods odp'.split(' '))
// Windows opens one by its file association: the path comes in the environment, so no quoting can break it.
const OPEN_PS = '$i = New-Object Diagnostics.ProcessStartInfo $env:FILE_TREE_OPEN; $i.UseShellExecute = $true; [void][Diagnostics.Process]::Start($i)'
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']) // calls that may change files
const CLEAN: EditStatus = { isDirty: false, isChangedOnDisk: false, savedAt: 0, message: '' }

// Git's colours, IntelliJ's: changed blue, added green, unversioned red, ignored orange.
const MARK_COLORS: Record<GitMark, string> = {
  modified: '#6897BB',
  added: '#62B543',
  untracked: '#D1675A',
  ignored: '#C9915D',
  conflicted: '#E5534B',
}

// Held by the host, so they survive a hot reload of this file.
const expanded = atom({ plugin: 'file-tree', key: 'expanded' } as const, [] as string[])
const rootOpen = atom({ plugin: 'file-tree', key: 'isRootOpen' } as const, true)
const selected = atom({ plugin: 'file-tree', key: 'selected' } as const, '')
const tick = atom({ plugin: 'file-tree', key: 'tick' } as const, 0)
const opened = atom({ plugin: 'file-tree', key: 'file' } as const, null as OpenFile | null)
const draft = atom({ plugin: 'file-tree', key: 'draft' } as const, null as string | null)
const saves = atom({ plugin: 'file-tree', key: 'saves' } as const, 0)
const wheel = atom({ plugin: 'file-tree', key: 'wheel' } as const, 0)
const editStatus = atom({ plugin: 'file-tree', key: 'status' } as const, CLEAN)
const isEditing = atom({ plugin: 'file-tree', key: 'isEditing' } as const, false) // the pane shows the editor, not the tree

// Git's view of the folder: the branch, and a mark per path that has one (a folder's ends in '/').
export type GitView = { branch: string; marks: Map<string, GitMark> }
const NO_GIT: GitView = { branch: '', marks: new Map() }

// What is read from the disk and moves faster than it is worth a write: this module's own.
const rt = {
  cwd: '',
  // Runs a job after `ms` with the session's own $: no hook waits on it, so it is not tied to the $ of
  // the event that asked.
  soon: undefined as ((ms: number, job: Job) => void) | undefined,
  listings: new Map<string, TreeEntry[]>(), // each listed folder's entries, by its path ('' the root)
  git: NO_GIT,
  top: 0, // the first tree row on screen, docked
  listRows: 0, // the rows the tree has on screen, as its scrollbar measured them
  totalRows: 0, // the tree's rows, as last drawn
  isPinned: false, // the pane is docked and held to its height, so its tree scrolls here
  isRefreshDue: false,
  isDraftDue: false,
  isSaving: false, // a save under way: its own change on disk is not someone else's
  lastPress: { path: '', at: 0 },
  text: undefined as string | undefined, // the editor's text as last posted, while it differs from the file's
  isTooLong: false, // the editor's text grew too long to post: `text` is behind it, so nothing is saved
  isCloseArmed: false, // Close was pressed over unsaved changes: once more discards them
  paste: { seq: 0, text: '' }, // the latest text read from the clipboard for the editor, until it took it
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    rt.cwd = e.cwd
    rt.soon = (ms, job) => $.clock.after(ms, () => void runJob($, job).catch(() => {}))
    rt.text = (await read($, draft).catch(() => null)) ?? undefined // a reload keeps what was typed
    await $.command.register({
      name: 'file-tree',
      description: "Show the project's folders and files in a pane",
      argumentHint: '[refresh]',
    }).catch(() => {}) // a name Claude Code already has is refused: start anyway
    // Reloaded with the pane up, it lists again; otherwise nothing is read until it opens.
    if ((await $.ui.panes().catch(() => [])).some(pane => pane.id === PANE)) void refresh($).catch(() => {})
    return r
  })

  on('command.run', { command: 'file-tree' }, async ($, e) => {
    await refresh($, true)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: e.args.trim().toLowerCase() === 'refresh' ? 'File tree refreshed' : 'File tree opened' }
  })

  // Claude's edits and commands change files: the tree, git's colours and the open file follow, once
  // a burst of them settles. Observe only: a failure here never holds a call or a turn back.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (next.origin.plugin === 'engine' && EDIT_TOOLS.has(e.tool)) refreshSoon()
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) refreshSoon()
    return r
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Client = 'Client' in table ? table.Client : null // the scrollbar takes the pointer where a surface has it
    await read($, tick) // redraws as listings come in and the tree scrolls
    const open = new Set(await read($, expanded))
    const isRootOpen = await read($, rootOpen)
    const picked = await read($, selected)
    const editing = await read($, opened)
    const st = await read($, editStatus)
    const isInline = e.props.placement === 'inline'
    // Docked, the pane is held to its body's height: the buttons stay put and only the tree scrolls, by
    // this mod (ui.scroll below), not by the engine. Inline above the prompt it keeps its natural height.
    const bodyRows = e.props.scroll?.bodyRows ?? 0
    rt.isPinned = !isInline && bodyRows > 0
    const pin = rt.isPinned ? { height: bodyRows, overflow: 'hidden' as const } : {}
    const frame = rt.isPinned ? { flexGrow: 1, overflow: 'hidden' as const } : {}

    // A file open in the editor takes the pane until `← Files`: its path and state, Save, Revert and
    // Close, and the editor itself (read-only where a surface draws no Client).
    if (editing && (await read($, isEditing))) {
      const { Code } = table
      const kept = await read($, draft)
      const count = await read($, saves)
      const moved = await read($, wheel)
      const at = st.savedAt ? new Date(st.savedAt).toTimeString().slice(0, 8) : ''
      const text = rt.isPinned ? frame : { height: bodyRows > 8 ? bodyRows - 4 : 12, overflow: 'hidden' as const }
      // The editor starts from what it last posted: back from the tree within DRAFT_MS, the kept draft
      // lags behind it. (Its undo steps do not come back: they lived in the editor drawn before.)
      const latest = rt.text ?? kept ?? editing.text
      return (
        <Box flexDirection="column" {...pin}>
          <Box flexDirection="column" flexShrink={0}>
            <Box flexDirection="row" gap={1}>
              <Button key="back" label="← Files" dimColor onPress={() => {}} />
              <Text wrap="truncate-start">
                <Text bold>{editing.path}</Text>
                {st.isDirty ? <Text color="yellow">{'  ● modified'}</Text> : <Text dimColor>{at ? `  saved ${at}` : ''}</Text>}
              </Text>
            </Box>
            <Box flexDirection="row" gap={1}>
              <Button key="save" label="Save" variant="primary" onPress={() => {}} />
              <Button key="revert" label="Revert" dimColor onPress={() => {}} />
              {Client && <Button key="paste" label="Paste" dimColor onPress={() => {}} />}
              <Button key="close" label={rt.isCloseArmed ? 'Close: discard' : 'Close'} dimColor onPress={() => {}} />
              {Client && <Text dimColor wrap="truncate-end">click the text to type · Ctrl+S save · Alt+V paste · Ctrl+Z undo · Esc leaves it</Text>}
            </Box>
            {st.isChangedOnDisk && (
              <Box flexDirection="row" gap={1}>
                <Text color="yellow">Changed on disk since it was read.</Text>
                <Button key="overwrite" label="Overwrite" onPress={() => {}} />
                <Button key="reload" label="Reload" onPress={() => {}} />
              </Box>
            )}
            {st.message !== '' && <Text color="yellow" wrap="wrap">{st.message}</Text>}
          </Box>
          <Box key="text" flexDirection="column" borderStyle="round" borderDimColor {...text}>
            {Client ? (
              <Client key="editor" module="./editor.tsx" props={{ text: latest, version: editing.version, saves: count, wheel: moved, paste: rt.paste }} width="100%" height="100%" />
            ) : (
              <Code source={latest} path={editing.path} startLine={1} />
            )}
          </Box>
        </Box>
      )
    }

    // The root first, as IntelliJ draws it: the project's name, where it is and the git branch.
    const root: TreeRow = { path: '', name: baseName(rt.cwd), depth: 0, isDir: true, isOpen: isRootOpen }
    const rows = [root, ...(isRootOpen ? treeRows(rt.listings, open, '', 1) : [])]
    rt.totalRows = rows.length
    rt.top = scrolledTop(rt.top, 0, rt.totalRows, rt.listRows)
    const shown = rt.isPinned ? rows.slice(rt.top, rt.top + (rt.listRows > 0 ? rt.listRows : bodyRows)) : rows.slice(0, MAX_ROWS)

    const draw = (row: TreeRow) => {
      const isRoot = row.path === ''
      const mark = isRoot ? undefined : markFor(rt.git.marks, row.path, row.isDir)
      // Each row one line, a long name cut at the frame: the scrolling counts rows.
      const parts = [
        <Text>{'  '.repeat(row.depth)}</Text>,
        <Text dimColor>{row.isDir ? (row.isOpen ? '▾ ' : '▸ ') : '  '}</Text>,
        <Text>{`${iconOf(row.name, row.isDir, row.isOpen)} `}</Text>,
        <Text color={mark ? MARK_COLORS[mark] : undefined} bold={isRoot} inverse={!isRoot && row.path === picked}>
          {row.name}
        </Text>,
      ]
      if (editing?.path === row.path && st.isDirty) parts.push(<Text color="yellow">{' ●'}</Text>)
      if (isRoot) parts.push(<Text dimColor>{`  ${rt.cwd}`}</Text>)
      if (isRoot && rt.git.branch !== '') parts.push(<Text color={MARK_COLORS.ignored}>{`  ${rt.git.branch}`}</Text>)
      return (
        <Box key={`line:${row.path}`} height={1} overflow="hidden">
          <Button key={isRoot ? 'root' : `row:${row.path}`} plain onPress={() => {}}>
            {parts}
          </Button>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" {...pin}>
        <Box flexDirection="row" gap={1} flexShrink={0}>
          <Button key="refresh" label="Refresh" dimColor onPress={() => {}} />
          <Button key="collapse" label="Collapse all" dimColor onPress={() => {}} />
          {editing && <Button key="editor" label={`Editor: ${baseName(editing.path)}${st.isDirty ? ' ●' : ''}`} dimColor onPress={() => {}} />}
        </Box>
        <Box key="tree" flexDirection="row" borderStyle="round" borderDimColor {...frame}>
          <Box flexDirection="column" flexGrow={1} {...frame}>
            {shown.map(draw)}
            {!rt.isPinned && rows.length > MAX_ROWS && <Text dimColor>{`… ${rows.length - MAX_ROWS} more rows: the fullscreen view scrolls them`}</Text>}
          </Box>
          {rt.isPinned && Client && (
            <Client key="scrollbar" module="./scrollbar.tsx" props={{ total: rt.totalRows, top: rt.top }} width={1} height="100%" />
          )}
        </Box>
      </Box>
    )
  })

  // A press on a folder opens or shuts it; on a file, opens it in the editor. The editor's buttons too.
  on('ui.press', { plugin: 'file-tree', component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.element.startsWith('row:')) await pressRow($, e.element.slice('row:'.length))
    else if (e.element === 'root') await update($, rootOpen, v => !v)
    else if (e.element === 'refresh') await refresh($, true)
    else if (e.element === 'collapse') {
      rt.top = 0
      await update($, expanded, () => [])
    } else if (e.element === 'editor') await update($, isEditing, () => true)
    else if (e.element === 'back') await update($, isEditing, () => false)
    else if (e.element === 'save') await save($, rt.text, false)
    else if (e.element === 'overwrite') await save($, rt.text, true)
    else if (e.element === 'revert' || e.element === 'reload') await reload($)
    else if (e.element === 'paste') await pasteClipboard($)
    else if (e.element === 'close') await closeEditor($)
    // Answered here: each Button's own onPress is empty, and the view a press changed (the editor and the
    // tree) holds no closure of the Button it left for the engine to run.
    return { element: e.element }
  })

  // Docked, the tree scrolls itself: the wheel, the arrows and the page keys move it, and the engine's
  // window stays at the top, where the buttons are. Inline, the engine scrolls as usual. Over the editor
  // they scroll its text.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const by = e.pointer ? e.by * WHEEL_ROWS : e.by
    if ((await read($, isEditing)) && (await read($, opened))) void update($, wheel, n => n + by).catch(() => {})
    else if (rt.isPinned) {
      rt.top = scrolledTop(rt.top, by, rt.totalRows, rt.listRows)
      void update($, tick, n => n + 1).catch(() => {})
    } else return next(e)
    return next({ ...e, offset: 0 })
  })

  // The editor posts its whole text on each edit and the version of the file it edits, how many saves it
  // was asked for (Ctrl+S), the last paste it took in, and Alt+V. The scrollbar says where to look (a
  // press or a drag) and how many rows the tree has on screen.
  on('ui.message', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.element === 'editor') {
      const posted = (e.data ?? {}) as { text?: unknown; version?: unknown; saves?: unknown; pasted?: unknown; paste?: unknown }
      // The paste is in the editor's text now: its own copy need not cross again with every draw.
      if (typeof posted.pasted === 'number' && posted.pasted >= rt.paste.seq) rt.paste = { seq: rt.paste.seq, text: '' }
      if (posted.paste === true) await pasteClipboard($)
      // Text typed before the file was loaded again (Claude's edit, a Revert) is not taken, nor saved.
      const isCurrent = posted.version === (await read($, opened))?.version
      const text = isCurrent && typeof posted.text === 'string' ? posted.text : undefined
      if (isCurrent) rt.isTooLong = text === undefined
      if (text !== undefined) await takeText($, text)
      // Each save asked for counts once: one whose text was too long to cross, or was left, is not made later.
      if (typeof posted.saves === 'number' && posted.saves > (await read($, saves))) {
        await update($, saves, () => posted.saves as number)
        if (text !== undefined) await save($, rt.text, false) // as the Save button: nothing changed, nothing written
      }
      return next(e)
    }
    const data = (e.data ?? {}) as { top?: unknown; rows?: unknown }
    let isMoved = false
    if (typeof data.rows === 'number' && data.rows > 0 && data.rows !== rt.listRows) {
      rt.listRows = data.rows
      isMoved = true
    }
    if (typeof data.top === 'number') {
      rt.top = scrolledTop(data.top, 0, rt.totalRows, rt.listRows)
      isMoved = true
    }
    if (isMoved) void update($, tick, n => n + 1).catch(() => {})
    return next(e)
  })
}

// Lists the root and the open folders again, asks git, and checks the open file, when the tree is up
// (or `isForced`, as it opens); the open file is checked either way.
async function refresh($: EngineInterface, isForced = false) {
  if (isForced || (await $.ui.panes()).some(pane => pane.id === PANE)) {
    const dirs = ['', ...(await read($, expanded))]
    const listed = await Promise.all(dirs.map(dir => listDir($, dir)))
    // Into what is there: a folder opened while these were listed keeps its own listing.
    dirs.forEach((dir, i) => rt.listings.set(dir, listed[i] ?? []))
    rt.git = await gitView($)
  }
  await checkOnDisk($).catch(() => {})
  await update($, tick, n => n + 1)
}

// Paste and Alt+V: the clipboard's text into the editor at its cursor. The terminal's own paste (Ctrl+V,
// Ctrl+Shift+V, Cmd+V) stays the prompt box's: the terminal hands it there whatever holds the keys, and
// nothing says reliably whether the person meant the editor, so the editor takes the clipboard only when
// asked by name.
async function pasteClipboard($: EngineInterface) {
  const file = await read($, opened)
  if (!file) return
  const text = await readClipboard($)
  const say = (message: string) => update($, editStatus, s => ({ ...s, message }))
  if (text === undefined) await say('Could not read the clipboard.')
  else if (text === '') await say('The clipboard holds no text.')
  // The text and the paste cross to the editor together: no more than that holds.
  else if (JSON.stringify((rt.text ?? file.text) + text).length > MAX_EDIT_JSON) await say('Too long to paste here.')
  else {
    rt.paste = { seq: rt.paste.seq + 1, text }
    await update($, tick, n => n + 1)
  }
}

// The clipboard's text by the OS's own tool: PowerShell on Windows (asked for UTF-8, which it does not
// write by default), pbpaste on macOS, else whichever of Wayland's and X's is there.
async function readClipboard($: EngineInterface): Promise<string | undefined> {
  const tools = isWindowsPath(rt.cwd)
    ? [['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::Out.Write((Get-Clipboard -Raw))']]
    : [['pbpaste'], ['wl-paste', '--no-newline'], ['xclip', '-selection', 'clipboard', '-o'], ['xsel', '--clipboard', '--output']]
  for (const argv of tools) {
    const r = await $.process.run(argv, { timeoutMs: 5_000 }).catch(() => undefined)
    if (r?.exitCode === 0) return r.stdout
  }
  return undefined
}

function refreshSoon() {
  if (!rt.soon || rt.isRefreshDue) return
  rt.isRefreshDue = true
  rt.soon(REFRESH_MS, 'refresh')
}

// What runs later (rt.soon): a refresh after a burst of Claude's edits, or keeping the editor's text.
type Job = 'refresh' | 'draft'

async function runJob($: EngineInterface, job: Job) {
  if (job === 'refresh') {
    rt.isRefreshDue = false
    await refresh($)
  } else {
    rt.isDraftDue = false
    await update($, draft, () => rt.text ?? null)
  }
}

async function listDir($: EngineInterface, dir: string): Promise<TreeEntry[]> {
  const entries = await $.fs.list(fullPath(dir)).catch(() => [])
  const list = await Promise.all(
    entries
      .filter(entry => !HIDDEN.has(entry.name))
      .map(async entry => ({
        name: entry.name,
        // A link to a folder opens as one.
        isDir: entry.kind === 'dir' || (entry.isLink && (await $.fs.stat(fullPath(join(dir, entry.name))).then(s => s.kind === 'dir', () => false))),
      })),
  )
  return sortEntries(list)
}

// Git's branch and marks, by `git status`: paths come from the repository's root, so the folder's own
// place in it (its prefix) is cut off them. No git, or no repository: no colours.
async function gitView($: EngineInterface): Promise<GitView> {
  const git = (args: string[]) => $.process.run(['git', ...args], { cwd: rt.cwd, timeoutMs: 15_000 }).catch(() => undefined)
  const prefix = await git(['rev-parse', '--show-prefix'])
  if (!prefix || prefix.exitCode !== 0) return NO_GIT
  const status = await git(['status', '--porcelain=v1', '-b', '-z', '--ignored', '--untracked-files=normal'])
  if (!status || status.exitCode !== 0) return NO_GIT
  return parseGitStatus(status.stdout, prefix.stdout.trim())
}

// A press on a file opens it, so a double click does too: the fullscreen terminal keeps a double click's
// second click from a Button, and only a slow one (past half a second) arrives, on the editor's text by
// then. A folder opens or shuts; its second press within AGAIN_MS of the one that did is the rest of a
// slow double click.
async function pressRow($: EngineInterface, path: string) {
  const entry = entryAt(path)
  if (!entry) return
  const now = await $.clock.now()
  const isAgain = rt.lastPress.path === path && now - rt.lastPress.at < AGAIN_MS
  if (!isAgain) rt.lastPress = { path, at: now }
  await update($, selected, () => path)
  if (!entry.isDir && OUTSIDE.has(extensionOf(path))) {
    if (!isAgain) await openOutside($, path) // a slow double click opens one window
  } else if (!entry.isDir) await openFile($, path)
  else if (isAgain) return
  else if ((await read($, expanded)).includes(path)) await update($, expanded, list => list.filter(one => one !== path))
  else {
    rt.listings.set(path, await listDir($, path))
    await update($, expanded, list => [...list, path])
  }
}

// Opens a file in the editor. One file at a time: another with unsaved changes stays until they are
// saved or reverted.
async function openFile($: EngineInterface, path: string) {
  const now = await read($, opened)
  if (now?.path !== path) {
    if (now && (await read($, editStatus)).isDirty) {
      $.ui.toast(`file-tree: ${now.path} has unsaved changes: save it (Ctrl+S) or Revert it first`)
      await update($, isEditing, () => true)
      return
    }
    const loaded = await loadFile($, path)
    if (typeof loaded === 'string') {
      $.ui.toast(`file-tree: ${loaded}`)
      return
    }
    await setOpened($, loaded)
  } else await checkOnDisk($).catch(() => {})
  await update($, isEditing, () => true)
}

// An image or a document in the OS's own app for it, as a double click in Explorer or Finder opens it:
// on Windows by the file's association (PowerShell), on macOS by `open`, elsewhere by `xdg-open`. The
// app is started by the shell, not as a process of Claude Code's, so it stays open when Claude Code ends.
async function openOutside($: EngineInterface, path: string) {
  const full = fullPath(path)
  const tools = isWindowsPath(rt.cwd) ? [['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', OPEN_PS]] : [['xdg-open', full], ['open', full]]
  for (const argv of tools) {
    const r = await $.process.run(argv, { env: { FILE_TREE_OPEN: full.replace(/\//g, '\\') }, timeoutMs: 15_000 }).catch(() => undefined)
    if (!r) continue // not there: the next
    $.ui.toast(r.exitCode === 0 ? `file-tree: ${path} opened in its own app` : `file-tree: ${path} could not be opened: no app is set for it`)
    return
  }
  $.ui.toast(`file-tree: ${path} could not be opened: no way to start its app here`)
}

// The file as the editor takes it, or why it cannot: too big, binary, not UTF-8.
async function loadFile($: EngineInterface, path: string): Promise<OpenFile | string> {
  const full = fullPath(path)
  const stat = await $.fs.stat(full).catch(() => undefined)
  if (!stat || stat.kind !== 'file') return `${path} is not a file to open`
  if (stat.size > MAX_EDIT_BYTES) return `${path} is too big to edit here (${Math.round(stat.size / 1024)} KB)`
  const raw = await $.fs.read(full).catch(() => undefined)
  if (raw === undefined) return `${path} could not be read`
  const decoded = decodeText(raw)
  if (typeof decoded === 'string') return `${path} ${decoded}`
  return { path, ...decoded, mtimeMs: stat.mtimeMs, version: 0 }
}

// The editor starts over from this file: what was typed into another is gone.
async function setOpened($: EngineInterface, file: OpenFile, message = '') {
  rt.text = undefined
  rt.isTooLong = false
  rt.isCloseArmed = false
  await update($, opened, now => ({ ...file, version: (now?.version ?? 0) + 1 }))
  await update($, draft, () => null)
  await update($, editStatus, () => ({ ...CLEAN, message }))
}

// The editor's text as it posted it: unsaved while it differs from the file's, kept for a reload. A post
// with the text as it was (a click, a move) changes nothing.
async function takeText($: EngineInterface, text: string) {
  const file = await read($, opened)
  if (!file || text === (rt.text ?? file.text)) return
  rt.text = text === file.text ? undefined : text
  rt.isCloseArmed = false
  const isDirty = rt.text !== undefined
  if (!isDirty) await update($, draft, () => null) // undone back to the file's: no draft to come back
  if ((await read($, editStatus)).isDirty !== isDirty) await update($, editStatus, s => ({ ...s, isDirty, message: '' }))
  if (rt.isDraftDue || !rt.soon) return
  rt.isDraftDue = true
  rt.soon(DRAFT_MS, 'draft')
}

// Writes the text, unless the file changed on disk since it was read (Claude's edit, another editor's):
// then it asks first, Overwrite or Reload. `text` undefined is nothing changed.
async function save($: EngineInterface, text: string | undefined, isForced: boolean) {
  const file = await read($, opened)
  if (!file) return
  if (rt.isTooLong) {
    await update($, editStatus, s => ({ ...s, message: 'Not saved: too long to save from this pane.' }))
    return
  }
  if (text === undefined && !isForced) {
    await update($, editStatus, s => ({ ...s, message: 'No changes to save.' }))
    return
  }
  const body = text ?? file.text
  const full = fullPath(file.path)
  rt.isSaving = true
  try {
    const onDisk = await $.fs.stat(full).catch(() => undefined)
    if (!isForced && onDisk && onDisk.mtimeMs !== file.mtimeMs) {
      await update($, editStatus, s => ({ ...s, isChangedOnDisk: true, message: 'Not saved: it changed on disk since it was read. Overwrite it, or Reload to take what is on disk.' }))
      return
    }
    await $.fs.write(full, encodeText(body, file.eol, file.hasBom))
    const after = await $.fs.stat(full).catch(() => undefined)
    const savedAt = await $.clock.now()
    await update($, opened, now => (now && now.path === file.path ? { ...now, text: body, mtimeMs: after?.mtimeMs ?? now.mtimeMs } : now))
    // What was typed after the text this save carries is still unsaved.
    const isDirty = rt.text !== undefined && rt.text !== body
    if (!isDirty) {
      rt.text = undefined
      await update($, draft, () => null)
    }
    rt.isCloseArmed = false
    await update($, editStatus, () => ({ isDirty, isChangedOnDisk: false, savedAt, message: '' }))
    refreshSoon() // git's colour for it
  } catch (err) {
    await update($, editStatus, s => ({ ...s, message: `Not saved: ${(err as Error)?.message ?? String(err)}` }))
  } finally {
    rt.isSaving = false
  }
}

// Revert and Reload: the file as on disk now, what was typed gone.
async function reload($: EngineInterface) {
  const file = await read($, opened)
  if (!file) return
  const loaded = await loadFile($, file.path)
  if (typeof loaded === 'string') {
    await update($, editStatus, s => ({ ...s, message: loaded }))
    return
  }
  await setOpened($, loaded)
}

// The open file changed on disk: a clean editor takes it, one with unsaved changes says so (and its
// save asks first). Gone from the disk, a save of unsaved changes writes it again.
async function checkOnDisk($: EngineInterface) {
  const file = await read($, opened)
  if (!file || rt.isSaving) return
  const stat = await $.fs.stat(fullPath(file.path)).catch(() => undefined)
  if (!stat) {
    const message = (await read($, editStatus)).isDirty ? 'Deleted on disk: Save writes it again.' : 'Deleted on disk.'
    await update($, editStatus, s => (s.message === '' ? { ...s, message } : s))
    return
  }
  if (stat.mtimeMs === file.mtimeMs) return
  if ((await read($, editStatus)).isDirty) {
    await update($, editStatus, s => ({ ...s, isChangedOnDisk: true }))
    return
  }
  const loaded = await loadFile($, file.path)
  if (typeof loaded === 'string') await update($, editStatus, s => ({ ...s, message: loaded }))
  else await setOpened($, loaded, 'Reloaded: it changed on disk.')
}

// Close over unsaved changes asks first: once more discards them, and the tree is back. `← Files`, or the
// pane closed by its own mark, keeps the file and what was typed: the editor comes back as it was.
async function closeEditor($: EngineInterface) {
  if ((await read($, editStatus)).isDirty && !rt.isCloseArmed) {
    rt.isCloseArmed = true
    await update($, editStatus, s => ({ ...s, message: 'Unsaved changes: Save them, or press Close again to discard them.' }))
    return
  }
  rt.isCloseArmed = false
  rt.text = undefined
  await update($, isEditing, () => false)
  await update($, opened, () => null)
  await update($, draft, () => null)
  await update($, editStatus, () => CLEAN)
}

// A file's text as the editor takes it: one kind of line end ('\n'), no BOM, and what it had of each to
// write back. Refused, with why: binary (a NUL), not UTF-8 (a character the decoding replaced), or too
// long to cross to the editor whole.
export function decodeText(raw: string): { text: string; eol: '\n' | '\r\n'; hasBom: boolean } | string {
  if (raw.includes('\0')) return 'is a binary file'
  if (raw.includes('�')) return 'is not UTF-8 text: saving it here would change it'
  const hasBom = raw.startsWith('﻿')
  const body = hasBom ? raw.slice(1) : raw
  const text = body.replace(/\r\n?/g, '\n')
  if (JSON.stringify(text).length > MAX_EDIT_JSON) return `is too long to edit here (${text.length} characters)`
  // Mixed, the line end most of its lines have: one stray CRLF does not turn every LF line into one.
  const crlf = body.split('\r\n').length - 1
  return { text, eol: crlf > text.split('\n').length - 1 - crlf ? '\r\n' : '\n', hasBom }
}

// The text as it goes back to disk: its line ends and BOM as the file had them.
export function encodeText(text: string, eol: '\n' | '\r\n', hasBom: boolean) {
  return (hasBom ? '﻿' : '') + (eol === '\n' ? text : text.replace(/\n/g, eol))
}

// One row of the tree: a file or folder, how deep, and whether it is open.
export type TreeRow = { path: string; name: string; depth: number; isDir: boolean; isOpen: boolean }

// The rows of a folder and of each open folder in it, depth first, as listed.
export function treeRows(listings: ReadonlyMap<string, readonly TreeEntry[]>, open: ReadonlySet<string>, dir = '', depth = 0): TreeRow[] {
  const out: TreeRow[] = []
  for (const entry of listings.get(dir) ?? []) {
    const path = join(dir, entry.name)
    const isOpen = entry.isDir && open.has(path)
    out.push({ path, name: entry.name, depth, isDir: entry.isDir, isOpen })
    if (isOpen) out.push(...treeRows(listings, open, path, depth + 1))
  }
  return out
}

// Folders first, then files, each by name ignoring case, as IntelliJ and VS Code order them.
export function sortEntries(list: TreeEntry[]): TreeEntry[] {
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  return [...list].sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : order(a.name.toLowerCase(), b.name.toLowerCase()) || order(a.name, b.name)))
}

// `git status --porcelain=v1 -b -z --ignored` as marks by path from the folder (`prefix`, the folder's
// place in the repository, cut off), and the branch.
export function parseGitStatus(out: string, prefix: string): GitView {
  const parts = out.split('\0')
  const marks = new Map<string, GitMark>()
  let branch = ''
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string
    if (part === '') continue
    if (part.startsWith('## ')) {
      branch = branchOf(part.slice(3))
      continue
    }
    const xy = part.slice(0, 2)
    if (/[RC]/.test(xy)) i++ // the path it was renamed or copied from follows, staged or in the work tree
    const mark = markOf(xy)
    const path = part.slice(3)
    if (mark && path.startsWith(prefix)) marks.set(path.slice(prefix.length), mark)
  }
  return { branch, marks }
}

// "main...origin/main [ahead 1]", "No commits yet on main", "HEAD (no branch)".
export function branchOf(head: string) {
  const unborn = /^(?:No commits yet|Initial commit) on (.+)$/.exec(head)
  if (unborn) return unborn[1] as string
  if (head.startsWith('HEAD (no branch)')) return 'HEAD'
  return (head.split('...')[0] ?? '').split(' ')[0] ?? ''
}

function markOf(xy: string): GitMark | undefined {
  if (xy === '!!') return 'ignored'
  if (xy === '??') return 'untracked'
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'conflicted'
  if (xy[0] === 'A') return 'added'
  if (/[MRTC]/.test(xy)) return 'modified'
  return undefined // deleted: not in the tree
}

// A path's mark: its own, else an ignored or untracked folder's it is in.
export function markFor(marks: ReadonlyMap<string, GitMark>, path: string, isDir: boolean): GitMark | undefined {
  const own = marks.get(isDir ? `${path}/` : path)
  if (own) return own
  const parts = path.split('/')
  for (let n = parts.length - 1; n > 0; n--) {
    const mark = marks.get(`${parts.slice(0, n).join('/')}/`)
    if (mark === 'ignored' || mark === 'untracked') return mark
  }
  return undefined
}

// A folder open or shut, a file by its kind, as IntelliJ's icons tell them apart. Each two cells wide.
export function iconOf(name: string, isDir: boolean, isOpen: boolean): string {
  if (isDir) return isOpen ? '📂' : '📁'
  const lower = name.toLowerCase()
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.') || lower.startsWith('docker-compose')) return '🐳'
  const dot = lower.lastIndexOf('.')
  return (dot >= 0 && ICONS[lower.slice(dot + 1)]) || '📄'
}

const ICONS: Record<string, string> = {
  ...kinds('☕', 'java kt kts groovy scala class'),
  ...kinds('🐘', 'gradle'),
  ...kinds('📜', 'ts tsx js jsx mjs cjs go rs c h cpp hpp cs rb php swift dart lua'),
  ...kinds('🐍', 'py'),
  ...kinds('🔧', 'json jsonc yml yaml toml ini properties xml conf cfg env editorconfig'),
  ...kinds('📝', 'md mdx txt rst adoc'),
  ...kinds('🌐', 'html htm vue svelte'),
  ...kinds('🎨', 'css scss sass less png jpg jpeg gif svg ico webp bmp'),
  ...kinds('📦', 'jar war zip gz tgz tar 7z rar'),
  ...kinds('💻', 'sh bash zsh fish bat cmd ps1'),
  ...kinds('💾', 'sql db sqlite'),
  ...kinds('🔒', 'lock pem key crt'),
}

function kinds(icon: string, extensions: string) {
  return Object.fromEntries(extensions.split(' ').map(ext => [ext, icon]))
}

// The entry a tree path names, from its folder's listing.
function entryAt(path: string): TreeEntry | undefined {
  const cut = path.lastIndexOf('/')
  return rt.listings.get(cut < 0 ? '' : path.slice(0, cut))?.find(entry => entry.name === path.slice(cut + 1))
}

// The first row on screen after a scroll of `by` rows (positive is down): between the tree's start and
// the place where its last row ends a screen of `visible` rows.
export function scrolledTop(top: number, by: number, total: number, visible: number): number {
  return Math.min(Math.max(top + by, 0), Math.max(0, total - Math.max(1, visible)))
}

function join(dir: string, name: string) {
  return dir ? `${dir}/${name}` : name
}

function fullPath(path: string) {
  const root = rt.cwd.replace(/\\/g, '/')
  return path ? `${root}/${path}` : root
}

function isWindowsPath(path: string) {
  return /^[A-Za-z]:[\\/]/.test(path)
}

function extensionOf(path: string) {
  const dot = path.lastIndexOf('.')
  return dot > path.lastIndexOf('/') ? path.slice(dot + 1).toLowerCase() : ''
}

function baseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
