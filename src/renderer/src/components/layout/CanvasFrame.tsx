import type { ReactElement, ReactNode, Ref } from 'react'

/**
 * Canvas region with named slots. Nothing is positioned over the canvas: every slot is a grid area.
 *
 *   <CanvasFrame>
 *     <FrameToolbar>...</FrameToolbar>   row above the canvas (actions, status pills, run strip)
 *     <FrameStage>...</FrameStage>       the React Flow canvas or an empty state
 *     <FrameTray>...</FrameTray>         docked decision tray; below the stage, beside it from 900px of frame width
 *     <FrameFooter>...</FrameFooter>     legend or hint row under the stage
 *   </CanvasFrame>
 *
 * Every slot is optional. FrameTray and FrameToolbar render nothing (no gap) when they have no children.
 * The frame is a container (name "frame"), so layout follows its own width, not the window.
 */
export function CanvasFrame({ children, frameRef, testId }: { children: ReactNode; frameRef?: Ref<HTMLDivElement>; testId?: string }): ReactElement {
  return (
    <div className="canvas canvas-frame" ref={frameRef} data-testid={testId}>
      <div className="frame-grid">{children}</div>
    </div>
  )
}

function hasContent(children: ReactNode): boolean {
  if (children === null || children === undefined || children === false || children === true || children === '') return false
  if (Array.isArray(children)) return children.some(hasContent)
  return true
}

export function FrameToolbar({ children, label = 'Canvas toolbar' }: { children?: ReactNode; label?: string }): ReactElement | null {
  if (!hasContent(children)) return null
  return (
    <div className="frame-toolbar" role="toolbar" aria-label={label}>
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
  if (!hasContent(children)) return null
  return (
    // tabIndex -1: a programmatic jump can land on the region itself when it holds no button.
    <section className="frame-tray" aria-label={label} aria-live="polite" tabIndex={-1} title={shortcutHint} aria-keyshortcuts={shortcutKeys}>
      {children}
    </section>
  )
}

export function FrameFooter({ children }: { children?: ReactNode }): ReactElement | null {
  if (!hasContent(children)) return null
  return <div className="frame-footer">{children}</div>
}
