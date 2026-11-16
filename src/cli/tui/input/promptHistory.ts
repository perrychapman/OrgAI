/**
 * The composer's prompt history (Up / Down at the first / last line of the buffer). Pure and immutable. The draft the
 * user was typing is kept at the bottom of the history: Down past the newest entry brings it back.
 */
import { EMPTY_BUFFER, type TextBuffer } from './textBuffer'

export const HISTORY_MAX = 200

export interface PromptHistory {
  readonly entries: readonly string[]
  /** Index of the entry being shown, or -1 when the user is on their own draft. */
  readonly index: number
  /** The draft to restore when browsing ends. */
  readonly draft: string
}

export const EMPTY_HISTORY: PromptHistory = { entries: [], index: -1, draft: '' }

const atEnd = (text: string): TextBuffer => ({ text, cursor: text.length })

/** A submitted prompt: appended (a repeat of the newest is not), browsing ends. */
export function pushHistory(h: PromptHistory, text: string): PromptHistory {
  const t = text.trim()
  if (t === '') return { ...h, index: -1, draft: '' }
  const entries = h.entries[h.entries.length - 1] === t ? h.entries : [...h.entries, t].slice(-HISTORY_MAX)
  return { entries, index: -1, draft: '' }
}

/** Up (older). Null when there is nothing older (or no history): the caller leaves the key alone. */
export function historyPrev(h: PromptHistory, b: TextBuffer): { history: PromptHistory; buffer: TextBuffer } | null {
  if (h.entries.length === 0) return null
  // Editing a shown entry starts a new browse from the newest, with the edited text as the draft.
  const browsing = h.index >= 0 && h.entries[h.index] === b.text
  const from = browsing ? h.index : h.entries.length
  if (from <= 0) return null
  const index = from - 1
  return { history: { entries: h.entries, index, draft: browsing ? h.draft : b.text }, buffer: atEnd(h.entries[index]) }
}

/** Down (newer, then the draft). Null when not browsing. */
export function historyNext(h: PromptHistory, b: TextBuffer): { history: PromptHistory; buffer: TextBuffer } | null {
  if (h.index < 0 || h.entries[h.index] !== b.text) return null
  if (h.index >= h.entries.length - 1) return { history: { entries: h.entries, index: -1, draft: '' }, buffer: atEnd(h.draft) }
  const index = h.index + 1
  return { history: { entries: h.entries, index, draft: h.draft }, buffer: atEnd(h.entries[index]) }
}

/** Per-run drafts: switching runs saves the text under the old key and loads the new key's. */
export class DraftStore {
  private readonly drafts = new Map<string, string>()
  save(key: string, text: string): void {
    this.drafts.delete(key)
    if (text !== '') this.drafts.set(key, text)
    // Bounded: a long session over many runs keeps only the newest drafts.
    while (this.drafts.size > 50) this.drafts.delete(this.drafts.keys().next().value as string)
  }
  load(key: string): TextBuffer {
    const text = this.drafts.get(key)
    return text === undefined ? EMPTY_BUFFER : atEnd(text)
  }
}
