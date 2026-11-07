import { useEffect, useMemo, useRef } from 'react'
import { useAppStore, useProjectSummaries } from '../../store/useAppStore'
import { chainOf } from '../../lib/runChains'
import { HIDDEN_OR_CONTROL_RUN } from '../../lib/hiddenChars'
import { outputsOfRuns } from '../../lib/outputs'
import { announceText } from '../../lib/outputsRun'
import { useFrameAnnounce } from '../layout/CanvasFrame'

/** At most one polite announcement per this long (docs/design/outputs.md section 3). */
export const OUTPUT_ANNOUNCE_MS = 5000

/**
 * Says "Produced Project plan" / "Produced 3 outputs" through the frame's polite announcer when outputs of this run's
 * chain arrive while the run is open (never for the list that was already there). Call it from a component inside a
 * CanvasFrame. Nothing moves focus and nothing reaches the bell or the badges.
 */
export function useOutputAnnouncements(runId: string): void {
  const announce = useFrameAnnounce()
  const projectId = useAppStore((s) => s.runs[runId]?.summary.projectId)
  const summaries = useProjectSummaries()
  const chainKey = useMemo(() => chainOf(summaries, runId).map((m) => m.id).join('|') || runId, [summaries, runId])
  const list = useAppStore((s) => (projectId ? s.outputsByProject[projectId] : undefined))
  const seen = useRef<Set<string> | null>(null)
  const scope = useRef('')
  const pending = useRef<string[]>([])
  const lastAt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const say = useRef(announce)
  say.current = announce

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  useEffect(() => {
    const key = `${projectId ?? ''}/${chainKey}`
    if (scope.current !== key) {
      scope.current = key
      seen.current = null
      pending.current = []
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    }
    if (!list) return
    const mine = outputsOfRuns(list, chainKey.split('|'))
    if (seen.current === null) {
      seen.current = new Set(mine.map((o) => o.id))
      return
    }
    const known = seen.current
    const fresh = mine.filter((o) => !known.has(o.id))
    if (fresh.length === 0) return
    for (const o of fresh) known.add(o.id)
    pending.current.push(...fresh.reverse().map((o) => o.title.replace(HIDDEN_OR_CONTROL_RUN, '')))
    const flush = (): void => {
      timer.current = null
      const titles = pending.current
      pending.current = []
      lastAt.current = Date.now()
      const text = announceText(titles)
      if (text) say.current?.(text)
    }
    if (timer.current) return
    const wait = Math.max(0, OUTPUT_ANNOUNCE_MS - (Date.now() - lastAt.current))
    if (wait === 0) flush()
    else timer.current = setTimeout(flush, wait)
  }, [list, projectId, chainKey])
}
