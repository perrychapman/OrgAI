// outputs-2 format layer: the functions the service calls for decks, thumbnails, text-for-agents and compare. Each reads a
// file by path (the service hands it either the checked current file or a snapshot path in OrgAI's data folder) and
// never throws for a bad file. Electron-free. The work lives in pptxWrite.ts, thumb.ts, readText.ts and diff.ts.
import type { OutputDiff, OutputKind, OutputThumb, SlideDeckInput } from '@shared/types'
import { compareFilesImpl } from './diff'
import { renderDeck as renderDeckImpl, type DeckImageReader } from './pptxWrite'
import { textForAgentImpl } from './readText'
import { thumbForFileImpl } from './thumb'

export type { DeckImageReader }

/**
 * Validate a SlideDeckInput (caps, hidden characters, colours, fonts, layouts) and write the .pptx bytes (own OOXML
 * through jszip; no network, no URL images). Throws a plain sentence on any refusal (the tool prefixes "REFUSED: ").
 */
export async function renderDeck(deck: SlideDeckInput, images: DeckImageReader): Promise<Buffer> {
  return renderDeckImpl(deck, images)
}

/** Thumbnail of a file of `kind` (OutputThumb caps). Never throws: 'none' on any failure. */
export async function thumbForFile(path: string, kind: OutputKind): Promise<OutputThumb> {
  return thumbForFileImpl(path, kind)
}

/**
 * A file's text for read_output: documents as Markdown-like text, sheets as tab-separated text per sheet ("## Sheet
 * <name>" headers), decks per slide ("## Slide 3: <title>", text, "Speaker notes: ..."), text kinds as stored. Capped at
 * OUTPUT_TEXT_MAX_BYTES (truncated: true). `refused` for image, pdf, other and unreadable files.
 */
export async function textForAgent(path: string, kind: OutputKind): Promise<{ text: string; truncated: boolean } | { refused: string }> {
  return textForAgentImpl(path, kind)
}

/** Compare two files of the same kind (A older, B newer). Never throws: { kind: 'none', reason } on failure. */
export async function compareFiles(a: string, b: string, kind: OutputKind): Promise<OutputDiff> {
  return compareFilesImpl(a, b, kind)
}
