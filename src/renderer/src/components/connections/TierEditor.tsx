import type { ReactElement } from 'react'
import { useEffect, useId, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ConnectionInfo, ModelRef, ModelTier, ProviderConnection, ProviderModel } from '@shared/types'
import { MODEL_TIER_OPTIONS } from '@shared/types'
import { defaultTierModels, projectConnection } from '@shared/defaults'
import { useAppStore } from '../../store/useAppStore'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { ModelSelect, type ModelGroup } from '../ui/ModelSelect'
import RemapPreviewDialog from '../RemapPreviewDialog'
import { FAMILY_LABEL, groupByFamily, previewRemap } from '../../lib/remap'

type Draft = Partial<Record<ModelTier, ModelRef>>
const same = (a: Draft, b: Draft): boolean => MODEL_TIER_OPTIONS.every((o) => (a[o.value] ?? '') === (b[o.value] ?? ''))

/** Staged tier mapping editor: edits are applied or discarded deliberately. */
export default function TierEditor({
  info,
  models,
  onSave
}: {
  info: ConnectionInfo
  models: ProviderModel[]
  onSave: (c: ProviderConnection) => Promise<ConnectionInfo>
}): ReactElement {
  const id = info.connection.id
  const saved = info.connection.tierModels
  const [draft, setDraft] = useState<Draft>(saved)
  const [preview, setPreview] = useState(false)
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const projects = useAppStore((s) => s.projects)
  const dirty = !same(draft, saved)

  // Pick up changes from outside (events, other windows) while there are no staged edits.
  useEffect(() => {
    if (!dirty) setDraft(saved)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved])

  const groups: ModelGroup[] = useMemo(
    () => groupByFamily(models).map((g) => ({ label: FAMILY_LABEL[g.family], options: g.models.map((m) => ({ value: m.id, label: m.id })) })),
    [models]
  )
  const known = new Set(models.map((m) => m.id))

  const affected = useMemo(
    () =>
      projects
        .filter((p) => projectConnection(p) === id)
        .map((p) => previewRemap({ project: p, connection: id, tierModels: draft, previousTierModels: saved, catalog: models, switching: false })),
    [projects, id, draft, saved, models]
  )
  const hasImpact = affected.some((a) => a.changes.length > 0)

  const apply = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await onSave({ ...info.connection, tierModels: draft } as ProviderConnection)
      setPreview(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const stale = MODEL_TIER_OPTIONS.filter((o) => draft[o.value] && !known.has(draft[o.value]!))

  return (
    <div className="tier-editor">
      <div className="tier-head">
        <button type="button" className="group-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
          <Icon icon={open ? ChevronDown : ChevronRight} size="sm" />
          <strong>Model tiers (advanced)</strong>
        </button>
        {open && (
          <Button size="sm" variant="ghost" onClick={() => setDraft(defaultTierModels(models))}>
            Reset
          </Button>
        )}
      </div>
      {open && (
      <div id={bodyId} className="tier-rows">
        {MODEL_TIER_OPTIONS.map((o, i) => {
          const value = draft[o.value] ?? ''
          const invalid = !!value && !known.has(value)
          const dup = MODEL_TIER_OPTIONS.slice(0, i).find((p) => value && draft[p.value] === value)
          return (
            <div key={o.value} className="tier-row">
              <div className="tier-label">
                <strong>{o.label}</strong>
                <span className="muted">{{ top: 'Most capable. Orchestrators and hard problems.', deep: 'Strong reasoning for senior roles.', everyday: 'Default for most roles.', fast: 'Cheap and quick. Lookups and simple edits.' }[o.value]}</span>
              </div>
              <ModelSelect
                label={`${o.label} model`}
                hideLabel
                value={value}
                groups={invalid ? [{ options: [{ value, label: `${value} (unavailable)`, disabled: true }] }, ...groups] : groups}
                placeholder="No model"
                invalid={invalid}
                message={invalid ? `${value} is no longer available. Pick another.` : dup ? `Same model as ${dup.label}` : undefined}
                onChange={(v) => setDraft({ ...draft, [o.value]: v })}
                testId="tier-select"
                dataTier={o.value}
              />
            </div>
          )
        })}
      </div>
      )}
      {stale.length > 0 && <Banner tone="warning">Some tiers point at models that are no longer in the catalog.</Banner>}
      {dirty && (
        <div className="tier-foot">
          <Button variant="primary" loading={busy} onClick={() => (hasImpact ? setPreview(true) : void apply())}>
            Apply mapping
          </Button>
          <Button onClick={() => setDraft(saved)} disabled={busy}>
            Discard
          </Button>
          {error && <span className="invalid-text">{error}</span>}
        </div>
      )}
      <RemapPreviewDialog open={preview} projects={affected} busy={busy} error={error} onCancel={() => setPreview(false)} onConfirm={() => void apply()} />
    </div>
  )
}
