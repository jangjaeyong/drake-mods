// The tree's scrollbar, drawn by the surface itself so it can take the pointer: a thumb on a track that
// a press moves to and a drag carries. The tree reads from the top, so it posts `top`, the first row
// on screen, and `rows`, how many rows the tree has on screen.
import type { ClientModule } from 'claude-code'

export type ScrollbarProps = { total: number; top: number }

// Held across draws: the latest props for the pointer listener, set once, and what was last reported.
type Holder = { props: ScrollbarProps; isDragging: boolean; reportedRows: number }

const Scrollbar: ClientModule<ScrollbarProps, Holder> = (props, surface) => {
  const { Box, Text } = surface.elements
  const rows = Math.max(1, surface.rows)
  let holder = surface.state
  if (!holder) {
    holder = { props, isDragging: false, reportedRows: 0 }
    surface.setState(holder)
    const own = holder
    surface.onPointer(event => {
      const at = () => topAt(event.y, Math.max(1, surface.rows), own.props.total)
      if (event.type === 'down' && event.button === 'left') {
        own.isDragging = true
        surface.post({ top: at(), rows: Math.max(1, surface.rows) })
      } else if (event.type === 'move' && own.isDragging) {
        surface.post({ top: at(), rows: Math.max(1, surface.rows) })
      } else if (event.type === 'up') {
        own.isDragging = false
      }
    })
  }
  holder.props = props
  if (surface.rows > 0 && holder.reportedRows !== surface.rows) {
    holder.reportedRows = surface.rows
    surface.post({ rows: surface.rows })
  }

  const { start, size } = thumb(rows, props.total, props.top)
  return (
    <Box flexDirection="column">
      {Array.from({ length: rows }, (_, i) =>
        size > 0 && i >= start && i < start + size ? <Text>{'█'}</Text> : <Text dimColor>{'│'}</Text>,
      )}
    </Box>
  )
}

export default Scrollbar

// The first row on screen for a press at row `y`: the top row is the tree's start, the bottom its end.
export function topAt(y: number, rows: number, total: number): number {
  const most = Math.max(0, total - rows)
  const f = Math.min(Math.max(y / Math.max(1, rows - 1), 0), 1)
  return Math.round(f * most)
}

// The thumb: its size is the share of the tree on screen, its place where that share stands.
// No thumb while the whole tree fits.
export function thumb(rows: number, total: number, top: number): { start: number; size: number } {
  const most = Math.max(0, total - rows)
  if (most === 0) return { start: 0, size: 0 }
  const size = Math.min(rows, Math.max(1, Math.round((rows * rows) / total)))
  const start = Math.round((Math.min(top, most) / most) * (rows - size))
  return { start, size }
}
