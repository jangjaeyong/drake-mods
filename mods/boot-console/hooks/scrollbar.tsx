// The log's scrollbar, drawn by the surface itself so it can take the pointer: a thumb on a track that
// a press moves to and a drag carries. It posts to the hooks module where the log should stand (`back`,
// lines up from the end) and how many rows the log has on screen (`rows`), which only it can measure.
import type { ClientModule } from 'claude-code'

export type ScrollbarProps = { total: number; back: number }

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
      const at = () => backAt(event.y, Math.max(1, surface.rows), own.props.total)
      if (event.type === 'down' && event.button === 'left') {
        own.isDragging = true
        surface.post({ back: at(), rows: Math.max(1, surface.rows) })
      } else if (event.type === 'move' && own.isDragging) {
        surface.post({ back: at(), rows: Math.max(1, surface.rows) })
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

  const { top, size } = thumb(rows, props.total, props.back)
  return (
    <Box flexDirection="column">
      {Array.from({ length: rows }, (_, i) =>
        size > 0 && i >= top && i < top + size ? <Text>{'█'}</Text> : <Text dimColor>{'│'}</Text>,
      )}
    </Box>
  )
}

export default Scrollbar

// Where the log stands for a press at row `y`: the top row is its first lines, the bottom its end.
export function backAt(y: number, rows: number, total: number): number {
  const most = Math.max(0, total - rows)
  const f = Math.min(Math.max(y / Math.max(1, rows - 1), 0), 1)
  return Math.round((1 - f) * most)
}

// The thumb: its size is the share of the log on screen, its place where that share stands.
// No thumb while the whole log fits.
export function thumb(rows: number, total: number, back: number): { top: number; size: number } {
  const most = Math.max(0, total - rows)
  if (most === 0) return { top: 0, size: 0 }
  const size = Math.min(rows, Math.max(1, Math.round((rows * rows) / total)))
  const top = Math.round((1 - Math.min(back, most) / most) * (rows - size))
  return { top, size }
}
