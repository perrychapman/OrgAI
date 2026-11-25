import type { ReactElement, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { MessageSquare, Network, Search, SlidersHorizontal, ZoomIn, ZoomOut } from 'lucide-react'
import type { CanvasNodeStyle } from '@shared/types'
import type { AgentCounts, AgentFilterValue } from '../../lib/canvasAgents'
import type { ToolbarPlan } from '../../lib/canvasToolbar'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import { Switch } from '../ui/Switch'
import { AgentFilter } from './AgentFilter'
import { ViewLegend } from './CanvasLegend'
import { StylePanel } from './CanvasStyleButton'
import '../../styles/canvas-settings.css'
import '../../styles/canvas-chrome.css'

/**
 * The view options above the style choices. Focus enters on the first of them: the popover would otherwise land on the
 * checked style preset below and scroll this block out of sight. The panel is still hidden on the first frames (focus() is
 * dropped there), so it retries a few frames until a control really holds focus, once per open.
 */
function ViewRows({ children }: { children: ReactNode }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let frame = 0
    let tries = 0
    const enter = (): void => {
      const root = ref.current
      const panel = root?.closest('[popover]')
      const target = root?.querySelector<HTMLElement>('button:not([disabled]), input:checked, [role=switch]')
      if (!root || !target || !panel) return
      if (panel.contains(document.activeElement) && document.activeElement !== panel) return
      target.focus({ preventScroll: true })
      if (!panel.contains(document.activeElement) && tries++ < 8) frame = requestAnimationFrame(enter)
    }
    frame = requestAnimationFrame(enter)
    return () => cancelAnimationFrame(frame)
  }, [])
  return (
    <div className="canvas-view-rows" ref={ref}>
      {children}
    </div>
  )
}

export interface CanvasViewMenuProps {
  plan: ToolbarPlan
  nodeStyle: CanvasNodeStyle
  counts: AgentCounts
  agentFilter: AgentFilterValue
  onAgentFilter: (value: AgentFilterValue) => void
  onFind: () => void
  fold: { checked: boolean; hidden: number; onChange: () => void }
  zoom: { onOut: () => void; onIn: () => void }
  layout: { conversation: boolean; onToggle: () => void }
}

/**
 * The run canvas toolbar's one "View" menu (docs/design/canvas-toolbar-declutter.md): the options a user touches rarely, or
 * that moved here because the toolbar had no room for them. It is the Canvas style popover (same test ids) with a row of
 * view options above the style choices and the legend below. Which rows show comes from the toolbar plan, so a control is
 * in exactly one place: the row, or this menu.
 */
export function CanvasViewMenu({ plan, nodeStyle, counts, agentFilter, onAgentFilter, onFind, fold, zoom, layout }: CanvasViewMenuProps): ReactElement {
  const icon = plan.view === 'icon'
  return (
    <Popover
      label="View"
      placement="bottom-end"
      triggerClassName="btn ghost sm canvas-style-trigger canvas-view-trigger"
      triggerLabel="View options"
      triggerTitle="View options: layout, zoom, canvas style, legend"
      trigger={
        <>
          <Icon icon={SlidersHorizontal} size="sm" />
          {!icon && <span>View</span>}
        </>
      }
      className="canvas-view-panel"
      testId="canvas-style-popover"
      triggerTestId="canvas-style-button"
    >
      {({ close }) => {
        const rows: ReactElement[] = []
        if (plan.find === 'view') {
          rows.push(
            <div className="canvas-view-row" key="find">
              <Button size="sm" variant="ghost" icon={Search} testId="find-agent" onClick={() => { close(); onFind() }}>
                Find an agent
              </Button>
            </div>
          )
        }
        if (plan.filter === 'view') {
          rows.push(
            <div className="canvas-view-row" key="filter">
              <span className="canvas-view-label">Show</span>
              <AgentFilter value={agentFilter} onChange={onAgentFilter} counts={counts} />
            </div>
          )
        }
        if (plan.zoom === 'fit') {
          rows.push(
            <div className="canvas-view-row" key="zoom" role="group" aria-label="Canvas zoom">
              <Button size="sm" variant="ghost" icon={ZoomOut} onClick={zoom.onOut}>Zoom out</Button>
              <Button size="sm" variant="ghost" icon={ZoomIn} onClick={zoom.onIn}>Zoom in</Button>
            </div>
          )
        }
        if (plan.layoutToggle === 'view') {
          rows.push(
            <div className="canvas-view-row" key="layout">
              <Button
                size="sm"
                variant="ghost"
                icon={layout.conversation ? Network : MessageSquare}
                testId="run-layout-toggle"
                onClick={() => {
                  close()
                  layout.onToggle()
                  // The menu's button leaves with the menu; the toolbar's own toggle takes focus so a keyboard user keeps their place.
                  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>('.frame-toolbar [data-testid=run-layout-toggle]')?.focus({ preventScroll: true })))
                }}
              >
                {layout.conversation ? 'Show agents' : 'Show conversation in the stage'}
              </Button>
            </div>
          )
        }
        if (plan.hideFinished) {
          rows.push(
            <div className="canvas-view-row" data-testid="view-fold-row" key="fold" title="Folds finished agents into one node under the agent still shown above them. Turn off to show every agent; turn on again to fold everything back.">
              <span className="canvas-view-label" data-testid="view-fold-label" aria-hidden="true">
                Hide finished agents{fold.checked && fold.hidden ? ` (${fold.hidden})` : ''}
              </span>
              <Switch
                checked={fold.checked}
                onChange={fold.onChange}
                label="Hide finished agents"
                title={fold.checked && fold.hidden ? `Hide finished agents (${fold.hidden} hidden)` : 'Hide finished agents'}
              />
            </div>
          )
        }
        return (
          <StylePanel
            close={close}
            withPresentation={false}
            heading="View"
            foldStyles
            lead={rows.length > 0 ? <ViewRows>{rows}</ViewRows> : undefined}
            tail={plan.legend ? <ViewLegend nodeStyle={nodeStyle} /> : undefined}
          />
        )
      }}
    </Popover>
  )
}
