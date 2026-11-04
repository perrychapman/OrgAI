import type { ReactElement, ReactNode } from 'react'
import { useId, useMemo, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { ConnectorCategory } from '@shared/types'
import { CONNECTOR_CATEGORIES } from '@shared/types'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { useConfirm } from '../ui/ConfirmDialog'
import { IconButton } from '../ui/IconButton'
import { Input } from '../ui/Input'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Select } from '../ui/Select'
import { Textarea } from '../ui/Textarea'
import {
  CATEGORY_LABELS,
  DEFAULT_TOKEN_HEADER,
  PRESET_ADDED_NOTE,
  PRESET_DESCRIPTION_MAX,
  PRESET_NAME_MAX,
  PRESET_VARIANTS_MAX,
  clampText,
  defToDraft,
  draftToDef,
  duplicateDraft,
  kebabId,
  newPresetDraft,
  newRid,
  newVariantDraft,
  presetErrorOrder,
  presetLocked,
  sameDraft,
  validatePreset
} from '../../lib/connectors'
import type { PresetAuthKind, PresetDraft, PresetTransport, PresetVariantDraft } from '../../lib/connectors'
import { connectorPresetsApi } from '../../lib/mcpScope'
import type { UserConnectorDef } from '../../lib/mcpScope'
import { errMessage } from '../mcp/mcpHelpers'

const CATEGORY_OPTIONS = CONNECTOR_CATEGORIES.map((c: ConnectorCategory) => ({ value: c, label: CATEGORY_LABELS[c] }))
const ACCESS_OPTIONS = [
  { value: 'read', label: 'Can read' },
  { value: 'write', label: 'Can read and change' }
]

/** A labelled field: label, control (given the ids to point aria-describedby at), hint and the error under it. */
function Field({
  id,
  label,
  hint,
  error,
  children
}: {
  id: string
  label: string
  hint?: string
  error?: string
  children: (describedBy: string | undefined) => ReactNode
}): ReactElement {
  const ids = [hint ? `${id}-hint` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ')
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(ids || undefined)}
      {hint && (
        <span id={`${id}-hint`} className="hint">
          {hint}
        </span>
      )}
      {error && (
        <span id={`${id}-err`} className="hint invalid-text">
          {error}
        </span>
      )}
    </div>
  )
}

/**
 * Add, edit or duplicate a preset: a service the user describes once (a remote address or a program, how it signs in, and
 * up to five access options). It saves through `connectorPresets.upsert`; main refuses what it dislikes and the refusal
 * shows at the top. Secret values are never asked here: a token is pasted when the service is added.
 */
export default function PresetForm({
  preset,
  duplicateOf,
  added = false,
  takenIds,
  takenNames,
  onClose,
  onSaved
}: {
  /** Edit this preset. */
  preset?: UserConnectorDef
  /** Start a new preset from this one. */
  duplicateOf?: UserConnectorDef
  /** The service has already been added to the MCP library (an edit then does not change it). */
  added?: boolean
  /** Every connector id in use (curated and presets), so a new id never collides. */
  takenIds: readonly string[]
  /** Preset names, so a duplicate gets a fresh one. */
  takenNames: readonly string[]
  onClose: () => void
  onSaved?: (def: UserConnectorDef) => void
}): ReactElement {
  const ids = useId()
  const initial = useMemo<PresetDraft>(
    () => (preset ? defToDraft(preset) : duplicateOf ? duplicateDraft(duplicateOf, takenNames) : newPresetDraft()),
    // The seed is read once when the form opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )
  const [draft, setDraft] = useState<PresetDraft>(initial)
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const bannerRef = useRef<HTMLDivElement>(null)
  const { confirm, dialog: confirmDialog } = useConfirm()
  const errors = validatePreset(draft)
  const err = (key: string): string | undefined => (shown ? errors[key] : undefined)
  const stdio = draft.transport === 'stdio'
  const locked = useMemo(() => (preset ? presetLocked(preset) : false), [preset])
  const formId = `${ids}-form`
  const fid = (key: string): string => `${ids}-${key}`

  const set = <K extends keyof PresetDraft>(key: K, value: PresetDraft[K]): void => setDraft((d) => ({ ...d, [key]: value }))
  const patchVariant = (rid: string, patch: Partial<PresetVariantDraft>): void =>
    setDraft((d) => ({ ...d, variants: d.variants.map((v) => (v.rid === rid ? { ...v, ...patch } : v)) }))

  const setTransport = (t: PresetTransport): void =>
    setDraft((d) => {
      if (d.transport === t) return d
      const next: PresetDraft = { ...d, transport: t, variants: d.variants.map((v) => ({ ...v, extra: '' })) }
      // Browser sign-in needs an address; the token's name differs between a header and a variable.
      if (t === 'stdio' && d.auth === 'oauth') next.auth = 'none'
      if (t === 'stdio' && d.tokenName === DEFAULT_TOKEN_HEADER) next.tokenName = ''
      if (t === 'http' && !d.tokenName.trim()) next.tokenName = DEFAULT_TOKEN_HEADER
      return next
    })
  const setAuth = (a: PresetAuthKind): void =>
    setDraft((d) => ({ ...d, auth: a, tokenName: a === 'token' && !d.tokenName.trim() && d.transport === 'http' ? DEFAULT_TOKEN_HEADER : d.tokenName }))

  const dirty = !sameDraft(draft, initial)
  const requestClose = async (): Promise<void> => {
    if (busy) return
    if (dirty) {
      const ok = await confirm({ title: 'Discard your changes?', body: <p>The preset has not been saved.</p>, confirmLabel: 'Discard changes', danger: true })
      if (!ok) return
    }
    onClose()
  }

  const save = async (): Promise<void> => {
    if (busy) return
    if (preset && !dirty) {
      onClose()
      return
    }
    setShown(true)
    const first = presetErrorOrder(draft).find((k) => errors[k])
    if (first) {
      window.setTimeout(() => document.getElementById(fid(first))?.focus(), 0)
      return
    }
    const api = connectorPresetsApi()
    if (!api) {
      setSaveError('Presets are not available in this version of OrgAI.')
      return
    }
    const id = preset?.id ?? kebabId(draft.name, new Set(takenIds))
    const def = draftToDef(draft, id, preset?.origin, preset)
    setBusy(true)
    setSaveError(null)
    try {
      await api.upsert(def)
      onSaved?.(def)
      onClose()
    } catch (e) {
      setSaveError(clampText(errMessage(e), 300))
      setBusy(false)
      window.setTimeout(() => bannerRef.current?.focus(), 0)
    }
  }

  const rowLabel = stdio ? 'variable' : 'header'

  return (
    <Dialog
      open
      onClose={() => void requestClose()}
      title={preset ? `Edit ${clampText(preset.name, 40)}` : 'Add a preset'}
      description="Describe how to reach the service. Secret values are entered when you add it, never here."
      size="lg"
      testId="preset-form"
      footer={
        <>
          <Button onClick={() => void requestClose()} disabled={busy}>
            Cancel
          </Button>
          <button type="submit" form={formId} className="btn primary" data-testid="preset-save" disabled={busy} aria-busy={busy || undefined}>
            {busy ? 'Saving…' : 'Save preset'}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="preset-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {saveError && (
          <div ref={bannerRef} tabIndex={-1} className="preset-banner">
            <Banner tone="danger" title="Could not save the preset" testId="preset-error">
              {saveError}
            </Banner>
          </div>
        )}
        {preset && added && (
          <p className="muted" data-testid="preset-added-note">
            {PRESET_ADDED_NOTE}
          </p>
        )}

        {locked && (
          <p className="muted" data-testid="preset-locked-note">
            This preset has settings this form cannot edit; they are kept as they are.
          </p>
        )}

        <Field id={fid('name')} label="Name" hint="Shown on the tile." error={err('name')}>
          {(d) => (
            <Input
              id={fid('name')}
              data-autofocus=""
              data-testid="preset-name"
              value={draft.name}
              maxLength={PRESET_NAME_MAX * 2}
              autoComplete="off"
              invalid={!!err('name')}
              aria-describedby={d}
              onChange={(v) => set('name', v)}
            />
          )}
        </Field>
        <Field id={fid('description')} label="What it does" hint="One line, shown under the name." error={err('description')}>
          {(d) => (
            <Input
              id={fid('description')}
              data-testid="preset-description"
              value={draft.description}
              maxLength={PRESET_DESCRIPTION_MAX * 2}
              autoComplete="off"
              invalid={!!err('description')}
              aria-describedby={d}
              onChange={(v) => set('description', v)}
            />
          )}
        </Field>
        <Field id={fid('category')} label="Category">
          {(d) => (
            <div data-testid="preset-category">
              <Select id={fid('category')} value={draft.category} options={CATEGORY_OPTIONS} describedBy={d} onChange={(v) => set('category', v as ConnectorCategory)} />
            </div>
          )}
        </Field>
        <Field id={fid('aliases')} label="Search words (optional)" hint="Other names people might search for, separated by commas." error={err('aliases')}>
          {(d) => (
            <Input
              id={fid('aliases')}
              data-testid="preset-aliases"
              value={draft.aliases}
              autoComplete="off"
              invalid={!!err('aliases')}
              aria-describedby={d}
              onChange={(v) => set('aliases', v)}
            />
          )}
        </Field>

        <div className="field">
          <span className="preset-legend" aria-hidden="true">
            How it connects
          </span>
          <div data-testid="preset-transport">
            {locked ? (
              <p className="muted">{stdio ? 'Program on this computer' : 'Remote address'}</p>
            ) : (
              <SegmentedControl
                label="How it connects"
                value={draft.transport}
                options={[
                  { value: 'http', label: 'Remote address' },
                  { value: 'stdio', label: 'Program on this computer' }
                ]}
                onChange={setTransport}
              />
            )}
          </div>
        </div>
        {stdio ? (
          <>
            <Field id={fid('command')} label="Command" hint="Runs on this computer each time an agent uses it. Pin exact versions." error={err('command')}>
              {(d) => (
                <Input
                  id={fid('command')}
                  mono
                  data-testid="preset-command"
                  value={draft.command}
                  readOnly={locked}
                  placeholder="npx"
                  autoComplete="off"
                  spellCheck={false}
                  invalid={!!err('command')}
                  aria-describedby={d}
                  onChange={(v) => set('command', v)}
                />
              )}
            </Field>
            <Field id={fid('args')} label="Arguments" hint="One argument per line." error={err('args')}>
              {(d) => (
                <Textarea
                  id={fid('args')}
                  mono
                  rows={3}
                  data-testid="preset-args"
                  value={draft.args}
                  readOnly={locked}
                  placeholder={'-y\n@acme/server@1.2.3'}
                  spellCheck={false}
                  invalid={!!err('args')}
                  aria-describedby={d}
                  onChange={(v) => set('args', v)}
                />
              )}
            </Field>
          </>
        ) : (
          <Field id={fid('url')} label="Address" error={err('url')}>
            {(d) => (
              <Input
                id={fid('url')}
                mono
                data-testid="preset-url"
                value={draft.url}
                readOnly={locked}
                placeholder="https://example.com/mcp"
                autoComplete="off"
                spellCheck={false}
                invalid={!!err('url')}
                aria-describedby={d}
                onChange={(v) => set('url', v)}
              />
            )}
          </Field>
        )}

        <fieldset className="preset-set" data-testid="preset-auth" data-auth={draft.auth} disabled={locked}>
          <legend>Sign-in</legend>
          <label className="preset-radio">
            <input id={fid('auth')} type="radio" name={`${ids}-auth`} checked={draft.auth === 'none'} onChange={() => setAuth('none')} />
            <span>No sign-in needed</span>
          </label>
          <label className="preset-radio">
            <input type="radio" name={`${ids}-auth`} checked={draft.auth === 'token'} onChange={() => setAuth('token')} />
            <span>Paste a token</span>
          </label>
          {draft.auth === 'token' && (
            <div className="preset-sub">
              <Field
                id={fid('tokenName')}
                label={stdio ? 'Variable name' : 'Header name'}
                hint={stdio ? 'The token is passed to the program in this environment variable.' : 'The token is sent in this header.'}
                error={err('tokenName')}
              >
                {(d) => (
                  <Input
                    id={fid('tokenName')}
                    mono
                    data-testid="preset-token-name"
                    value={draft.tokenName}
                    placeholder={stdio ? 'API_TOKEN' : DEFAULT_TOKEN_HEADER}
                    autoComplete="off"
                    spellCheck={false}
                    invalid={!!err('tokenName')}
                    aria-describedby={d}
                    onChange={(v) => set('tokenName', v)}
                  />
                )}
              </Field>
              {!stdio && (
                <Field id={fid('tokenPrefix')} label="Prefix (optional)" hint="Put before the token, such as Bearer.">
                  {(d) => (
                    <Input
                      id={fid('tokenPrefix')}
                      mono
                      data-testid="preset-token-prefix"
                      value={draft.tokenPrefix}
                      placeholder="Bearer"
                      autoComplete="off"
                      spellCheck={false}
                      aria-describedby={d}
                      onChange={(v) => set('tokenPrefix', v)}
                    />
                  )}
                </Field>
              )}
              <Field id={fid('tokenHelp')} label="Where to get it (optional)" hint="Must start with https://. Shown as a link when someone adds the service." error={err('tokenHelp')}>
                {(d) => (
                  <Input
                    id={fid('tokenHelp')}
                    mono
                    data-testid="preset-token-help"
                    value={draft.tokenHelp}
                    placeholder="https://example.com/account/tokens"
                    autoComplete="off"
                    spellCheck={false}
                    invalid={!!err('tokenHelp')}
                    aria-describedby={d}
                    onChange={(v) => set('tokenHelp', v)}
                  />
                )}
              </Field>
            </div>
          )}
          <label className="preset-radio">
            <input type="radio" name={`${ids}-auth`} checked={draft.auth === 'oauth'} disabled={stdio} aria-describedby={stdio ? fid('oauth-why') : undefined} onChange={() => setAuth('oauth')} />
            <span>Sign in with the browser</span>
          </label>
          {stdio && (
            <p id={fid('oauth-why')} className="hint preset-why" data-testid="preset-oauth-why">
              Browser sign-in works only with a remote address.
            </p>
          )}
        </fieldset>

        <fieldset className="preset-set" data-testid="preset-fixed" disabled={locked}>
          <legend>{stdio ? 'Other variables' : 'Other headers'}</legend>
          {draft.rows.length === 0 && <p className="muted">{stdio ? 'No other variables.' : 'No other headers.'}</p>}
          {draft.rows.map((r, i) => (
            <div key={r.rid} className="preset-row">
              <Input
                id={fid(`row:${r.rid}`)}
                mono
                value={r.name}
                placeholder="NAME"
                aria-label={`Name of ${rowLabel} ${i + 1}`}
                aria-describedby={err(`row:${r.rid}`) ? fid(`row:${r.rid}-err`) : undefined}
                invalid={!!err(`row:${r.rid}`)}
                autoComplete="off"
                spellCheck={false}
                onChange={(v) => set('rows', draft.rows.map((x) => (x.rid === r.rid ? { ...x, name: v } : x)))}
              />
              <Input
                mono
                value={r.value}
                placeholder="Value"
                aria-label={`Value of ${rowLabel} ${r.name || i + 1}`}
                autoComplete="off"
                spellCheck={false}
                onChange={(v) => set('rows', draft.rows.map((x) => (x.rid === r.rid ? { ...x, value: v } : x)))}
              />
              <IconButton icon={Trash2} label={`Remove ${rowLabel} ${r.name || i + 1}`} size="sm" onClick={() => set('rows', draft.rows.filter((x) => x.rid !== r.rid))} />
              {err(`row:${r.rid}`) && (
                <span id={fid(`row:${r.rid}-err`)} className="hint invalid-text preset-row-err">
                  {err(`row:${r.rid}`)}
                </span>
              )}
            </div>
          ))}
          <div>
            <Button size="sm" icon={Plus} testId="preset-fixed-add" onClick={() => set('rows', [...draft.rows, { rid: newRid(), name: '', value: '' }])}>
              {stdio ? 'Add variable' : 'Add header'}
            </Button>
          </div>
          <p className="hint">Values here are saved with the preset and travel in a practice kit. Do not put secrets here.</p>
        </fieldset>

        <fieldset className="preset-set" data-testid="preset-variants">
          <legend>Access options</legend>
          <p className="hint">Offer a read-only option first if the service has one. People pick an option when they add the service.</p>
          {draft.variants.map((v, i) => {
            const n = v.label.trim() || `option ${i + 1}`
            const e = err(`variant:${v.rid}`)
            return (
              <div key={v.rid} className="preset-variant" data-testid="preset-variant">
                <div className="preset-cell">
                  <label htmlFor={fid(`variant:${v.rid}`)}>Label</label>
                  <Input
                    id={fid(`variant:${v.rid}`)}
                    value={v.label}
                    placeholder="Read only"
                    autoComplete="off"
                    invalid={!!e}
                    aria-describedby={e ? fid(`variant:${v.rid}-err`) : undefined}
                    onChange={(val) => patchVariant(v.rid, { label: val })}
                  />
                </div>
                <div className="preset-cell">
                  <label htmlFor={fid(`access:${v.rid}`)}>Access</label>
                  <Select id={fid(`access:${v.rid}`)} value={v.readOnly ? 'read' : 'write'} options={ACCESS_OPTIONS} onChange={(val) => patchVariant(v.rid, { readOnly: val === 'read' })} />
                </div>
                <div className="preset-cell preset-cell-extra">
                  <label htmlFor={fid(`extra:${v.rid}`)}>{stdio ? 'Extra arguments (optional)' : 'Address for this option (optional)'}</label>
                  {stdio ? (
                    <Textarea
                      id={fid(`extra:${v.rid}`)}
                      mono
                      rows={1}
                      value={v.extra}
                      readOnly={locked}
                      placeholder="One per line"
                      spellCheck={false}
                      onChange={(val) => patchVariant(v.rid, { extra: val })}
                    />
                  ) : (
                    <Input
                      id={fid(`extra:${v.rid}`)}
                      mono
                      value={v.extra}
                      readOnly={locked}
                      placeholder="Uses the address above"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(val) => patchVariant(v.rid, { extra: val })}
                    />
                  )}
                </div>
                <label className="preset-default">
                  <input
                    type="radio"
                    name={`${ids}-default`}
                    checked={draft.defaultRid === v.rid}
                    aria-label={`Default: ${n}`}
                    onChange={() => set('defaultRid', v.rid)}
                  />
                  <span>Default</span>
                </label>
                <div className="preset-remove">
                  <IconButton
                    icon={Trash2}
                    label={`Remove access option ${n}`}
                    size="sm"
                    disabled={draft.variants.length <= 1}
                    onClick={() =>
                      setDraft((d) => {
                        const rest = d.variants.filter((x) => x.rid !== v.rid)
                        return { ...d, variants: rest, defaultRid: d.defaultRid === v.rid ? rest[0].rid : d.defaultRid }
                      })
                    }
                  />
                </div>
                {e && (
                  <span id={fid(`variant:${v.rid}-err`)} className="hint invalid-text preset-variant-err">
                    {e}
                  </span>
                )}
              </div>
            )
          })}
          <div className="preset-variant-foot">
            <Button
              size="sm"
              icon={Plus}
              testId="preset-variant-add"
              disabled={draft.variants.length >= PRESET_VARIANTS_MAX}
              onClick={() => {
                const v = newVariantDraft('', true)
                setDraft((d) => ({ ...d, variants: [...d.variants, v] }))
                window.setTimeout(() => document.getElementById(fid(`variant:${v.rid}`))?.focus(), 0)
              }}
            >
              Add an access option
            </Button>
            {draft.variants.length >= PRESET_VARIANTS_MAX && <span className="hint">Five is the most.</span>}
          </div>
        </fieldset>
      </form>
      {confirmDialog}
    </Dialog>
  )
}
