import { useEffect, useMemo, useRef } from 'react'
import { useAppStore, useProjectSummaries } from '../../store/useAppStore'
import { chainOf } from '../../lib/runChains'
import { HIDDEN_OR_CONTROL_RUN } from '../../lib/hiddenChars'
import { outputsOfRuns } from '../../lib/outputs'
import type { RunOutput } from '@shared/types'
import { announceText, unannouncedTitles } from '../../lib/outputsRun'
import { updatedText, updatedVersions, type UpdatedVersion } from '../../lib/outputsList'
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
  const latest = useRef<RunOutput[]>([])
  const versions = useRef(new Map<string, number>())
  const updated = useRef(new Map<string, UpdatedVersion>())
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
      latest.current = []
      versions.current = new Map()
      updated.current = new Map()
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    }
    if (!list) return
    const mine = outputsOfRuns(list, chainKey.split('|'))
    if (seen.current === null) {
      seen.current = new Set(mine.map((o) => o.id))
      versions.current = new Map(mine.map((o) => [o.id, o.version ?? 1]))
      return
    }
    latest.current = mine
    // A new version of an output already known: "Updated Project plan to version 3".
    for (const u of updatedVersions(
      [...versions.current].map(([id, version]) => ({ id, title: '', version })),
      mine
    ))
      updated.current.set(u.id, u)
    for (const o of mine) if (!versions.current.has(o.id) || (versions.current.get(o.id) ?? 1) < (o.version ?? 1)) versions.current.set(o.id, o.version ?? 1)
    if (unannouncedTitles(mine, seen.current).length === 0 && updated.current.size === 0) return
    // The count is read when the sentence is said (after the throttle), from the chain's outputs then, so it
    // agrees with the chip and the list however many arrived while it waited.
    const flush = (): void => {
      timer.current = null
      const known = seen.current
      const titles = known ? unannouncedTitles(latest.current, known) : []
      const ups = [...updated.current.values()].map((u) => ({ ...u, title: u.title.replace(HIDDEN_OR_CONTROL_RUN, '') }))
      updated.current.clear()
      if (!known || (titles.length === 0 && ups.length === 0)) return
      for (const o of latest.current) known.add(o.id)
      lastAt.current = Date.now()
      const text = [announceText(titles.map((t) => t.replace(HIDDEN_OR_CONTROL_RUN, ''))), updatedText(ups)].filter(Boolean).join('. ')
      if (text) say.current?.(text)
    }
    if (timer.current) return
    const wait = Math.max(0, OUTPUT_ANNOUNCE_MS - (Date.now() - lastAt.current))
    if (wait === 0) flush()
    else timer.current = setTimeout(flush, wait)
  }, [list, projectId, chainKey])
}
