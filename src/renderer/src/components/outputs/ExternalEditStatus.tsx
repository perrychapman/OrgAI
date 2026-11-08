// Round trip for Word, Excel and PowerPoint (docs/design/outputs-2.md 10): open the file in its app, watch it, and say when
// a new version arrives from the user's changes. The hook is owned by OutputDetail so the detail and the Larger view share it.
import type { ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { OutputVersion, RunOutput } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { externalAppName } from '../../lib/outputs'
import { externalNotice } from '../../lib/outputVersions'
import { Button } from '../ui/Button'
import '../../styles/outputs-versions.css'

export const EXTERNAL_HINT_TEXT = 'Changes made outside OrgAI by a run are kept as versions too.'
/** Outputs whose first "Edit in..." this session already showed the hint. */
const hinted = new Set<string>()

export interface ExternalEdit {
  watching: boolean
  /** The line about a version that arrived (with the pair to compare). */
  arrived: { text: string; compare: { a: number; b: number } } | null
  hint: boolean
  /** Opens the file in its app, then watches it. Resolves to a sentence to say when something refused. */
  start(): Promise<string | null>
  stop(): void
}

export function useExternalEdit(output: RunOutput, versions: OutputVersion[] | null, announce: (text: string) => void): ExternalEdit {
  const [watching, setWatching] = useState(false)
  const [arrived, setArrived] = useState<ExternalEdit['arrived']>(null)
  const [hint, setHint] = useState(false)
  const baseline = useRef(0)
  const notified = useRef(0)
  const ref = { projectId: output.projectId, outputId: output.id }
  const refKey = `${ref.projectId}/${ref.outputId}`
  const watchingRef = useRef(false)
  const announceRef = useRef(announce)
  announceRef.current = announce
  const app = externalAppName(output.kind) ?? 'its app'

  const stop = useCallback((): void => {
    if (!watchingRef.current) return
    watchingRef.current = false
    setWatching(false)
    const [projectId, outputId] = refKey.split('/')
    void window.orgai.outputs.unwatch({ projectId, outputId }).catch(() => undefined)
  }, [refKey])

  const start = useCallback(async (): Promise<string | null> => {
    const [projectId, outputId] = refKey.split('/')
    try {
      const answer = await window.orgai.outputs.open({ projectId, outputId })
      if (answer) return answer
      const w = await window.orgai.outputs.watch({ projectId, outputId })
      if ('refused' in w) return w.refused
      if (!w.watched) return 'OrgAI could not watch this file.'
      baseline.current = output.version ?? 1
      notified.current = baseline.current
      watchingRef.current = true
      setWatching(true)
      setArrived(null)
      if (!hinted.has(outputId)) {
        hinted.add(outputId)
        setHint(true)
      }
      announceRef.current(`Watching ${output.fileName} for changes.`)
      return null
    } catch (e) {
      return cleanIpcError(e)
    }
  }, [refKey, output.version, output.fileName])

  // A new external version after the watch began.
  useEffect(() => {
    if (!watching || !versions) return
    const fresh = versions.filter((v) => v.source === 'external' && v.n > notified.current)
    if (fresh.length === 0) return
    const v = fresh[0]
    notified.current = v.n
    const before = versions.find((x) => x.n < v.n)
    const text = externalNotice(v.n, app)
    setArrived({ text, compare: { a: before?.n ?? Math.max(1, v.n - 1), b: v.n } })
    announceRef.current(text)
  }, [watching, versions, app])

  // Main ended the watch (expired, file gone).
  const change = useAppStore((s) => s.outputChange[output.id])
  useEffect(() => {
    if (watching && change?.what === 'watch') {
      watchingRef.current = false
      setWatching(false)
    }
  }, [change, watching])

  // Closing the detail or the viewer stops the watch.
  useEffect(() => {
    return () => {
      if (!watchingRef.current) return
      watchingRef.current = false
      const [projectId, outputId] = refKey.split('/')
      void window.orgai.outputs.unwatch({ projectId, outputId }).catch(() => undefined)
    }
  }, [refKey])

  return { watching, arrived, hint, start, stop }
}

export default function ExternalEditStatus({ edit, output, onCompare }: { edit: ExternalEdit; output: RunOutput; onCompare(a: number, b: number): void }): ReactElement | null {
  if (!edit.watching && !edit.arrived) return null
  return (
    <div className="output-external" data-testid="output-external-wrap">
      {edit.watching && (
        <p className="output-external-status" data-testid="output-external-status">
          Watching {output.fileName} for changes. Save in your app and the new version appears here.{' '}
          <button type="button" className="link-btn" data-testid="output-external-stop" onClick={(e) => { const scope = e.currentTarget.closest('[data-testid=output-detail], [data-testid=output-viewer]'); edit.stop(); requestAnimationFrame(() => scope?.querySelector<HTMLElement>('[data-testid=output-edit-external]')?.focus()) }}>
            Stop watching
          </button>
        </p>
      )}
      {edit.arrived && (
        <p className="output-external-arrived" data-testid="output-external-arrived">
          {edit.arrived.text}{' '}
          <Button size="sm" testId="output-external-compare" onClick={() => onCompare(edit.arrived!.compare.a, edit.arrived!.compare.b)}>
            Compare with version {edit.arrived.compare.a}
          </Button>
        </p>
      )}
      {edit.hint && edit.watching && (
        <p className="output-external-hint" data-testid="output-external-hint">
          {EXTERNAL_HINT_TEXT}
        </p>
      )}
    </div>
  )
}
