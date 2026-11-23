/**
 * Which keys are down right now, and a way to wait until every key is up.
 *
 * The rule this exists for: no decision is ever answered by a key press that began before the card's action had focus.
 * Enter on a button clicks on keydown and again on every key repeat, so any code that moves focus onto an answering
 * button (a card mounting, the Needs-you jump, a shortcut) while a key is still held would let that held key answer.
 * Such code asks `whenKeysReleased` to do the focus move instead, and meanwhile puts focus somewhere that is not a button.
 */

export interface KeyTracker {
  /** True while at least one key is down. */
  held(): boolean
  /** Runs `fn` now when no key is down, otherwise once every key is up. Returns a cancel function. */
  whenReleased(fn: () => void): () => void
}

interface KeyEventLike {
  code?: string
}

/** A tracker listening on `target` in the capture phase. `blur` clears it: a key released in another window never sends a keyup here. */
export function createKeyTracker(target: EventTarget): KeyTracker {
  const down = new Set<string>()
  const waiting = new Set<() => void>()
  target.addEventListener('keydown', (e) => down.add((e as KeyEventLike).code ?? ''), true)
  target.addEventListener(
    'keyup',
    (e) => {
      down.delete((e as KeyEventLike).code ?? '')
      if (down.size === 0) for (const fn of [...waiting]) fn()
    },
    true
  )
  target.addEventListener('blur', () => down.clear())
  return {
    held: () => down.size > 0,
    whenReleased(fn) {
      if (down.size === 0) {
        fn()
        return () => {}
      }
      const later = (): void => {
        waiting.delete(later)
        fn()
      }
      waiting.add(later)
      return () => {
        waiting.delete(later)
      }
    }
  }
}

const NONE: KeyTracker = { held: () => false, whenReleased: (fn) => (fn(), () => {}) }

/** The window's tracker (no keys are ever held where there is no window: tests, the main process). */
export const keys: KeyTracker = typeof window !== 'undefined' ? createKeyTracker(window) : NONE

/**
 * Whether focus is free for a deferred move: nowhere (null or the body), or still on an element this move itself left
 * it on (the opener that started the jump, or the landing region put there while the key was down). Focus anywhere
 * else means the user went somewhere on their own, and a late move must not take it back.
 */
export function focusIsFree(active: unknown, body: unknown, own: readonly unknown[] = []): boolean {
  return !active || active === body || own.some((o) => o !== null && o !== undefined && o === active)
}
