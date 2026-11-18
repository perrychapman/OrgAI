import type { DocumentText, DocumentWindow } from './readDocument'
import type { ReadPlan } from './sniff'

/**
 * The one queue for heavy document work in the process (previews, comparisons, text for agents, read_document). The
 * previews run on the main thread and one can hold hundreds of MB, so one runs at a time; later calls wait, and a full
 * queue answers `busy` at once. Only types are imported from the document modules: nothing here loads exceljs, mammoth or jszip.
 */

export const PREVIEW_QUEUE_MAX = 8
export const PREVIEW_BUSY = 'Too many previews are loading. Try again in a moment.'
let previewTail: Promise<unknown> = Promise.resolve()
let previewsPending = 0

export function queuedHeavy<T>(run: () => Promise<T>, busy: T): Promise<T> {
  if (previewsPending >= PREVIEW_QUEUE_MAX) return Promise.resolve(busy)
  previewsPending++
  const p = previewTail.then(run)
  previewTail = p.then(
    () => undefined,
    () => undefined
  )
  return p.finally(() => {
    previewsPending--
  })
}

let documentLoad: Promise<typeof import('./readDocument')> | undefined
const documentModule = (): Promise<typeof import('./readDocument')> => (documentLoad ??= import('./readDocument'))

/** read_document's parsing, through the shared queue; { refused: PREVIEW_BUSY } when the queue is full. */
export function documentTextQueued(
  buf: Buffer,
  plan: Exclude<ReadPlan, { refused: string }>,
  window: DocumentWindow,
  fileSize: number
): Promise<DocumentText> {
  return queuedHeavy<DocumentText>(async () => (await documentModule()).documentText(buf, plan, window, fileSize), { refused: PREVIEW_BUSY })
}
