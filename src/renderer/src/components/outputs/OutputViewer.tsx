// The Larger view (S4, docs/design/outputs-2.md 1, 11.3, 14.3): a Dialog near the full window with the same detail body,
// its own context (surface 'viewer', same shared state), one `output-live` region and the notes drawer. OutputDetail owns
// the state and hands the pieces over; this file is the shell around them.
import type { ReactElement, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquareText } from 'lucide-react'
import { showHidden, hasHidden } from '../../lib/hiddenChars'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import NotesPanel from './NotesPanel'
import { OutputDetailContext, type OutputDetailValue } from './outputDetailContext'
import '../../styles/outputs.css'
import '../../styles/outputs-versions.css'

/** Under this viewer width the drawer overlays the content and starts closed. */
export const DRAWER_OVERLAY_PX = 900

export interface OutputViewerProps {
  /** The detail's shared state; the viewer provides it again as surface 'viewer' with its own announce. */
  value: OutputDetailValue
  onClose(): void
  full: boolean
  /** The live region's text (shared with the detail; only one region is mounted at a time). */
  live: string
  /** Meta line and version select. */
  head: ReactNode
  /** Banners, toolbar, status lines, tabs. */
  tools: ReactNode
  /** The preview, editor, compare or versions. */
  body: ReactNode
  /** The surface's last notice (visible text). */
  notice: string
}

export default function OutputViewer({ value, onClose, full, live, head, tools, body, notice }: OutputViewerProps): ReactElement {
  const { output } = value
  const ctx = useMemo<OutputDetailValue>(() => ({ ...value, surface: 'viewer' }), [value])
  const shell = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const openNotes = output.openNoteCount ?? 0
  const [drawer, setDrawer] = useState<boolean | null>(null)
  const narrow = width > 0 && width < DRAWER_OVERLAY_PX
  const drawerOpen = drawer ?? (width >= DRAWER_OVERLAY_PX && openNotes > 0)
  const wasOpen = useRef(false)

  useEffect(() => {
    const el = shell.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Focus the drawer heading when the user opens it (not when it is open by default at mount).
  useEffect(() => {
    if (drawerOpen && !wasOpen.current && drawer === true) requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid=output-notes-heading]')?.focus({ preventScroll: true }))
    wasOpen.current = drawerOpen
  }, [drawerOpen, drawer])

  // A notes request from elsewhere (Show in output, the tab) opens the drawer.
  useEffect(() => {
    if (value.tab === 'notes') {
      setDrawer(true)
      value.setTab('preview')
    }
  }, [value])

  const toggle = useCallback(() => setDrawer(!drawerOpen), [drawerOpen])
  return (
    <OutputDetailContext.Provider value={ctx}>
      <Dialog
        open
        onClose={onClose}
        title={showHidden(output.title)}
        description={hasHidden(output.title) ? 'The title has hidden characters, shown written out.' : undefined}
        size="lg"
        testId="output-dialog"
      >
        <div className="output-dialog-body" data-full={full ? 'true' : undefined} data-drawer={drawerOpen ? 'open' : 'closed'} data-narrow={narrow ? 'true' : undefined}>
          {head}
          <div className="output-viewer-toolbar">
            {tools}
            <Button
              size="sm"
              icon={MessageSquareText}
              testId="output-notes-toggle"
              ariaLabel={`${drawerOpen ? 'Hide' : 'Show'} notes${openNotes > 0 ? `, ${openNotes} open` : ''}`}
              onClick={toggle}
              className="output-notes-toggle"
            >
              Notes{openNotes > 0 ? ` (${openNotes})` : ''}
            </Button>
          </div>
          <p className="outputs-notice" data-testid="output-dialog-notice">
            {notice}
          </p>
          <p className="sr-only" role="status" data-testid="output-live">
            {live}
          </p>
          <div className="output-viewer-main" ref={shell}>
            <div className="output-viewer-content">{body}</div>
            {drawerOpen && (
              <aside className="output-notes-drawer-wrap" data-overlay={narrow ? 'true' : undefined} aria-label="Notes">
                <NotesPanel variant="drawer" />
              </aside>
            )}
          </div>
        </div>
      </Dialog>
    </OutputDetailContext.Provider>
  )
}
