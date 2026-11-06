import type { ReactElement, ReactNode, Ref } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

/** Frame height under which the tray's cards switch to their compact layout (data-compact on section.frame-tray). */
export const COMPACT_FRAME_HEIGHT = 480
/**
 * A compact frame stays compact until it is this much taller than the threshold. An expanded proposal folds the composer
 * under the frame, which grows the frame by up to ~60 px; without the margin that growth would end compact mode, unfold
 * the composer and shrink the frame again, forever.
 */
export const COMPACT_EXIT_MARGIN = 64
const FrameContext = createContext<{ compact: boolean; announce: ((text: string) => void) | null }>({ compact: false, announce: null })

/** True while the surrounding CanvasFrame is under the compact height (cards fold their body, a proposal may take the stage). */
export function useFrameCompact(): boolean {
  return useContext(FrameContext).compact
}

/**
 * Says a line through the frame's one polite announcer (`tray-announce`), so a card never adds a live region of its
 * own. null outside a CanvasFrame: the caller then keeps its own status role. The function is stable.
 */
export function useFrameAnnounce(): ((text: string) => void) | null {
  return useContext(FrameContext).announce
}

/** Lines already said, keyed by owner (a proposal id) and text, so a remounted card does not say them again (review L-b). */
const saidOnce = new Set<string>()
const SAID_ONCE_MAX = 500

/** Says `text` through the frame's announcer once per `key` and text for the life of the window; null says nothing. */
export function useAnnounceOnce(key: string, text: string | null): void {
  const announce = useFrameAnnounce()
  useEffect(() => {
    if (!text || !announce) return
    const k = JSON.stringify([key, text])
    if (saidOnce.has(k)) return
    // Evict the oldest line only, so cards still mounted do not repeat theirs.
    if (saidOnce.size >= SAID_ONCE_MAX) saidOnce.delete(saidOnce.values().next().value as string)
    saidOnce.add(k)
    announce(text)
  }, [key, text, announce])
}

/** Within this long of the previous line a new one is appended to it, so two lines said together are both heard (review L-a). */
const JOIN_WINDOW_MS = 1000
const JOIN_MAX_CHARS = 600

/** The line to say: `text` alone, or appended to a previous line younger than JOIN_WINDOW_MS. Pure. */
export function joinAnnouncement(prev: { text: string; at: number } | null, text: string, now: number): string {
  if (!prev || !prev.text || now - prev.at >= JOIN_WINDOW_MS) return text
  if (prev.text === text || prev.text.endsWith(` ${text}`)) return prev.text
  const joined = `${prev.text} ${text}`
  return joined.length > JOIN_MAX_CHARS ? text : joined
}


/**
 * Canvas region with named slots. Nothing is positioned over the canvas: every slot is a grid area.
 *
 *   <CanvasFrame>
 *     <FrameToolbar>...</FrameToolbar>   row above the canvas (actions, status pills, run strip)
 *     <FrameStage>...</FrameStage>       the React Flow canvas or an empty state
 *     <FrameTray>...</FrameTray>         decision tray; under the stage, beside it only in a frame of 1100x560 or more.
 *                                        Sets data-compact="true" while the frame is under 480px high (cards read it).
 *     <FrameFooter>...</FrameFooter>     hint row under the stage (the org chart; the run view uses the toolbar legend)
 *   </CanvasFrame>
 *
 * Every slot is optional. FrameTray and FrameToolbar render nothing (no gap) when they have no children.
 * The frame is a container (name "frame"), so layout follows its own width, not the window.
 */
/** An arrival line for assistive tech. `n` changes on every arrival so an identical line is announced again. */
export interface FrameAnnouncement {
  text: string
  n: number
}

/**
 * One persistent, visually hidden polite status region (always mounted, empty when idle). For each announcement the text
 * is cleared and set on the next animation frame, so screen readers see a change in an existing region.
 */
function FrameAnnouncer({ announcement }: { announcement?: FrameAnnouncement }): ReactElement {
  const [text, setText] = useState('')
  const key = announcement ? announcement.n : 0
  useEffect(() => {
    setText('')
    if (!announcement?.text) return undefined
    const id = requestAnimationFrame(() => setText(announcement.text))
    return () => cancelAnimationFrame(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return (
    <p className="sr-only" role="status" aria-live="polite" data-testid="tray-announce">
      {text}
    </p>
  )
}

export function CanvasFrame({
  children,
  frameRef,
  testId,
  announcement
}: {
  children: ReactNode
  frameRef?: Ref<HTMLDivElement>
  testId?: string
  announcement?: FrameAnnouncement
}): ReactElement {
  const inner = useRef<HTMLDivElement | null>(null)
  const [compact, setCompact] = useState(false)
  // The arrival line from the view and lines cards say through useFrameAnnounce share the one announcer: a line said
  // within a second of the previous one is appended to it, otherwise the newest replaces it.
  const seq = useRef(0)
  const [said, setSaid] = useState<FrameAnnouncement | undefined>(undefined)
  const last = useRef<{ text: string; at: number } | null>(null)
  const announce = useCallback((text: string) => {
    if (!text) return
    const now = Date.now()
    const line = joinAnnouncement(last.current, text, now)
    // A line already said within the window is not said again.
    if (last.current && line === last.current.text && now - last.current.at < JOIN_WINDOW_MS) return
    last.current = { text: line, at: now }
    seq.current += 1
    setSaid({ text: line, n: seq.current })
  }, [])
  const arrivalKey = announcement ? announcement.n : 0
  useEffect(() => {
    if (announcement?.text) announce(announcement.text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrivalKey])
  const ctx = useMemo(() => ({ compact, announce }), [compact, announce])
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      inner.current = el
      if (typeof frameRef === 'function') frameRef(el)
      else if (frameRef) (frameRef as { current: HTMLDivElement | null }).current = el
    },
    [frameRef]
  )
  useEffect(() => {
    const el = inner.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const read = (): void => setCompact((was) => el.clientHeight < COMPACT_FRAME_HEIGHT + (was ? COMPACT_EXIT_MARGIN : 0))
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <FrameContext.Provider value={ctx}>
      <div className="canvas canvas-frame" ref={setRef} data-testid={testId}>
        <div className="frame-grid">{children}</div>
        <FrameAnnouncer announcement={said} />
      </div>
    </FrameContext.Provider>
  )
}

function hasContent(children: ReactNode): boolean {
  if (children === null || children === undefined || children === false || children === true || children === '') return false
  if (Array.isArray(children)) return children.some(hasContent)
  return true
}

/** `dense` is the run view's 32px single-line toolbar: metadata at the start, a `.frame-toolbar-end` group at the end. */
export function FrameToolbar({ children, label = 'Canvas toolbar', dense }: { children?: ReactNode; label?: string; dense?: boolean }): ReactElement | null {
  if (!hasContent(children)) return null
  return (
    <div className={dense ? 'frame-toolbar frame-toolbar-dense' : 'frame-toolbar'} role="toolbar" aria-label={label}>
      {children}
    </div>
  )
}

export function FrameStage({ children }: { children?: ReactNode }): ReactElement {
  return <div className="frame-stage">{children}</div>
}

/** Decision tray. `label` names the region for assistive tech; arrivals are announced by CanvasFrame's `announcement`. */
export function FrameTray({
  children,
  label = 'Decisions',
  shortcutHint,
  shortcutKeys
}: {
  children?: ReactNode
  label?: string
  /** Tooltip naming the keyboard shortcut that moves focus into the tray. */
  shortcutHint?: string
  /** `aria-keyshortcuts` value for that shortcut. */
  shortcutKeys?: string
}): ReactElement | null {
  const { compact } = useContext(FrameContext)
  if (!hasContent(children)) return null
  return (
    // tabIndex -1: a programmatic jump can land on the region itself when it holds no button.
    <section className="frame-tray" data-compact={compact ? 'true' : undefined} aria-label={label} tabIndex={-1} title={shortcutHint} aria-keyshortcuts={shortcutKeys}>
      {children}
    </section>
  )
}

export function FrameFooter({ children }: { children?: ReactNode }): ReactElement | null {
  if (!hasContent(children)) return null
  return <div className="frame-footer">{children}</div>
}
