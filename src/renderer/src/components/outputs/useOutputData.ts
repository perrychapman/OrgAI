// Per-output reads (docs/design/outputs-2.md, Phase C): versions, notes and revision requests. Each refetches when the
// store's outputTick for the output moves (every outputs:changed push naming it, output.created, output.versioned) and
// keeps the last good answer through a failed refetch. A sequence guard drops answers to an older request.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { OutputNote, OutputRef, OutputRevisionRequest, OutputVersion } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'

export interface OutputRead<T> {
  data: T | null
  /** True after a failed read with nothing to show. */
  error: boolean
  reload(): void
}

function useOutputRead<T>(ref: OutputRef | null, read: (api: NonNullable<Window['orgai']['outputs']>, ref: OutputRef) => Promise<T>): OutputRead<T> {
  const projectId = ref?.projectId ?? ''
  const outputId = ref?.outputId ?? ''
  const tick = useAppStore((s) => (outputId ? (s.outputTick[outputId] ?? 0) : 0))
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const seq = useRef(0)
  const readRef = useRef(read)
  readRef.current = read
  // A different output starts empty.
  const shown = useRef('')
  if (shown.current !== outputId) {
    shown.current = outputId
    if (data !== null) setData(null)
    if (error) setError(false)
  }
  useEffect(() => {
    const api = window.orgai?.outputs
    if (!projectId || !outputId || !api) return
    const mine = ++seq.current
    let p: Promise<T>
    try {
      p = readRef.current(api, { projectId, outputId })
    } catch {
      setError(true)
      return
    }
    p.then(
      (v) => {
        if (seq.current !== mine) return
        setData(v)
        setError(false)
      },
      () => {
        if (seq.current === mine) setError(true)
      }
    )
  }, [projectId, outputId, tick, attempt])
  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  return { data, error: error && data === null, reload }
}

/** outputs:versions, newest first. */
export function useOutputVersions(ref: OutputRef | null): OutputRead<OutputVersion[]> {
  return useOutputRead(ref, (api, r) => api.versions(r))
}

/** outputs:notes of every version, oldest first. */
export function useOutputNotes(ref: OutputRef | null): OutputRead<OutputNote[]> {
  return useOutputRead(ref, (api, r) => api.notes(r))
}

/** outputs:revisions, newest first. */
export function useOutputRevisions(ref: OutputRef | null): OutputRead<OutputRevisionRequest[]> {
  return useOutputRead(ref, (api, r) => api.revisions(r))
}
