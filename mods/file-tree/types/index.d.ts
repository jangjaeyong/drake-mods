// A file or folder in a listed folder.
export type TreeEntry = { name: string; isDir: boolean }

// How git sees a path, as the tree colours its name.
export type GitMark = 'modified' | 'added' | 'untracked' | 'ignored' | 'conflicted'

// The file open in the editor pane, as last read from the disk or written to it.
export type OpenFile = {
  path: string // from the session's folder, '/'-separated
  text: string // as on disk, its line ends read as '\n' and a BOM left out
  eol: '\n' | '\r\n' // what its lines end with on disk: a save writes them back so
  hasBom: boolean
  mtimeMs: number // when it last changed on disk, as this mod last saw it
  version: number // bumped when the text is (re)loaded: the editor starts over from it
}

// What the editor pane says of the file.
export type EditStatus = {
  isDirty: boolean // the editor's text differs from the file's
  isChangedOnDisk: boolean // the file changed on disk since it was read: a save asks first
  savedAt: number
  message: string // the last thing to tell, '' for none
}

declare module 'claude-code' {
  interface PluginState {
    'file-tree': {
      expanded: string[] // the open folders, by path from the session's folder ('/'-separated)
      isRootOpen: boolean
      selected: string // the row last pressed, by the same path
      tick: number // bumped to redraw: the listings, git's view and the scrolling live in the module
      file: OpenFile | null
      draft: string | null // the editor's text while it differs from the file's, kept across a reload
      saves: number // the saves the editor has asked for, so each is done once
      wheel: number // the rows the wheel moved over the editor so far: it scrolls by what moved since
      status: EditStatus
      isEditing: boolean // the pane shows the open file's editor, not the tree
    }
  }
}
