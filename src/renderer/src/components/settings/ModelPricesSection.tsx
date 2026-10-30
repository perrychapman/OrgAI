import type { ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pencil, Plus, RotateCcw } from 'lucide-react'
import type { ConnectionId, ModelPriceInfo, ModelPriceOverride } from '@shared/types'
import { CONNECTION_IDS } from '@shared/types'
import { MODEL_PRICE_ID_MAX_CHARS } from '@shared/defaults'
import { CONNECTION_NAME } from '../../lib/settingsCopy'
import { displayPerMTok, draftFromInfo, EMPTY_DRAFT, upsertOverride, removeOverride, validateDraft } from '../../lib/modelPrices'
import type { PriceDraft, PriceErrors, PriceField } from '../../lib/modelPrices'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Input } from '../ui/Input'
import { Select } from '../ui/Select'
import { SettingsCard } from './SettingsCard'

const SOURCE_LABEL: Record<ModelPriceInfo['source'], string> = { override: 'Override', proxy: 'Proxy', builtin: 'Built-in', community: 'Community list' }

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

  const open = (next: Editing): void => {
    setEditing(next)
    setErrors({})
    setSaveError(null)
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ block: 'nearest' })
      document.getElementById('model-price-model')?.focus()
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
    setSaveError(null)
    await persist(removeOverride(overrides, row.model, row.connection))
  }

  const set = (p: Partial<PriceDraft>): void => {
    if (!editing) return
    setEditing({ ...editing, draft: { ...editing.draft, ...p } })
    setErrors({})
  }

  const rowKey = (r: ModelPriceInfo): string => `${r.connection ?? ''}|${r.model}|${r.source}`

  return (
    <>
      <div className="model-prices" data-testid="model-prices">
        <p className="muted model-prices-lead">
          USD per million tokens, used to estimate cost when the provider does not report it. An override wins over a proxy price, and a proxy price wins over the built-in table.
        </p>
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
            {rows.length === 0 ? (
              <p className="settings-card-note" data-testid="model-prices-empty">
                No prices are known yet. Add an override to price a model.
              </p>
            ) : (
              <table className="model-prices-table">
                <caption className="sr-only">Model prices in USD per million tokens</caption>
                <thead>
                  <tr>
                    <th scope="col">Model</th>
                    <th scope="col">Source</th>
                    <th scope="col" className="num">Input</th>
                    <th scope="col" className="num">Output</th>
                    <th scope="col" className="num">Cache read</th>
                    <th scope="col" className="num">Cache write</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
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
        {!editing && (
          <div>
            <Button icon={Plus} testId="model-price-add" onClick={() => open({ draft: EMPTY_DRAFT })}>
              Add override
            </Button>
          </div>
        )}
      </div>
    </>
  )
}
