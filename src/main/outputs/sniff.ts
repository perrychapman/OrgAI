/**
 * documentReadPlan: what read_document does with a file, decided by the first bytes only (never the extension). Pure, no
 * imports of the document libraries. `head` is the first min(size, DOCUMENT_HEAD_BYTES) bytes, `size` the file's size.
 * A refusal is one plain sentence naming the detected type and what to do next (the tool adds its own prefix).
 */
import { OUTPUT_PPTX_TOTAL_MAX_BYTES, READ_DOCUMENT_MAX_BYTES } from '@shared/types'

export const DOCUMENT_HEAD_BYTES = 4096

/** A compound (OLE2) file is read only this far: enough to find the stream names. */
export const CFB_READ_BYTES = 1024 * 1024

export type ReadPlan =
  | { read: 'zip'; maxBytes: number }
  | { read: 'cfb'; maxBytes: number }
  | { read: 'text'; maxBytes: number; encoding: 'utf8' | 'utf16le' | 'utf16be' }
  | { refused: string }

const PDF_REFUSAL =
  'OrgAI cannot extract text from PDF files yet. If your own Read tool opens PDFs, use it; otherwise ask the user for a .docx or .txt export.'

const imageRefusal = (what: string): ReadPlan => ({
  refused: `This is ${what} image, not a text document. If your own Read tool shows images, use it; otherwise ask the user to describe what it shows.`
})

const archiveRefusal = (what: string): ReadPlan => ({
  refused: `This is ${what} archive, which holds other files and has no text of its own. Ask the user to extract it and name the file inside that you need.`
})

const executableRefusal = (what: string): ReadPlan => ({
  refused: `This is ${what} executable program, not a document. It has no text OrgAI can read.`
})

const mediaRefusal = (what: string): ReadPlan => ({
  refused: `This is ${what} file, which has no text OrgAI can read. Ask the user for a transcript or a description if you need its content.`
})

const ascii = (head: Buffer, at: number, s: string): boolean => head.length >= at + s.length && head.toString('latin1', at, at + s.length) === s
const bytesAt = (head: Buffer, at: number, ...b: number[]): boolean => head.length >= at + b.length && b.every((v, i) => head[at + i] === v)

/** A head cut inside a multi-byte UTF-8 sequence loses that partial tail. */
function withoutPartialTail(head: Buffer): Buffer {
  let i = head.length - 1
  let k = 0
  while (i >= 0 && k < 3 && (head[i] & 0xc0) === 0x80) {
    i--
    k++
  }
  if (i >= 0 && head[i] >= 0xc0) {
    const need = head[i] >= 0xf0 ? 4 : head[i] >= 0xe0 ? 3 : 2
    if (k + 1 < need) return head.subarray(0, i)
  }
  return head
}

function validUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

function ftypRefusal(head: Buffer): ReadPlan | null {
  if (!ascii(head, 4, 'ftyp')) return null
  const brand = head.length >= 12 ? head.toString('latin1', 8, 12) : ''
  if (['heic', 'heix', 'heim', 'heis', 'hevc', 'mif1', 'msf1'].includes(brand)) return imageRefusal('a HEIC')
  if (['avif', 'avis'].includes(brand)) return imageRefusal('an AVIF')
  if (['M4A ', 'M4B ', 'M4P '].includes(brand)) return mediaRefusal('an MP4 audio')
  return mediaRefusal(brand === 'qt  ' ? 'a QuickTime video' : 'an MP4 video')
}

function magicRefusal(head: Buffer, size: number): ReadPlan | null {
  if (ascii(head, 0, '%PDF-')) return { refused: PDF_REFUSAL }
  if (bytesAt(head, 0, 0x89, 0x50, 0x4e, 0x47)) return imageRefusal('a PNG')
  if (bytesAt(head, 0, 0xff, 0xd8, 0xff)) return imageRefusal('a JPEG')
  if (ascii(head, 0, 'GIF87a') || ascii(head, 0, 'GIF89a')) return imageRefusal('a GIF')
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) return imageRefusal('a WebP')
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WAVE')) return mediaRefusal('a WAV audio')
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'AVI ')) return mediaRefusal('an AVI video')
  if (ascii(head, 0, 'BM') && size >= 26 && bytesAt(head, 6, 0, 0, 0, 0)) return imageRefusal('a BMP')
  if (bytesAt(head, 0, 0x49, 0x49, 0x2a, 0x00) || bytesAt(head, 0, 0x4d, 0x4d, 0x00, 0x2a)) return imageRefusal('a TIFF')
  if (bytesAt(head, 0, 0x00, 0x00, 0x01, 0x00)) return imageRefusal('an ICO')
  const ft = ftypRefusal(head)
  if (ft) return ft
  if (bytesAt(head, 0, 0x1f, 0x8b)) return archiveRefusal('a gzip')
  if (bytesAt(head, 0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return archiveRefusal('a 7-Zip')
  if (ascii(head, 0, 'Rar!')) return archiveRefusal('a RAR')
  if (ascii(head, 0, 'BZh') && head.length > 3 && head[3] >= 0x31 && head[3] <= 0x39) return archiveRefusal('a bzip2')
  if (bytesAt(head, 0, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return archiveRefusal('an xz')
  if (bytesAt(head, 0, 0x28, 0xb5, 0x2f, 0xfd)) return archiveRefusal('a Zstandard')
  if (ascii(head, 257, 'ustar')) return archiveRefusal('a tar')
  if (ascii(head, 0, 'MZ') && head.includes(0)) return executableRefusal('a Windows')
  if (bytesAt(head, 0, 0x7f, 0x45, 0x4c, 0x46)) return executableRefusal('a Linux (ELF)')
  if (
    bytesAt(head, 0, 0xfe, 0xed, 0xfa, 0xce) ||
    bytesAt(head, 0, 0xfe, 0xed, 0xfa, 0xcf) ||
    bytesAt(head, 0, 0xce, 0xfa, 0xed, 0xfe) ||
    bytesAt(head, 0, 0xcf, 0xfa, 0xed, 0xfe) ||
    bytesAt(head, 0, 0xca, 0xfe, 0xba, 0xbe)
  ) {
    return executableRefusal('a macOS (Mach-O) or Java')
  }
  if (ascii(head, 0, 'SQLite format 3\0')) return { refused: 'This is a SQLite database, not a document. Ask the user to export the table you need as a CSV file.' }
  if (ascii(head, 0, 'ID3')) return mediaRefusal('an MP3 audio')
  if (ascii(head, 0, 'OggS')) return mediaRefusal('an Ogg audio or video')
  if (ascii(head, 0, 'fLaC')) return mediaRefusal('a FLAC audio')
  if (bytesAt(head, 0, 0x1a, 0x45, 0xdf, 0xa3)) return mediaRefusal('a Matroska or WebM video')
  return null
}

export function documentReadPlan(head: Buffer, size: number): ReadPlan {
  if (size <= 0 || head.length === 0) return { refused: 'This file is empty, so there is nothing to read.' }

  if (bytesAt(head, 0, 0x50, 0x4b, 0x03, 0x04) || bytesAt(head, 0, 0x50, 0x4b, 0x05, 0x06)) {
    if (size > OUTPUT_PPTX_TOTAL_MAX_BYTES) {
      return { refused: 'This looks like an Office or zip file, but it is larger than 40 MB, so OrgAI does not read it. Ask the user for a smaller copy or a CSV or text export.' }
    }
    return { read: 'zip', maxBytes: OUTPUT_PPTX_TOTAL_MAX_BYTES }
  }
  if (bytesAt(head, 0, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return { read: 'cfb', maxBytes: CFB_READ_BYTES }

  // Byte order marks come before the binary checks: UTF-16 text is full of NUL bytes.
  if (bytesAt(head, 0, 0xef, 0xbb, 0xbf)) return { read: 'text', maxBytes: READ_DOCUMENT_MAX_BYTES + 4, encoding: 'utf8' }
  // UTF-16 can need two bytes per character to give the same UTF-8 output, so it reads twice as far.
  if (bytesAt(head, 0, 0xff, 0xfe)) return { read: 'text', maxBytes: (READ_DOCUMENT_MAX_BYTES + 4) * 2, encoding: 'utf16le' }
  if (bytesAt(head, 0, 0xfe, 0xff)) return { read: 'text', maxBytes: (READ_DOCUMENT_MAX_BYTES + 4) * 2, encoding: 'utf16be' }

  const refusal = magicRefusal(head, size)
  if (refusal) return refusal

  const complete = head.length >= size
  const checked = complete ? head : withoutPartialTail(head)
  if (!checked.includes(0) && validUtf8(checked)) return { read: 'text', maxBytes: READ_DOCUMENT_MAX_BYTES + 4, encoding: 'utf8' }

  return {
    refused: 'This looks like a binary file of an unknown type, so OrgAI cannot read it as text. Ask the user what it is, or for a .docx, .xlsx, .pptx, .csv or .txt version.'
  }
}
