// The revision line under the detail head (docs/design/outputs-2.md 7): waiting, answered (with Compare) or ended without a
// new version. No spinner, no animation. Reads useOutputDetail() (announce, setMode for Compare).
import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { OutputRevisionRequest } from '@shared/types'
import { Button } from '../ui/Button'
import { useAppStore, useRunIndexes } from '../../store/useAppStore'
import { runTag } from '../../lib/runLabels'
import { showHidden } from '../../lib/hiddenChars'
import { answeredSentence, compareLabel, endedSentence, pendingSentence } from '../../lib/outputRevise'
import { useOutputDetail } from './outputDetailContext'
import { useOutputRevisions } from './useOutputData'
import '../../styles/outputs-revise.css'

/** Requests this window saw waiting, and the ones the user dismissed (memory only, like the pending list itself). */
const watched = new Set<string>()
const dismissed = new Set<string>()

type Phase = 'pending' | 'answered' | 'ended'

function phaseOf(r: OutputRevisionRequest): Phase {
  return r.answeredBy !== undefined ? 'answered' : r.endedAt !== undefined ? 'ended' : 'pending'
}

export default function RevisionStatus(): ReactElement | null {
  const ctx = useOutputDetail()
  const output = ctx?.output
  const revisions = useOutputRevisions(output ? { projectId: output.projectId, outputId: output.id } : null).data
  const indexes = useRunIndexes()
  const pendingLocal = useAppStore((s) => s.pendingRevisionsByRun)
  const [, force] = useState(0)
  const spoken = useRef(new Map<string, Phase>())
  const announce = ctx?.announce

  // A request just sent shows at once, before the refetch lands.
  const local = output ? Object.values(pendingLocal).flat().filter((p) => p.outputId === output.id).sort((a, b) => b.at - a.at)[0] : undefined
  if (local) watched.add(local.requestId)
  const mine = (revisions ?? []).filter((r) => r.outputId === output?.id)
  for (const r of mine) if (phaseOf(r) === 'pending') watched.add(r.id)
  // The newest request this window watched that is not dismissed.
  const shown = mine.find((r) => watched.has(r.id) && !dismissed.has(r.id))
  const phase = shown ? phaseOf(shown) : null
  const key = shown?.id
  useEffect(() => {
    if (!shown || !phase || !key) return
    if (spoken.current.get(key) === phase) return
    const first = !spoken.current.has(key)
    spoken.current.set(key, phase)
    if (phase === 'pending' && first) return // the send already spoke
    if (phase === 'answered') {
      const who = ctx?.versions?.find((v) => v.n === shown.answeredBy)?.role
      announce?.(answeredSentence(who ? showHidden(who) : 'The team', shown.answeredBy ?? 0))
    } else if (phase === 'ended') announce?.(endedSentence(runTag(indexes.get(shown.runId))))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, phase])

  if (!ctx || !output) return null
  if (!shown) {
    if (!local) return null
    return (
      <p className="output-revision" data-testid="output-revision-pending" data-phase="pending">
        <span className="output-revision-text">{pendingSentence(runTag(indexes.get(local.runId)), local.at)}</span>
      </p>
    )
  }
  const label = runTag(indexes.get(shown.runId))
  if (phase === 'pending') {
    return (
      <p className="output-revision" data-testid="output-revision-pending" data-phase="pending">
        <span className="output-revision-text">{pendingSentence(label, shown.createdAt)}</span>
      </p>
    )
  }
  const dismiss = (): void => {
    dismissed.add(shown.id)
    force((n) => n + 1)
  }
  if (phase === 'answered') {
    const n = shown.answeredBy ?? 0
    const who = ctx.versions?.find((v) => v.n === n)?.role
    return (
      <p className="output-revision" data-testid="output-revision-answered" data-phase="answered">
        <span className="output-revision-text">{answeredSentence(who ? showHidden(who) : 'The team', n)}</span>
        {n > 1 && (
          <Button size="sm" testId="output-revision-compare" onClick={() => void ctx.setMode('compare', { a: n - 1, b: n })}>
            {compareLabel(n - 1)}
          </Button>
        )}
        <Button size="sm" variant="ghost" testId="output-revision-dismiss" onClick={dismiss}>
          Dismiss
        </Button>
      </p>
    )
  }
  return (
    <p className="output-revision" data-testid="output-revision-ended" data-phase="ended">
      <span className="output-revision-text">{endedSentence(label)}</span>
      <Button size="sm" variant="ghost" testId="output-revision-dismiss" onClick={dismiss}>
        Dismiss
      </Button>
    </p>
  )
}
