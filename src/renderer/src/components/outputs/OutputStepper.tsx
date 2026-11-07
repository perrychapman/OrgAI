import type { KeyboardEvent, ReactElement } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { RunOutput } from '@shared/types'
import { positionText, stepId } from '../../lib/outputsList'
import { useEffect, useRef, useState } from 'react'
import { showHidden } from '../../lib/hiddenChars'
import { IconButton } from '../ui/IconButton'

/**
 * Previous / next output and "3 of 12" over a list (docs/design/outputs-2.md section 4). The buttons go inert at the
 * ends (they keep focus). The counter is plain text; after a button step (focus stays on the button) the sr-only status
 * below says "<title>, 3 of 12"; Alt+arrows focus the new heading instead, which names it.
 */
export function OutputStepper({ rows, id, onStep }: { rows: readonly Pick<RunOutput, 'id' | 'title'>[]; id: string | null; onStep: (to: string, viaKeyboard: boolean) => void }): ReactElement {
  const prev = stepId(rows, id, -1)
  const next = stepId(rows, id, 1)
  // A button step keeps focus on the button, so the new output is spoken here ("Budget, 3 of 12"); Alt+arrows focus the heading instead.
  const [said, setSaid] = useState('')
  const frame = useRef(0)
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  const go = (to: string | null): void => {
    if (!to) return
    const title = rows.find((r) => r.id === to)?.title ?? ''
    setSaid('')
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => setSaid(`${showHidden(title)}, ${positionText(rows, to)}`))
    onStep(to, false)
  }
  return (
    <div className="output-stepper" data-testid="output-stepper" role="group" aria-label="Move between outputs">
      <IconButton icon={ChevronLeft} size="sm" label="Previous output" testId="output-prev" inert={!prev} onClick={() => go(prev)} />
      <span className="output-position" data-testid="output-position">
        {positionText(rows, id)}
      </span>
      <IconButton icon={ChevronRight} size="sm" label="Next output" testId="output-next" inert={!next} onClick={() => go(next)} />
      <span className="sr-only" role="status" data-testid="output-step-status">
        {said}
      </span>
    </div>
  )
}

/** Alt+Left / Alt+Right inside the detail step to the previous / next output (not while typing in a field). */
export function stepKeyHandler(rows: readonly Pick<RunOutput, 'id'>[], id: string | null, onStep: (to: string, viaKeyboard: boolean) => void): (e: KeyboardEvent<HTMLElement>) => void {
  return (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, select, [contenteditable=true]')) return
    e.preventDefault()
    const to = stepId(rows, id, e.key === 'ArrowLeft' ? -1 : 1)
    if (to) onStep(to, true)
  }
}
