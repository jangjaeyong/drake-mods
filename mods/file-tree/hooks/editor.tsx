// The editor: a file's text, drawn and edited by the surface itself so it can take the keys. Enter breaks
// the line, Ctrl+S saves, Alt+V pastes the clipboard, Ctrl+Z undoes; a press
// puts the cursor where it lands. Each post to the hooks module carries all it knows (the whole text, how many saves were asked so
// far, the last paste taken in), so a post that a later one replaced within a frame loses no edit and no
// save. A new `version` starts it over from `text`, and each post names the version it edits.
import type { ClientKeyEvent, ClientModule, ClientSurface } from 'claude-code'

export type EditorProps = {
  text: string // the file's text, or the unsaved draft the pane kept
  version: number // bumped when the file is (re)loaded: the editor starts over from `text`
  saves: number // the saves asked so far, so a new instance counts on from there
  wheel: number // the wheel's rows so far: the editor scrolls by what it moved since
  paste: { seq: number; text: string } // the latest text the pane read from the clipboard for it
}

// A text being edited: its lines, and the cursor, a line and a character (code point) in it.
export type Doc = { lines: string[]; row: number; col: number }
type Snapshot = Doc

// Held across draws: the latest props for the listeners, set once, and the text being edited.
type Holder = {
  props: EditorProps
  version: number
  doc: Doc
  goal: number // the column in cells an up or down move aims for
  top: number // the first line on screen
  left: number // the first character on screen of every line
  wheel: number
  saves: number
  pasted: number // the last paste taken in, by its `seq`
  undo: Snapshot[]
  redo: Snapshot[]
  lastEdit: '' | 'type' | 'edit' // consecutive typing is one undo step
  indent: string // what Tab inserts, as the file indents
  message: string
}

const TAB = 4 // cells a tab is drawn as
const MAX_UNDO = 100
const MAX_POST = 95_000 // a post is refused past 100,000 characters; the text's escapes count
const SPECIAL = new Set(['up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete', 'pageup', 'pagedown', 'home', 'end', 'escape', 'insert', 'space'])

const Editor: ClientModule<EditorProps, Holder> = (props, surface) => {
  const { Box, Text } = surface.elements
  let holder = surface.state
  if (!holder) {
    holder = start(props)
    surface.setState(holder)
    const own = holder
    surface.onKey(event => {
      const rows = Math.max(1, surface.rows - (own.message ? 1 : 0))
      own.message = ''
      const r = applyKey(own, event, rows)
      if (r === 'unknown') return
      settle(own, surface, rows, r)
      surface.setState(own)
    })
    surface.onPointer(event => {
      if (event.type !== 'down' || event.button !== 'left') return
      const gutter = gutterOf(own.doc.lines.length)
      const row = Math.min(own.doc.lines.length - 1, own.top + Math.max(0, event.y))
      const line = own.doc.lines[row] ?? ''
      own.doc = { ...own.doc, row, col: colAt(line, own.left, event.x - gutter) }
      own.goal = cellsTo(line, own.doc.col)
      own.lastEdit = ''
      surface.setState(own)
    })
  }
  holder.props = props
  if (props.version !== holder.version) {
    // Loaded again (a reload, a Revert): the text starts over, the cursor kept where it still fits.
    const fresh = start(props)
    const row = Math.min(holder.doc.row, fresh.doc.lines.length - 1)
    const col = Math.min(holder.doc.col, chars(fresh.doc.lines[row] ?? '').length)
    Object.assign(holder, fresh, { doc: { ...fresh.doc, row, col }, top: holder.top, saves: Math.max(holder.saves, props.saves) })
  }
  const rows = Math.max(1, surface.rows - (holder.message ? 1 : 0))
  // The wheel moves the view, not the cursor, down to where the last line ends the screen.
  if (props.wheel !== holder.wheel) {
    holder.top = Math.min(Math.max(0, holder.top + props.wheel - holder.wheel), Math.max(0, holder.doc.lines.length - rows))
    holder.wheel = props.wheel
  }
  // A paste reaches the prompt box, not this: the pane takes it from there and hands it on here.
  if (props.paste.seq !== holder.pasted) {
    holder.pasted = props.paste.seq
    const text = props.paste.text.replace(/\r\n?/g, '\n')
    edit(holder, 'edit', doc => insertText(doc, text))
    settle(holder, surface, rows, 'handled')
  }
  const gutter = gutterOf(holder.doc.lines.length)
  const width = textColumns(surface.columns, holder.doc.lines.length)
  const shown = holder.doc.lines.slice(holder.top, holder.top + rows)
  return (
    <Box flexDirection="column">
      {shown.map((line, i) => {
        const n = holder.top + i
        const isCursorLine = n === holder.doc.row
        const parts = slice(line, holder.left, width, isCursorLine ? holder.doc.col : -1)
        return (
          <Box flexDirection="row" height={1} overflow="hidden">
            <Text dimColor={!isCursorLine}>{`${String(n + 1).padStart(gutter - 1)} `}</Text>
            <Text wrap="truncate-end">
              {parts.before}
              {isCursorLine && <Text inverse>{parts.at}</Text>}
              {parts.after}
            </Text>
          </Box>
        )
      })}
      {holder.message !== '' && <Text color="yellow" wrap="truncate-end">{holder.message}</Text>}
    </Box>
  )
}

export default Editor

// After a key or a paste: the view follows the cursor, and the editor reports. Alt+V asks the pane for the
// clipboard, whose text comes back as `paste`.
function settle(h: Holder, surface: ClientSurface<Holder>, rows: number, done: 'handled' | 'save' | 'paste') {
  const view = follow(h, rows, textColumns(surface.columns, h.doc.lines.length))
  h.top = view.top
  h.left = view.left
  if (done === 'save') h.saves++
  const paste = done === 'paste'
  // A text too long to cross is left out, and the editor says so.
  const text = h.doc.lines.join('\n')
  if (text.length > MAX_POST / 2 && JSON.stringify(text).length > MAX_POST) {
    h.message = 'Too long to keep or save from this pane: shorten it, or edit it elsewhere.'
    surface.post({ version: h.version, saves: h.saves, pasted: h.pasted, paste })
  } else surface.post({ text, version: h.version, saves: h.saves, pasted: h.pasted, paste })
}

function start(props: EditorProps): Holder {
  const lines = props.text.split('\n')
  return {
    props,
    version: props.version,
    doc: { lines, row: 0, col: 0 },
    goal: 0,
    top: 0,
    left: 0,
    wheel: props.wheel,
    saves: props.saves,
    pasted: props.paste.seq, // a paste from before this editor was drawn is not taken again
    undo: [],
    redo: [],
    lastEdit: '',
    indent: indentOf(lines),
    message: '',
  }
}

// What a key does to the editor: an edit or a move, a save, a paste asked for, or nothing it knows. Ctrl+V
// is left to the terminal, which pastes with it or with another key (Ctrl+Shift+V, Cmd+V) into the prompt box.
export function applyKey(h: Holder, pressed: ClientKeyEvent, rows: number): 'handled' | 'save' | 'paste' | 'unknown' {
  const event = keyOf(pressed)
  const key = event.key
  const lower = key.toLowerCase()
  if ((event.ctrl || event.meta) && lower === 's') return 'save'
  if (event.meta && !event.ctrl && lower === 'v') return 'paste'
  if (event.ctrl && lower === 'z' && !event.shift) restore(h, h.undo, h.redo)
  else if (event.ctrl && (lower === 'y' || (lower === 'z' && event.shift))) restore(h, h.redo, h.undo)
  else if (key === 'return' || key === 'enter' || (event.ctrl && lower === 'j')) edit(h, 'edit', doc => insertText(doc, `\n${leadingSpace(doc.lines[doc.row] ?? '', doc.col)}`))
  else if (key === 'backspace') edit(h, 'edit', backspace)
  else if (key === 'delete') edit(h, 'edit', deleteForward)
  else if (key === 'tab' && !event.shift) edit(h, 'edit', doc => insertText(doc, h.indent))
  else {
    const moved = move(h, key, !!event.ctrl, rows)
    if (moved) {
      h.doc = moved
      if (key !== 'up' && key !== 'down' && key !== 'pageup' && key !== 'pagedown') h.goal = cellsTo(h.doc.lines[h.doc.row] ?? '', h.doc.col)
      h.lastEdit = ''
    } else if (event.ctrl || event.meta || (SPECIAL.has(lower) && key !== 'space') || isUnnamed(key)) return 'unknown'
    else {
      // Typed text: a character, a word an input method committed, or a paste.
      const text = key === 'space' ? ' ' : key.replace(/\r\n?/g, '\n')
      edit(h, chars(text).length === 1 && text !== ' ' ? 'type' : 'edit', doc => insertText(doc, text))
    }
  }
  return 'handled'
}

// A key that comes unnamed, as the terminal's own sequence (F5 as `\x1b[15~`, Insert as `\x1b[2~`), or as a
// function key's name: no text to type.
function isUnnamed(key: string) {
  return key.includes('\x1b') || /^f\d{1,2}$/.test(key)
}

// A key as named, whichever way the terminal sent it: Ctrl+S may come as the control character it
// types (\x13) rather than `s` with ctrl, Enter as \r, Ctrl+J as \n.
export function keyOf(event: ClientKeyEvent): ClientKeyEvent {
  const k = event.key
  if (k === '\r' || k === '\n') return { ...event, key: 'return' }
  if (k === '\t') return { ...event, key: 'tab' }
  if (k === '\b' || k === '\x7f') return { ...event, key: 'backspace' }
  if (k.length === 1 && k.charCodeAt(0) < 32) return { ...event, key: String.fromCharCode(k.charCodeAt(0) + 96), ctrl: true }
  return event
}

// Runs an edit, keeping what was before it for Ctrl+Z: a run of typing is one step.
function edit(h: Holder, kind: 'type' | 'edit', change: (doc: Doc) => Doc) {
  const next = change(h.doc)
  if (next === h.doc) return
  if (kind !== 'type' || h.lastEdit !== 'type') {
    h.undo = [...h.undo, h.doc].slice(-MAX_UNDO)
    h.redo = []
  }
  h.doc = next
  h.goal = cellsTo(next.lines[next.row] ?? '', next.col)
  h.lastEdit = kind
}

// Ctrl+Z from `from` (the undo steps), what it leaves pushed onto `to`; Ctrl+Y the other way.
function restore(h: Holder, from: Snapshot[], to: Snapshot[]) {
  const back = from.pop()
  if (!back) return
  to.push(h.doc)
  h.doc = back
  h.goal = cellsTo(back.lines[back.row] ?? '', back.col)
  h.lastEdit = ''
}

function move(h: Holder, key: string, isCtrl: boolean, rows: number): Doc | undefined {
  const { lines, row, col } = h.doc
  const line = chars(lines[row] ?? '')
  const at = (r: number) => {
    const to = Math.min(Math.max(r, 0), lines.length - 1)
    return { lines, row: to, col: colAtCells(lines[to] ?? '', h.goal) }
  }
  if (key === 'left') return col > 0 ? { lines, row, col: col - 1 } : row > 0 ? { lines, row: row - 1, col: chars(lines[row - 1] ?? '').length } : h.doc
  if (key === 'right') return col < line.length ? { lines, row, col: col + 1 } : row < lines.length - 1 ? { lines, row: row + 1, col: 0 } : h.doc
  if (key === 'up') return at(row - 1)
  if (key === 'down') return at(row + 1)
  if (key === 'pageup') return at(row - Math.max(1, rows - 1))
  if (key === 'pagedown') return at(row + Math.max(1, rows - 1))
  if (key === 'home') return isCtrl ? { lines, row: 0, col: 0 } : { lines, row, col: 0 }
  if (key === 'end') return isCtrl ? { lines, row: lines.length - 1, col: chars(lines.at(-1) ?? '').length } : { lines, row, col: line.length }
  return undefined
}

// `text` at the cursor, the cursor after it; a newline in it breaks the line.
export function insertText(doc: Doc, text: string): Doc {
  if (text === '') return doc
  const line = chars(doc.lines[doc.row] ?? '')
  const before = line.slice(0, doc.col).join('')
  const after = line.slice(doc.col).join('')
  const added = text.split('\n')
  const lines = [...doc.lines]
  if (added.length === 1) {
    lines[doc.row] = before + text + after
    return { lines, row: doc.row, col: doc.col + chars(text).length }
  }
  const last = added.at(-1) ?? ''
  lines.splice(doc.row, 1, before + (added[0] ?? ''), ...added.slice(1, -1), last + after)
  return { lines, row: doc.row + added.length - 1, col: chars(last).length }
}

// The character before the cursor goes; at a line's start the line joins the one above.
export function backspace(doc: Doc): Doc {
  const lines = [...doc.lines]
  if (doc.col > 0) {
    const line = chars(lines[doc.row] ?? '')
    line.splice(doc.col - 1, 1)
    lines[doc.row] = line.join('')
    return { lines, row: doc.row, col: doc.col - 1 }
  }
  if (doc.row === 0) return doc
  const above = lines[doc.row - 1] ?? ''
  lines.splice(doc.row - 1, 2, above + (lines[doc.row] ?? ''))
  return { lines, row: doc.row - 1, col: chars(above).length }
}

// The character at the cursor goes; at a line's end the next line joins it.
export function deleteForward(doc: Doc): Doc {
  const lines = [...doc.lines]
  const line = chars(lines[doc.row] ?? '')
  if (doc.col < line.length) {
    line.splice(doc.col, 1)
    lines[doc.row] = line.join('')
    return { lines, row: doc.row, col: doc.col }
  }
  if (doc.row >= lines.length - 1) return doc
  lines.splice(doc.row, 2, (lines[doc.row] ?? '') + (lines[doc.row + 1] ?? ''))
  return { lines, row: doc.row, col: doc.col }
}

// The indentation a new line takes from the line it breaks: its leading spaces and tabs, up to the cursor.
export function leadingSpace(line: string, col: number) {
  return (/^[ \t]*/.exec(chars(line).slice(0, col).join(''))?.[0] ?? '')
}

// What Tab inserts: a tab where the file indents with tabs, else its smallest indent of spaces (2 to 8), else 4.
export function indentOf(lines: string[]) {
  let tabs = 0
  let spaces = 0
  let least = 0
  for (const line of lines) {
    if (line.startsWith('\t')) tabs++
    const n = /^ +/.exec(line)?.[0].length ?? 0
    if (n >= 2 && /\S/.test(line)) {
      spaces++
      least = least === 0 ? n : Math.min(least, n)
    }
  }
  if (tabs > spaces) return '\t'
  return ' '.repeat(least >= 2 && least <= 8 ? least : 4)
}

// The view moved just enough to show the cursor: its line among `rows`, its character within `width` cells.
export function follow(h: Pick<Holder, 'doc' | 'top' | 'left'>, rows: number, width: number): { top: number; left: number } {
  const { row, col } = h.doc
  const top = row < h.top ? row : row >= h.top + rows ? row - rows + 1 : h.top
  const line = chars(h.doc.lines[row] ?? '')
  // Back from the cursor, as many characters as fit beside it: the view starts no later than the first of
  // them. One pass, so a long line (a minified file's) moves at once.
  let start = col
  let used = cellOf(line[col] ?? ' ')
  while (start > 0) {
    const size = cellOf(line[start - 1] as string)
    if (used + size > width) break
    used += size
    start--
  }
  return { top, left: Math.max(Math.min(h.left, col), start) }
}

// One line as drawn from character `left` within `width` cells: before the cursor, at it, after it.
// Without a cursor (`col` -1) it is all `before`. Tabs are drawn as spaces, control characters as dots.
export function slice(line: string, left: number, width: number, col: number): { before: string; at: string; after: string } {
  const all = chars(line)
  const out = { before: '', at: col >= 0 ? ' ' : '', after: '' }
  let used = 0
  for (let i = left; i < all.length; i++) {
    const ch = all[i] as string
    const size = cellOf(ch)
    if (used + size > width) break
    const drawn = ch === '\t' ? ' '.repeat(TAB) : /[\x00-\x1f\x7f]/.test(ch) ? '·' : ch
    if (col < 0 || i < col) out.before += drawn
    else if (i === col) out.at = drawn
    else out.after += drawn
    used += size
  }
  return out
}

// The character at `x` cells into the text area of a line scrolled to `left`; past the end, the end.
export function colAt(line: string, left: number, x: number): number {
  const all = chars(line)
  let used = 0
  for (let i = left; i < all.length; i++) {
    const size = cellOf(all[i] as string)
    if (x < used + size) return i
    used += size
  }
  return all.length
}

// The character a line's `cells`th cell falls in, for up and down to keep their column.
export function colAtCells(line: string, cells: number): number {
  return colAt(line, 0, cells)
}

export function cellsTo(line: string, col: number) {
  return widthOf(chars(line).slice(0, col))
}

// The gutter: the line numbers' width and a space.
function gutterOf(lineCount: number) {
  return String(Math.max(1, lineCount)).length + 1
}

function textColumns(columns: number, lineCount: number) {
  return Math.max(1, columns - gutterOf(lineCount))
}

export function chars(text: string): string[] {
  return Array.from(text)
}

function widthOf(list: string[]) {
  return list.reduce((sum, ch) => sum + cellOf(ch), 0)
}

// Hangul, CJK, full-width forms and most emoji take two cells; joiners and marks none; a tab TAB.
const WIDE = /[ᄀ-ᅟ⌚⌛⏩-⏬⏰⏳◽◾☔☕⚡⚪⚫⚽⚾⛄⛅⛔⛪⛲⛳⛵⛺⛽✅✊✋✨❌❎❓-❕❗➕-➗➰➿⬛⬜⭐⭕⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u
const ZERO_WIDTH = /[̀-ͯ​-‍︀-️]/u

export function cellOf(ch: string) {
  if (ch === '\t') return TAB
  return ZERO_WIDTH.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1
}
