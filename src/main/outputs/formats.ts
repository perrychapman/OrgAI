// outputs-2 format layer (PHASE-B CONTRACT, filled in by the formats engineer): the pure-ish functions the service
// calls for decks, thumbnails, text-for-agents and compare. Each reads a file by path (the service hands it either the
// checked current file or a snapshot path in OrgAI's data folder) and never throws for a bad file. Electron-free.
import type { OutputDiff, OutputKind, OutputThumb, SlideDeckInput } from '@shared/types'

/** What pptx rendering needs from the caller: image paths go through register_output's confinement (paths.ts checkRegisteredPath). */
export interface DeckImageReader {
  /** Bytes of a deck image after the confinement and type / size checks; throws a plain sentence otherwise. */
  read(path: string): Buffer
}

/**
 * Validate a SlideDeckInput (caps, hidden characters, colours, fonts, layouts) and write the .pptx bytes (own OOXML
 * through jszip; no network, no URL images). Throws a plain sentence on any refusal (the tool prefixes "REFUSED: ").
 */
export async function renderDeck(_deck: SlideDeckInput, _images: DeckImageReader): Promise<Buffer> {
  throw new Error('Decks are not built yet.')
}

/** Thumbnail of a file of `kind` (OutputThumb caps). Never throws: 'none' on any failure. */
export async function thumbForFile(_path: string, _kind: OutputKind): Promise<OutputThumb> {
  return { kind: 'none' }
}

/**
 * A file's text for read_output: documents as Markdown-like text, sheets as tab-separated text per sheet ("## Sheet
 * <name>" headers), decks per slide ("## Slide 3: <title>", text, "Speaker notes: ..."), text kinds as stored. Capped at
 * OUTPUT_TEXT_MAX_BYTES (truncated: true). `refused` for image, pdf, other and unreadable files.
 */
export async function textForAgent(_path: string, _kind: OutputKind): Promise<{ text: string; truncated: boolean } | { refused: string }> {
  return { refused: 'OrgAI cannot read this kind of file as text.' }
}

/** Compare two files of the same kind (A older, B newer). Never throws: { kind: 'none', reason } on failure. */
export async function compareFiles(_a: string, _b: string, _kind: OutputKind): Promise<OutputDiff> {
  return { kind: 'none', reason: 'Compare is not built yet.' }
}
