import type { ReactElement, ReactNode, Ref } from 'react'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

/** Frame height under which the tray's cards switch to their compact layout (data-compact on section.frame-tray). */
export const COMPACT_FRAME_HEIGHT = 480
const FrameContext = createContext({ compact: false })


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
export function CanvasFrame({ children, frameRef, testId }: { children: ReactNode; frameRef?: Ref<HTMLDivElement>; testId?: string }): ReactElement {
  const inner = useRef<HTMLDivElement | null>(null)
  const [compact, setCompact] = useState(false)
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
    const read = (): void => setCompact(el.clientHeight < COMPACT_FRAME_HEIGHT)
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <FrameContext.Provider value={{ compact }}>
      <div className="canvas canvas-frame" ref={setRef} data-testid={testId}>
        <div className="frame-grid">{children}</div>
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

/** Decision tray. `label` names the region for assistive tech; content is announced politely. */
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
    <section className="frame-tray" data-compact={compact ? 'true' : undefined} aria-label={label} aria-live="polite" tabIndex={-1} title={shortcutHint} aria-keyshortcuts={shortcutKeys}>
      {children}
    </section>
  )
}

export function FrameFooter({ children }: { children?: ReactNode }): ReactElement | null {
  if (!hasContent(children)) return null
  return <div className="frame-footer">{children}</div>
}
