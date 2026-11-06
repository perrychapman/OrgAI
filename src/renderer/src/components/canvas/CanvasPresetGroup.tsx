import type { KeyboardEvent, ReactElement, Ref } from 'react'
import { useId } from 'react'
import { Check } from 'lucide-react'
import { CANVAS_STYLE_OPTIONS, shownStyle, type CanvasStyleId } from '../../lib/canvas'
import type { CanvasSettings } from '../../lib/canvasSettings'
import { Icon } from '../ui/Icon'
import { CanvasThumb } from './CanvasThumb'

export const CUSTOM_DESCRIPTION = 'Your own mix. Change it under Customise.'

/**
 * The "Canvas style" radio group shared by App settings > General > Canvas (gallery) and the toolbar popover (compact
 * rows). One tab stop (the checked option); arrow keys move and pick at once, Home / End jump to the first and last
 * entry (Default first). "Custom" is shown, checked, only when neither Default nor an available preset matches.
 */
export function CanvasPresetGroup({
  canvas,
  onPick,
  variant,
  groupRef,
  label = 'Canvas style'
}: {
  canvas: CanvasSettings
  onPick: (id: CanvasStyleId) => void
  variant: 'gallery' | 'compact'
  groupRef?: Ref<HTMLDivElement>
  label?: string
}): ReactElement {
  const base = useId()
  const shown = shownStyle(canvas)
  const compact = variant === 'compact'
  const size = compact ? { width: 48, height: 32 } : { width: 72, height: 48 }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End']
    if (!keys.includes(e.key)) return
    const options = CANVAS_STYLE_OPTIONS
    if (options.length === 0) return
    const at = shown ? options.findIndex((p) => p.id === shown) : -1
    let to: number
    if (e.key === 'Home') to = 0
    else if (e.key === 'End') to = options.length - 1
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = at < 0 ? 0 : (at + 1) % options.length
    else to = at < 0 ? options.length - 1 : (at - 1 + options.length) % options.length
    e.preventDefault()
    const next = options[to]
    e.currentTarget.querySelector<HTMLElement>(`[data-preset="${next.id}"]`)?.focus()
    if (next.id !== shown) onPick(next.id)
  }

  return (
    <div
      ref={groupRef}
      className="canvas-presets"
      data-variant={variant}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {CANVAS_STYLE_OPTIONS.map((p) => {
        const checked = shown === p.id
        const descId = `${base}-${p.id}-desc`
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-describedby={descId}
            tabIndex={checked ? 0 : -1}
            className="canvas-opt"
            data-testid="canvas-preset"
            data-preset={p.id}
            onClick={() => {
              if (!checked) onPick(p.id)
            }}
          >
            <CanvasThumb spec={p.canvas} preset {...size} />
            <span className="canvas-opt-text">
              <span className="canvas-opt-label">{p.label}</span>
              <span className={compact ? 'sr-only' : 'canvas-opt-desc'} id={descId}>
                {p.description}
              </span>
            </span>
            {checked && (
              <span className="canvas-opt-check">
                <Icon icon={Check} size="sm" />
              </span>
            )}
          </button>
        )
      })}
      {shown === undefined && (
        <button
          type="button"
          role="radio"
          aria-checked
          aria-describedby={`${base}-custom-desc`}
          tabIndex={0}
          className="canvas-opt"
          data-testid="canvas-preset"
          data-preset="custom"
        >
          <CanvasThumb spec={canvas} {...size} />
          <span className="canvas-opt-text">
            <span className="canvas-opt-label">Custom</span>
            <span className={compact ? 'sr-only' : 'canvas-opt-desc'} id={`${base}-custom-desc`}>
              {CUSTOM_DESCRIPTION}
            </span>
          </span>
          <span className="canvas-opt-check">
            <Icon icon={Check} size="sm" />
          </span>
        </button>
      )}
    </div>
  )
}

/** Moves focus to the checked option of a preset group inside `root` (the deep link and the popover use it). */
export function focusCheckedPreset(root: ParentNode | null): void {
  root?.querySelector<HTMLElement>('[data-testid="canvas-preset"][aria-checked="true"]')?.focus({ preventScroll: true })
}
