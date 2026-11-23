import type { CSSProperties, KeyboardEvent, ReactElement } from 'react'
import { useEffect, useMemo, useRef } from 'react'
import type { CanvasPresentation } from '@shared/types'
import { Check, ChevronDown, Settings2 } from 'lucide-react'
import { useCanvasOptions } from '../../lib/canvas'
import { PRESENTATION_OPTIONS, saveCanvas } from '../../lib/canvasSettings'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'
import { useAppStore } from '../../store/useAppStore'
import { useRovingFocus } from '../connectors/useRovingFocus'
import { useFrameAnnounce } from '../layout/CanvasFrame'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import '../../styles/canvas-chrome.css'

/** How a presentation is named and drawn in the menu. Anything not listed falls back to PRESENTATION_OPTIONS' own words. */
const THEME_LOOK: Partial<Record<CanvasPresentation, { name: string; description: string; swatch: string }>> = {
  graph: { name: 'Org chart', description: 'Roles and reporting lines', swatch: 'linear-gradient(135deg, var(--brand-from), var(--brand-to))' },
  'pocket-office': { name: 'Pocket Office', description: 'One building per team', swatch: 'linear-gradient(135deg, var(--office-color-surface), var(--office-color-border))' },
  'factory-floor': { name: 'Factory floor', description: 'Work moving between stations', swatch: 'linear-gradient(135deg, var(--text-tertiary), var(--warning))' }
}
const FALLBACK_SWATCH = 'linear-gradient(135deg, var(--surface-3), var(--accent))'

export interface CanvasTheme {
  value: CanvasPresentation
  name: string
  description: string
  swatch: string
}

/** The presentations the menu offers, in the order the app defines them (a new presentation shows up here by itself). */
export function canvasThemes(): CanvasTheme[] {
  return PRESENTATION_OPTIONS.map((o) => {
    const look = THEME_LOOK[o.value]
    return { value: o.value, name: look?.name ?? o.label, description: look?.description ?? o.description, swatch: look?.swatch ?? FALLBACK_SWATCH }
  })
}

function swatchStyle(swatch: string): CSSProperties {
  return { background: swatch }
}

function ThemeList({ close }: { close: () => void }): ReactElement {
  const canvas = useCanvasOptions()
  const announce = useFrameAnnounce()
  const themes = useMemo(canvasThemes, [])
  const list = useRef<HTMLDivElement>(null)
  const roving = useRovingFocus(list, '[role^="menuitem"]')
  const current = canvas.presentation ?? 'graph'

  // Focus enters on the current theme. The popover is still hidden on the first frames (focus() on it is dropped), so
  // this retries a few frames until the item really holds focus; the popover's own "first control" focus never
  // overrides a control the content focused, and this runs only once per open.
  useEffect(() => {
    let frame = 0
    let tries = 0
    const enter = (): void => {
      const root = list.current
      const target = root?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ?? root?.querySelector<HTMLElement>('[role^="menuitem"]')
      if (!target) return
      target.focus()
      if (document.activeElement !== target && tries++ < 8) frame = requestAnimationFrame(enter)
    }
    frame = requestAnimationFrame(enter)
    return () => cancelAnimationFrame(frame)
  }, [])

  const pick = (theme: CanvasTheme): void => {
    close()
    if (theme.value === current) return
    void saveCanvas((c) => ({ ...c, presentation: theme.value })).then(
      () => announce?.(`Canvas theme: ${theme.name}.`),
      () => announce?.('Could not save canvas theme.')
    )
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Tab leaves the menu: close it and let focus continue from the button.
    if (e.key === 'Tab') {
      close()
      return
    }
    // The menu is one column: Left / Right do nothing, Up / Down / Home / End move.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return
    roving.onKeyDown(e)
  }

  return (
    <div className="canvas-theme-list" ref={list} onKeyDown={onKeyDown} onFocus={roving.onFocus}>
      {themes.map((t) => (
        <button
          key={t.value}
          type="button"
          role="menuitemradio"
          aria-checked={t.value === current}
          className="canvas-theme-item"
          data-testid="canvas-theme-option"
          data-presentation={t.value}
          onClick={() => pick(t)}
        >
          <span className="canvas-theme-swatch canvas-theme-swatch-lg" aria-hidden="true" style={swatchStyle(t.swatch)} />
          <span className="canvas-theme-text">
            <span className="canvas-theme-name">{t.name}</span>
            <span className="canvas-theme-desc">{t.description}</span>
          </span>
          {t.value === current && (
            <span className="canvas-theme-check" aria-hidden="true">
              <Icon icon={Check} size="sm" />
            </span>
          )}
        </button>
      ))}
      <div className="canvas-theme-rule" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="canvas-theme-item canvas-theme-more"
        data-testid="canvas-theme-more"
        onClick={() => {
          close()
          requestAppSettingsSection(APP_SETTINGS_SECTIONS.canvas)
          useAppStore.getState().setView('appSettings')
        }}
      >
        <Icon icon={Settings2} size="sm" />
        <span>More canvas settings</span>
      </button>
    </div>
  )
}

/**
 * The canvas toolbar's "Theme <name>" dropdown: the canvas presentations (Org chart, Pocket Office, Factory floor, and
 * any later one in PRESENTATION_OPTIONS) as a menu with a swatch, a line of description and a check on the current one,
 * plus a link to App settings > Canvas. A pick is written through saveCanvas, exactly as the settings page's radio
 * group writes it. The Live view is the one place that mounts it (scenes are Live only). Replaces the presentation
 * radio group in CanvasStyleButton's popover (pass `withPresentation={false}` there).
 */
export function CanvasThemeMenu({ testId = 'canvas-theme-menu', triggerTestId = 'canvas-theme-trigger' }: { testId?: string; triggerTestId?: string }): ReactElement {
  const canvas = useCanvasOptions()
  const themes = useMemo(canvasThemes, [])
  const current = themes.find((t) => t.value === (canvas.presentation ?? 'graph')) ?? themes[0]
  return (
    <Popover
      label="Canvas theme"
      role="menu"
      placement="bottom-start"
      className="canvas-theme-panel"
      triggerClassName="canvas-chrome-btn canvas-theme-trigger"
      triggerTitle="Canvas theme"
      trigger={
        <>
          <span className="canvas-theme-swatch" aria-hidden="true" style={swatchStyle(current.swatch)} />
          <span className="canvas-theme-label">Theme</span>
          <span className="canvas-theme-current">{current.name}</span>
          <Icon icon={ChevronDown} size="sm" />
        </>
      }
      testId={testId}
      triggerTestId={triggerTestId}
    >
      {({ close }) => <ThemeList close={close} />}
    </Popover>
  )
}
