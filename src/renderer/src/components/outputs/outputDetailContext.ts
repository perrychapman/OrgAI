// The shared state of one shown output (docs/design/outputs-2.md sections 7, 9, 11, 12): OutputDetail (S3) and
// OutputViewer (S4) each provide one; the editor, notes, compare, revise and slide components read it. Keep this file
// the only seam between the shell and those features: a field is added here first, then provided by OutputDetail.
import { createContext, useContext } from 'react'
import type { OutputNote, OutputNoteAnchor, OutputVersion, RunOutput, SlideBox } from '@shared/types'

/** What a note or a "The part I selected" revise attaches to right now, with its words for the UI. */
export interface OutputSelection {
  anchor: OutputNoteAnchor
  /** "“Tighten the summary…”", "Cells B2:C4 on Budget", "Slide 3, box" (lib/outputNotes.ts anchorDescription). */
  description: string
}

/** How the Revise dialog opens (section 11.4). Missing fields take the dialog's defaults. */
export interface ReviseInit {
  scope?: 'whole' | 'selection' | 'notes'
  /** A selection to offer as "The part I selected" (else the context's current selection is used). */
  selection?: OutputSelection | null
  noteIds?: string[]
  instruction?: string
}

export type OutputDetailMode = 'preview' | 'edit' | 'compare'
export type OutputDetailTab = 'preview' | 'versions' | 'notes'
export type RegionTool = 'off' | 'box' | 'ellipse'

export interface OutputDetailValue {
  output: RunOutput
  /** 'detail' = the panel (S3), 'viewer' = the Larger view (S4). */
  surface: 'detail' | 'viewer'
  /** The version shown (the current one unless the user picked an older one). */
  version: number
  /** output.version (1 when absent). */
  currentVersion: number
  isCurrent: boolean
  /** null = back to the current version. */
  setVersion(n: number | null): void
  /** outputs:versions, newest first; null while loading or after a failure. */
  versions: OutputVersion[] | null
  reloadVersions(): void
  /** outputs:notes of every version, oldest first; null while loading. */
  notes: OutputNote[] | null
  reloadNotes(): void

  tab: OutputDetailTab
  setTab(tab: OutputDetailTab): void
  mode: OutputDetailMode
  /** Compare's two versions (mode 'compare'). */
  compare: { a: number; b: number } | null
  /** Asks first when the editor is dirty (section 9 dirty guard); resolves false when the user cancelled. */
  setMode(mode: OutputDetailMode, compare?: { a: number; b: number }): Promise<boolean>

  /** The editor reports unsaved changes here; the shell guards selection, tab, close and prev / next with it. */
  dirty: boolean
  setDirty(dirty: boolean): void
  /** The editor registers how to save, so the guard's "Save" and the revise dialog's "Save your edits first" can run it. */
  registerSave(save: (() => Promise<boolean>) | null): void
  /** Ask "Save your changes to <title> first?" when dirty; resolves true when it is fine to leave. */
  guard(): Promise<boolean>

  /** The current text / cell / region selection in the preview (notes and revise read it). */
  selection: OutputSelection | null
  setSelection(sel: OutputSelection | null): void
  /** The region tool (slides, image, svg, diagram). */
  regionTool: RegionTool
  setRegionTool(tool: RegionTool): void
  /** A note to bring into view in the preview (Show in output); views scroll to and select its anchor. */
  shownNote: string | null
  showNote(noteId: string | null): void

  /** Speak through the surface's one `output-live` region (polite). */
  announce(text: string): void
  /** Open the Revise dialog (section 11.4). */
  openRevise(init?: ReviseInit): void
}

export const OutputDetailContext = createContext<OutputDetailValue | null>(null)

/** The shown output's shared state, or null outside a detail / viewer (a preview drawn elsewhere: thumbnails, compare panes). */
export function useOutputDetail(): OutputDetailValue | null {
  return useContext(OutputDetailContext)
}

/** Notes of one version, oldest first, in the order the Notes list numbers its pins. */
export function notesOfVersion(notes: readonly OutputNote[] | null, version: number): OutputNote[] {
  return (notes ?? []).filter((n) => n.version === version)
}

/** The visible part of a drawing in fractions (for the region tool's default box). */
export type VisibleBox = SlideBox
