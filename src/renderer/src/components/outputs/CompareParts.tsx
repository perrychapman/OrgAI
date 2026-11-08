// Shared pieces of the Compare views (docs/design/outputs-2.md 12.2): reading one version's preview, and Previous / Next change.
import type { KeyboardEvent, ReactElement, RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { OutputPreview, RunOutput } from '@shared/types'
import { IconButton } from '../ui/IconButton'
import { scrollWithin } from '../../lib/scrollWithin'
import { stepChange } from '../../lib/outputDiff'

export type VersionPreviewState = { state: 'loading' } | { state: 'error' } | { state: 'ready'; preview: OutputPreview }

/** outputs:preview of one version of an output; a newer request drops older answers. */
export function useVersionPreview(output: Pick<RunOutput, 'id' | 'projectId'>, version: number, enabled = true): VersionPreviewState {
  const [st, setSt] = useState<{ key: string; value: VersionPreviewState } | null>(null)
  const key = `${output.projectId}/${output.id}/${version}`
  useEffect(() => {
    if (!enabled) return undefined
    let live = true
    const api = window.orgai?.outputs
    if (!api) {
      setSt({ key, value: { state: 'error' } })
      return undefined
    }
    api.preview({ projectId: output.projectId, outputId: output.id, version }).then(
      (preview) => live && setSt({ key, value: { state: 'ready', preview } }),
      () => live && setSt({ key, value: { state: 'error' } })
    )
    return () => {
      live = false
    }
  }, [key, enabled, output.projectId, output.id, version])
  return st && st.key === key ? st.value : { state: 'loading' }
}

/** The text of a text or svg preview, else null. */
export function previewTextOf(p: VersionPreviewState): string | null {
  if (p.state !== 'ready') return null
  return p.preview.kind === 'text' || p.preview.kind === 'svg' ? p.preview.text : null
}

export interface ChangeNav {
  /** The current change (0-based), -1 before the first step. */
  index: number
  step(dir: 1 | -1): void
  /** Props for the pane's root: F3 / Shift+F3 and Alt+Down / Alt+Up while focus is inside. */
  onKeyDown(e: KeyboardEvent<HTMLElement>): void
}

/**
 * Previous / Next change over `count` changes. Rows carry `data-change-first="<n>"` on the first row of change n; stepping
 * scrolls that row into the body's own scroller and `onStep` speaks it.
 */
export function useChangeNav(count: number, body: RefObject<HTMLElement | null>, onStep?: (text: string) => void): ChangeNav {
  const [index, setIndex] = useState(-1)
  const seen = useRef(count)
  useEffect(() => {
    if (seen.current !== count) {
      seen.current = count
      setIndex(-1)
    }
  }, [count])
  const live = useRef({ index, count, onStep })
  live.current = { index, count, onStep }
  const step = useCallback(
    (dir: 1 | -1): void => {
      const { index: cur, count: n, onStep: say } = live.current
      const next = stepChange(n, cur, dir)
      if (next === null) return
      setIndex(next)
      say?.(`Change ${next + 1} of ${n}`)
      const el = body.current?.querySelector(`[data-change-first="${next}"]`)
      scrollWithin(el, 'center')
    },
    [body]
  )
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>): void => {
      const next = e.key === 'F3' && !e.shiftKey ? 1 : e.key === 'ArrowDown' && e.altKey ? 1 : null
      const prev = e.key === 'F3' && e.shiftKey ? -1 : e.key === 'ArrowUp' && e.altKey ? -1 : null
      const dir = next ?? prev
      if (dir === null) return
      e.preventDefault()
      e.stopPropagation()
      step(dir)
    },
    [step]
  )
  return { index, step, onKeyDown }
}

/** Previous change / Next change buttons with the "Change 2 of 5" count. */
export function ChangeNavBar({ count, nav }: { count: number; nav: ChangeNav }): ReactElement {
  return (
    <div className="compare-nav" role="group" aria-label="Changes">
      <IconButton icon={ChevronUp} label="Previous change" size="sm" testId="output-compare-prev" inert={count === 0} onClick={() => nav.step(-1)} />
      <IconButton icon={ChevronDown} label="Next change" size="sm" testId="output-compare-next" inert={count === 0} onClick={() => nav.step(1)} />
      <span className="compare-nav-count" data-testid="output-compare-position">
        {count === 0 ? 'No changes' : nav.index < 0 ? `${count} ${count === 1 ? 'change' : 'changes'}` : `Change ${nav.index + 1} of ${count}`}
      </span>
    </div>
  )
}

/** Marks the current change on its first row for styling and e2e. */
export const currentAttr = (index: number, change: number | undefined, first: boolean | undefined): { 'data-change-first'?: number; 'data-current'?: 'true' } => ({
  ...(first && change !== undefined ? { 'data-change-first': change } : {}),
  ...(change !== undefined && change === index ? { 'data-current': 'true' as const } : {})
})
