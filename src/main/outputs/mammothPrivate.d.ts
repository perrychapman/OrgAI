// Private mammoth modules the docx preview uses to learn which parts mammoth will read (pinned to mammoth 1.13.0, see preview.ts).
declare module 'mammoth/lib/docx/docx-reader.js' {
  export function _findPartPaths(zipfile: unknown): PromiseLike<Record<string, string>>
}
declare module 'mammoth/lib/zipfile.js' {
  export function openArrayBuffer(buf: ArrayBuffer | Uint8Array | Buffer): PromiseLike<unknown>
}
