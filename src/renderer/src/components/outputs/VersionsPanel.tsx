// The Versions tab (docs/design/outputs-2.md 12.1): newest first, one list item per version with its actions as buttons.
import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { OutputVersion } from '@shared/types'
import { useAppStore, useRunIndexes } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { formatBytes, mergeOutput } from '../../lib/outputs'
import { runTag } from '../../lib/runLabels'
import { VERSIONS_FIRST_TEXT, VERSIONS_PRUNED_TEXT, VERSION_NAME_MAX, openNotesText, restoredNotice, shortDateTime, sizeDelta, versionSourceText } from '../../lib/outputVersions'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { useOutputRevisions } from './useOutputData'
import { useOutputDetail, type OutputDetailValue } from './outputDetailContext'
import '../../styles/outputs-versions.css'

const WINDOW = 12

/** Restore a version (no confirm: it adds a version, history is kept). Speaks the notice, shows the new current version. */
export async function restoreVersion(ctx: OutputDetailValue, n: number): Promise<void> {
  const { output } = ctx
  // The new current version's row when the Versions list is on screen, else the output's heading.
  const afterFocus: 'row' | 'heading' = ctx.tab === 'versions' ? 'row' : 'heading'
  try {
    const r = await window.orgai.outputs.restore({ projectId: output.projectId, outputId: output.id, version: n })
    if ('refused' in r) {
      ctx.announce(r.refused)
      return
    }
    const st = useAppStore.getState()
    st.setOutputs(output.projectId, mergeOutput(st.outputsByProject[output.projectId], r.output))
    ctx.setVersion(null)
    ctx.reloadVersions()
    ctx.announce(restoredNotice(n, r.version))
    let tries = 0
    const focusIt = (): void => {
      const sel = afterFocus === 'row' ? `[data-testid=output-version-row][data-n="${r.version}"]` : '[data-testid=output-detail-heading]'
      const el = document.querySelector<HTMLElement>(sel)
      if (el) el.focus({ preventScroll: false })
      else if (++tries < 40) setTimeout(focusIt, 50)
    }
    focusIt()
  } catch (e) {
    ctx.announce(cleanIpcError(e))
  }
}

export default function VersionsPanel(): ReactElement | null {
  const ctx = useOutputDetail()
  const indexes = useRunIndexes()
  const [picked, setPicked] = useState<number[]>([])
  const [naming, setNaming] = useState<number | null>(null)
  const [label, setLabel] = useState('')
  const [error, setError] = useState('')
  const [limit, setLimit] = useState(WINDOW)
  const nameRef = useRef<HTMLInputElement>(null)
  const output = ctx?.output
  const revisions = useOutputRevisions(output ? { projectId: output.projectId, outputId: output.id } : null)
  const notesSent = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of revisions.data ?? []) if (r.scope === 'notes') m.set(r.id, r.noteIds?.length ?? 0)
    return m
  }, [revisions.data])
  useEffect(() => {
    if (naming !== null) nameRef.current?.focus()
  }, [naming])
  if (!ctx || !output) return null
  const list = ctx.versions
  if (!list) {
    return (
      <div className="output-versions" data-testid="output-versions" data-state="loading">
        <p className="panel-note">Loading versions…</p>
      </div>
    )
  }
  const oldest = list.length ? list[list.length - 1].n : 1
  const shown = list.slice(0, limit)
  const togglePick = (n: number): void => setPicked((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n].slice(-2)))
  const saveName = async (v: OutputVersion): Promise<void> => {
    setError('')
    try {
      await window.orgai.outputs.update({ projectId: output.projectId, outputId: output.id, versionLabel: { n: v.n, label: label.trim() } })
      setNaming(null)
      ctx.reloadVersions()
      ctx.announce(label.trim() ? `Named version ${v.n} ${label.trim()}.` : `Cleared the name of version ${v.n}.`)
    } catch (e) {
      setError(cleanIpcError(e))
    }
  }
  return (
    <div className="output-versions" data-testid="output-versions" data-state="ready">
      {picked.length === 2 && (
        <div className="output-versions-bar">
          <Button
            variant="primary"
            size="sm"
            testId="output-compare-picked"
            onClick={() => {
              const [a, b] = [...picked].sort((x, y) => x - y)
              void ctx.setMode('compare', { a, b })
            }}
          >
            Compare 2 versions
          </Button>
        </div>
      )}
      {error && (
        <p className="output-versions-error" role="alert" data-testid="output-version-error">
          {error}
        </p>
      )}
      <ul className="output-version-list" aria-label="Versions">
        {shown.map((v, i) => {
          const current = v.n === ctx.currentVersion
          const prev = list[i + 1]
          const delta = sizeDelta(prev?.bytes, v.bytes)
          const idx = v.runId ? indexes.get(v.runId) : undefined
          const source = versionSourceText(v, {
            first: v.n === oldest,
            runTag: v.source === 'agent' && idx !== undefined ? runTag(idx) : undefined,
            answeredNotes: v.answers ? notesSent.get(v.answers) : undefined
          })
          const open = openNotesText(v.openNoteCount)
          const viewing = v.n === ctx.version
          return (
            <li key={v.n} className="output-version-row" data-testid="output-version-row" data-n={v.n} data-current={current ? 'true' : 'false'} data-viewing={viewing ? 'true' : undefined} tabIndex={-1}>
              <div className="output-version-head">
                <span className="output-version-num">v{v.n}</span>
                {current && (
                  <Badge tone="success" testId="output-version-now">
                    Now
                  </Badge>
                )}
                {viewing && !current && <Badge testId="output-version-viewing">Viewing</Badge>}
                {v.label && (
                  <span className="output-version-label" data-testid="output-version-label">
                    {v.label}
                  </span>
                )}
              </div>
              <p className="output-version-source" data-testid="output-version-source">
                {source}
              </p>
              <p className="output-version-meta">
                {[shortDateTime(v.createdAt), formatBytes(v.bytes), delta, open].filter(Boolean).join(' · ')}
              </p>
              {naming === v.n ? (
                <form
                  className="output-version-name-form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void saveName(v)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation()
                      setNaming(null)
                    }
                  }}
                >
                  <label className="sr-only" htmlFor={`version-name-${v.n}`}>
                    Name for version {v.n}
                  </label>
                  <input
                    ref={nameRef}
                    id={`version-name-${v.n}`}
                    className="input"
                    data-testid="output-version-name-input"
                    value={label}
                    maxLength={VERSION_NAME_MAX}
                    placeholder="For example: Sent to the client"
                    onChange={(e) => setLabel(e.target.value)}
                  />
                  <Button type="submit" size="sm" variant="primary" testId="output-version-name-save">
                    Save name
                  </Button>
                  <Button size="sm" onClick={() => setNaming(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <div className="output-version-actions" role="group" aria-label={`Actions for version ${v.n}`}>
                  {!viewing && (
                    <Button size="sm" testId="output-version-view" ariaLabel={`View version ${v.n}`} onClick={() => ctx.setVersion(v.n)}>
                      View
                    </Button>
                  )}
                  {!current && (
                    <Button size="sm" testId="output-version-compare-current" ariaLabel={`Compare version ${v.n} with the current version`} onClick={() => void ctx.setMode('compare', { a: v.n, b: ctx.currentVersion })}>
                      Compare with current
                    </Button>
                  )}
                  <Button
                    size="sm"
                    testId="output-version-name"
                    ariaLabel={`Name version ${v.n}`}
                    onClick={() => {
                      setLabel(v.label ?? '')
                      setNaming(v.n)
                    }}
                  >
                    Name…
                  </Button>
                  {!current && (
                    <Button size="sm" testId="output-version-restore" ariaLabel={`Restore version ${v.n}`} onClick={() => void restoreVersion(ctx, v.n)}>
                      Restore
                    </Button>
                  )}
                  <label className="output-version-pick">
                    <input type="checkbox" data-testid="output-version-pick" checked={picked.includes(v.n)} onChange={() => togglePick(v.n)} />
                    <span>Pick to compare</span>
                    <span className="sr-only"> version {v.n}</span>
                  </label>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {list.length > limit && (
        <Button size="sm" testId="output-versions-more" onClick={() => setLimit((l) => l + WINDOW)}>
          Show {Math.min(WINDOW, list.length - limit)} older versions
        </Button>
      )}
      {list.length <= 1 && (
        <p className="panel-note" data-testid="output-versions-first">
          {VERSIONS_FIRST_TEXT}
        </p>
      )}
      {output.versionsPruned && (
        <p className="panel-note" data-testid="output-versions-pruned">
          {VERSIONS_PRUNED_TEXT}
        </p>
      )}
    </div>
  )
}
