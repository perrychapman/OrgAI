import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pencil, Plus, RotateCcw } from 'lucide-react'
import type { ConnectionId, ModelPriceInfo, ModelPriceOverride } from '@shared/types'
import { CONNECTION_IDS } from '@shared/types'
import { MODEL_PRICE_ID_MAX_CHARS } from '@shared/defaults'
import { CONNECTION_NAME } from '../../lib/settingsCopy'
import { displayPerMTok, draftFromInfo, EMPTY_DRAFT, upsertOverride, removeOverride, validateDraft, visiblePriceRows } from '../../lib/modelPrices'
import { APP_SETTINGS_SECTIONS, takeModelPriceTarget } from '../../lib/settingsTarget'
import { scrollWithin } from '../../lib/scrollWithin'
import { useAppStore } from '../../store/useAppStore'
import type { PriceDraft, PriceErrors, PriceField } from '../../lib/modelPrices'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Input } from '../ui/Input'
import { Select } from '../ui/Select'
import { useConfirm } from '../ui/ConfirmDialog'
import { SettingsCard } from './SettingsCard'
import { SettingsSection } from './SettingsSection'

const SOURCE_LABEL: Record<ModelPriceInfo['source'], string> = { override: 'Override', proxy: 'Proxy', builtin: 'Built-in' }

const FIELDS: { field: Exclude<PriceField, 'model'>; label: string; optional: boolean }[] = [
  { field: 'input', label: 'Input', optional: false },
  { field: 'output', label: 'Output', optional: false },
  { field: 'cacheRead', label: 'Cache read', optional: true },
  { field: 'cacheWrite', label: 'Cache write', optional: true }
]

interface Editing {
  draft: PriceDraft
  /** The override being edited, so a rename replaces it. Undefined for a new override. */
  replacing?: { model: string; connection?: ConnectionId }
}

/**
 * App settings > Connections > Model prices. Lists models.prices (USD per million tokens) and edits the user's
 * overrides. `overrides` is AppSettings.modelPrices; `onSave` persists a new list and rejects with the save error.
 */
export function ModelPricesSection({ overrides, onSave }: { overrides: readonly ModelPriceOverride[]; onSave: (next: ModelPriceOverride[]) => Promise<void> }): ReactElement {
  const [rows, setRows] = useState<ModelPriceInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [errors, setErrors] = useState<PriceErrors>({})
  const [saveError, setSaveError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setRows(await window.orgai.models.prices())
      setLoadError(null)
    } catch (e) {
      setLoadError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  // "Set a price" from an unknown cost lands here with the model id to price.
  useEffect(() => {
    const model = takeModelPriceTarget()
    if (model) open({ draft: { ...EMPTY_DRAFT, model } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const { confirm, dialog } = useConfirm()
  const [showAll, setShowAll] = useState(false)
  const runs = useAppStore((s) => s.runs)
  const projects = useAppStore((s) => s.projects)
  // Models the user's work touches: used by loaded runs, or set on a project's roles.
  const inUse = useMemo(() => {
    const ids = new Set<string>()
    for (const r of Object.values(runs)) {
      for (const m of r.summary.usage?.models ?? []) ids.add(m.model)
      for (const a of Object.values(r.agents)) {
        if (a.model) ids.add(a.model)
        for (const m of a.usage?.models ?? []) ids.add(m.model)
      }
    }
    for (const p of projects) for (const role of p.roles) if (role.model && role.model !== 'inherit') ids.add(role.model)
    return ids
  }, [runs, projects])

  const open = (next: Editing): void => {
    setEditing(next)
    setErrors({})
    setSaveError(null)
    requestAnimationFrame(() => {
      scrollWithin(formRef.current, 'start')
      // Focus the first empty field (the model id, unless a deep link pre-filled it); the form is already in view.
      const empty = (['model-price-model', 'model-price-input'] as const).find((id) => !(document.getElementById(id) as HTMLInputElement | null)?.value)
      document.getElementById(empty ?? 'model-price-model')?.focus({ preventScroll: true })
    })
  }
  const close = (): void => {
    setEditing(null)
    setErrors({})
    setSaveError(null)
  }

  const persist = async (next: ModelPriceOverride[]): Promise<boolean> => {
    setBusy(true)
    try {
      await onSave(next)
      await load()
      return true
    } catch (e) {
      setSaveError((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }

  const submit = async (): Promise<void> => {
    if (!editing) return
    const result = validateDraft(editing.draft)
    if ('errors' in result) {
      setErrors(result.errors)
      const first = (['model', ...FIELDS.map((f) => f.field)] as PriceField[]).find((f) => result.errors[f])
      if (first) document.getElementById(`model-price-${first}`)?.focus()
      return
    }
    const merged = upsertOverride(overrides, result.override, editing.replacing)
    if ('error' in merged) {
      setSaveError(merged.error)
      return
    }
    if (await persist(merged.list)) close()
  }

  const clear = async (row: ModelPriceInfo): Promise<void> => {
    const ok = await confirm({
      title: `Clear the override for ${row.model}?`,
      body: 'The model goes back to its proxy or built-in price. Costs already recorded do not change.',
      confirmLabel: 'Clear override',
      danger: true
    })
    if (!ok) return
    setSaveError(null)
    await persist(removeOverride(overrides, row.model, row.connection))
  }

  const set = (p: Partial<PriceDraft>): void => {
    if (!editing) return
    setEditing({ ...editing, draft: { ...editing.draft, ...p } })
    setErrors({})
  }

  const rowKey = (r: ModelPriceInfo): string => `${r.connection ?? ''}|${r.model}|${r.source}`

  const shown = rows ? visiblePriceRows(rows, inUse, showAll) : []

  return (
    <SettingsSection
      id={APP_SETTINGS_SECTIONS.modelPrices}
      title="Model prices"
      description="USD per million tokens, used to estimate cost when the provider does not report it. An override wins over a proxy price, and a proxy price wins over the built-in table."
      actions={
        <Button icon={Plus} testId="model-price-add" disabled={!!editing} onClick={() => open({ draft: EMPTY_DRAFT })}>
          Add override
        </Button>
      }
    >
      <div className="model-prices" data-testid="model-prices">
        {saveError && !editing && (
          <Banner tone="danger" title="Could not save prices">
            {saveError}
          </Banner>
        )}
        {editing && (
          <form
            ref={formRef}
            className="model-prices-form"
            data-testid="model-price-form"
            aria-label={editing.replacing ? `Edit price for ${editing.replacing.model}` : 'Add a price override'}
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <div className="model-prices-form-grid">
              <div className="field model-prices-model">
                <label htmlFor="model-price-model">Model id</label>
                <Input
                  id="model-price-model"
                  mono
                  value={editing.draft.model}
                  maxLength={MODEL_PRICE_ID_MAX_CHARS}
                  placeholder="e.g. gpt-5"
                  spellCheck={false}
                  invalid={!!errors.model}
                  aria-describedby={errors.model ? 'model-price-model-error' : undefined}
                  onChange={(model) => set({ model })}
                />
                {errors.model && (
                  <span className="field-error" id="model-price-model-error" aria-live="polite">
                    {errors.model}
                  </span>
                )}
              </div>
              <div className="field model-prices-conn">
                <label htmlFor="model-price-connection">Connection</label>
                <Select
                  id="model-price-connection"
                  value={editing.draft.connection}
                  options={[{ value: '', label: 'Every connection' }, ...CONNECTION_IDS.map((id) => ({ value: id, label: CONNECTION_NAME[id] }))]}
                  onChange={(connection) => set({ connection: connection as '' | ConnectionId })}
                />
              </div>
              {FIELDS.map(({ field, label, optional }) => (
                <div className="field" key={field}>
                  <label htmlFor={`model-price-${field}`}>
                    {label}
                    {optional && <span className="muted"> (optional)</span>}
                  </label>
                  <Input
                    id={`model-price-${field}`}
                    mono
                    inputMode="decimal"
                    value={editing.draft[field]}
                    placeholder={optional ? 'None' : '0'}
                    spellCheck={false}
                    invalid={!!errors[field]}
                    aria-describedby={errors[field] ? `model-price-${field}-error` : undefined}
                    onChange={(v) => set({ [field]: v } as Partial<PriceDraft>)}
                  />
                  {errors[field] && (
                    <span className="field-error" id={`model-price-${field}-error`} aria-live="polite">
                      {errors[field]}
                    </span>
                  )}
                </div>
              ))}
            </div>
            {saveError && (
              <p className="field-error" role="alert">
                {saveError}
              </p>
            )}
            <div className="model-prices-form-actions">
              <Button type="submit" variant="primary" loading={busy} testId="model-price-save">
                Save override
              </Button>
              <Button onClick={close}>Cancel</Button>
            </div>
          </form>
        )}
        {loadError && !rows ? (
          <Banner tone="danger" title="Could not load model prices" actions={<Button size="sm" onClick={() => void load()}>Retry</Button>}>
            {loadError}
          </Banner>
        ) : !rows ? (
          <div className="model-prices-skeleton" aria-busy="true" aria-label="Loading model prices">
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        ) : (
          <SettingsCard>
            {rows.length === 0 || shown.length === 0 ? (
              <p className="settings-card-note" data-testid="model-prices-empty">
                {rows.length === 0 ? 'No prices are known yet. Add an override to price a model.' : 'No overrides yet and none of your models are listed. Add an override, or show all prices.'}
              </p>
            ) : (
              <table className="model-prices-table">
                <caption className="sr-only">Model prices in USD per million tokens</caption>
                <thead>
                  <tr>
                    <th scope="col">Model</th>
                    <th scope="col">Source</th>
                    <th scope="col" className="num">Input<span className="sr-only"> per 1M tokens</span></th>
                    <th scope="col" className="num">Output</th>
                    <th scope="col" className="num">Cache read</th>
                    <th scope="col" className="num">Cache write</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={rowKey(r)} data-testid="model-price-row" data-model={r.model} data-source={r.source}>
                      <th scope="row" className="model-prices-name">
                        <span className="mono" title={r.model}>
                          {r.model}
                        </span>
                        {r.connection && <span className="muted"> · {CONNECTION_NAME[r.connection]}</span>}
                      </th>
                      <td data-label="Source">
                        <span className="model-prices-source">{SOURCE_LABEL[r.source]}</span>
                      </td>
                      <td className="num mono" data-label="Input">{displayPerMTok(r.price.inputPerToken)}</td>
                      <td className="num mono" data-label="Output">{displayPerMTok(r.price.outputPerToken)}</td>
                      <td className="num mono" data-label="Cache read">{displayPerMTok(r.price.cacheReadPerToken)}</td>
                      <td className="num mono" data-label="Cache write">{displayPerMTok(r.price.cacheCreationPerToken)}</td>
                      <td className="model-prices-actions">
                        <IconButton
                          icon={Pencil}
                          size="sm"
                          label={r.source === 'override' ? `Edit override for ${r.model}` : `Override price for ${r.model}`}
                          testId="model-price-edit"
                          onClick={() => open({ draft: draftFromInfo(r), replacing: r.source === 'override' ? { model: r.model, connection: r.connection } : undefined })}
                        />
                        {r.source === 'override' && (
                          <IconButton icon={RotateCcw} size="sm" label={`Clear override for ${r.model}`} testId="model-price-clear" disabled={busy} onClick={() => void clear(r)} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SettingsCard>
        )}
        {rows && rows.length > shown.length && !showAll && (
          <p className="settings-card-note model-prices-more">
            Showing overrides and models you use.{' '}
            <button type="button" className="link-btn" data-testid="model-prices-show-all" onClick={() => setShowAll(true)}>
              Show all {rows.length} prices
            </button>
          </p>
        )}
        {showAll && rows && visiblePriceRows(rows, inUse, false).length < rows.length && (
          <p className="settings-card-note model-prices-more">
            <button type="button" className="link-btn" onClick={() => setShowAll(false)}>
              Show only overrides and models in use
            </button>
          </p>
        )}
      </div>
      {dialog}
    </SettingsSection>
  )
}
