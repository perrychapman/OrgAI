import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { McpLibraryInfo, SkillLibraryInfo } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { connectorPresetsApi } from '../../lib/mcpScope'
import { cleanIpcError } from '../../lib/ipcError'
import { clampLabel } from '../../lib/clampLabel'
import { showHidden } from '../../lib/hiddenChars'
import { kitApi, type KitExportResult } from '../../lib/kitApi'
import {
  KIT_GROUPS,
  KIT_GROUP_TITLE,
  emptySelection,
  exportCountLine,
  groupState,
  selectedTotal,
  selectionToInclude,
  type KitGroupId,
  type KitSelectionState
} from '../../lib/kit'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Dialog } from '../ui/Dialog'

interface KitRow {
  id: string
  name: string
  detail: string
}

type KitRows = Record<KitGroupId, KitRow[]>

const GROUP_NOTE: Partial<Record<KitGroupId, string>> = {
  servers: 'Saved without secret values or sign-in. People enter their own after importing.',
  templates: 'Only the team itself. Skills and services it uses are not included unless you tick them above.'
}

function serverTarget(e: McpLibraryInfo['entry']): string {
  if (e.url) return e.url
  return [e.command, ...(e.args ?? [])].filter(Boolean).join(' ')
}

/** Export a kit: choose items per group, then main's save dialog and the write (engagement-2 section 8). */
export default function KitExportDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (result: KitExportResult) => void }): ReactElement {
  const templates = useAppStore((s) => s.templates)
  const [skills, setSkills] = useState<SkillLibraryInfo[] | null>(null)
  const [servers, setServers] = useState<McpLibraryInfo[] | null>(null)
  const [presets, setPresets] = useState<{ id: string; name: string; description: string }[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<KitSelectionState>(emptySelection)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const initialised = useRef(false)

  useEffect(() => {
    let live = true
    void useAppStore.getState().loadTemplates()
    void (async () => {
      try {
        const [s, m, p] = await Promise.all([
          window.orgai.skillLibrary.list(),
          window.orgai.mcpLibrary.list(),
          connectorPresetsApi()?.list() ?? Promise.resolve([])
        ])
        if (!live) return
        setSkills(s)
        setServers(m)
        setPresets(p.map((d) => ({ id: d.id, name: d.name, description: d.description })))
      } catch (e) {
        if (live) setLoadError(cleanIpcError(e))
      }
    })()
    return () => {
      live = false
    }
  }, [])

  const rows: KitRows | null = useMemo(() => {
    if (!skills || !servers || !presets || templates === null) return null
    return {
      skills: skills.map((i) => ({ id: i.entry.id, name: i.entry.name, detail: i.entry.description })),
      servers: servers.filter((i) => !i.entry.connectorId).map((i) => ({ id: i.entry.id, name: i.entry.name, detail: serverTarget(i.entry) })),
      presets: presets.map((p) => ({ id: p.id, name: p.name, detail: p.description })),
      templates: templates.map((t) => ({ id: t.id, name: t.name, detail: t.description }))
    }
  }, [skills, servers, presets, templates])

  const connectorCount = servers ? servers.filter((i) => i.entry.connectorId).length : 0

  // Everything starts ticked, once, when the lists arrive.
  useEffect(() => {
    if (!rows || initialised.current) return
    initialised.current = true
    setSelected({
      skills: new Set(rows.skills.map((r) => r.id)),
      servers: new Set(rows.servers.map((r) => r.id)),
      presets: new Set(rows.presets.map((r) => r.id)),
      templates: new Set(rows.templates.map((r) => r.id))
    })
  }, [rows])

  const total = selectedTotal(selected)
  const toggle = (g: KitGroupId, id: string, on: boolean): void => {
    setSelected((s) => {
      const next = new Set(s[g])
      if (on) next.add(id)
      else next.delete(id)
      return { ...s, [g]: next }
    })
  }
  const toggleGroup = (g: KitGroupId, on: boolean): void => {
    setSelected((s) => ({ ...s, [g]: on && rows ? new Set(rows[g].map((r) => r.id)) : new Set() }))
  }

  const save = async (): Promise<void> => {
    const api = kitApi()
    if (!api || !rows || saving || total === 0) return
    setError(null)
    setSaving(true)
    try {
      const path = await api.pickExportPath()
      if (!path) return
      const totals = { skills: rows.skills.length, servers: rows.servers.length, presets: rows.presets.length, templates: rows.templates.length }
      const result = await api.export({ path, include: selectionToInclude(selected, totals) })
      onSaved(result)
    } catch (e) {
      setError(cleanIpcError(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Export a kit"
      description="Choose what goes in. Secret values, sign-ins and folders are never included."
      testId="kit-export-dialog"
      footer={
        <>
          <span className="kit-count" role="status" aria-live="polite" data-testid="kit-export-count">
            {rows ? exportCountLine(total) : ''}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={!rows || total === 0} testId="kit-export-save" onClick={() => void save()}>
            Save kit...
          </Button>
        </>
      }
    >
      <div className="kit-export">
        {error && (
          <Banner tone="danger" title="Could not save the kit">
            {error}
          </Banner>
        )}
        {loadError && (
          <Banner tone="danger" title="Could not load your library">
            {loadError}
          </Banner>
        )}
        {!rows && !loadError && <div className="skeleton kit-skeleton" aria-busy="true" aria-label="Loading your library" />}
        {rows &&
          KIT_GROUPS.map((g) => (
            <KitGroup
              key={g}
              group={g}
              rows={rows[g]}
              selected={selected[g]}
              extraNote={g === 'servers' && connectorCount > 0 ? `${connectorCount} signed-in ${connectorCount === 1 ? 'service is' : 'services are'} left out. Their sign-ins stay on this computer.` : undefined}
              onToggle={(id, on) => toggle(g, id, on)}
              onToggleAll={(on) => toggleGroup(g, on)}
            />
          ))}
      </div>
    </Dialog>
  )
}

function KitGroup({
  group,
  rows,
  selected,
  extraNote,
  onToggle,
  onToggleAll
}: {
  group: KitGroupId
  rows: KitRow[]
  selected: Set<string>
  extraNote?: string
  onToggle: (id: string, on: boolean) => void
  onToggleAll: (on: boolean) => void
}): ReactElement {
  const state = groupState(selected.size, rows.length)
  const wrap = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const input = wrap.current?.querySelector('input')
    if (input) input.indeterminate = state === 'some'
  }, [state])
  const empty = rows.length === 0
  const note = GROUP_NOTE[group]
  return (
    <fieldset className="kit-group" data-testid="kit-group" data-group={group}>
      <legend>
        <span ref={wrap} className="kit-group-check">
          <Checkbox
            checked={state === 'all'}
            disabled={empty}
            onChange={(on) => onToggleAll(on)}
            label={`${KIT_GROUP_TITLE[group]} (${rows.length})`}
          />
        </span>
      </legend>
      {empty ? (
        <p className="kit-empty muted">Nothing to export.</p>
      ) : (
        <ul className="kit-items" aria-label={KIT_GROUP_TITLE[group]}>
          {rows.map((r) => (
            <li key={r.id} className="kit-item-row" data-testid="kit-item">
              <Checkbox
                checked={selected.has(r.id)}
                onChange={(on) => onToggle(r.id, on)}
                label={clampLabel(showHidden(r.name), 80)}
                description={r.detail ? <span className="kit-item-detail">{showHidden(r.detail)}</span> : undefined}
              />
            </li>
          ))}
        </ul>
      )}
      {(note || extraNote) && <p className="kit-note muted">{[note, extraNote].filter(Boolean).join(' ')}</p>}
    </fieldset>
  )
}
