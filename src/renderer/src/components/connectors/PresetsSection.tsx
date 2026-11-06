import type { KeyboardEvent, ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Ellipsis, Pencil, Plus, Puzzle, Trash2 } from 'lucide-react'
import type { ConnectorInfo } from '@shared/types'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { useConfirm } from '../ui/ConfirmDialog'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import { SettingsSection } from '../settings/SettingsSection'
import { accessOptionCount, canAddPreset, clampText, infoEase, presetKindWord, stateChip } from '../../lib/connectors'
import { connectorPresetsApi, isCustomConnector, presetOf } from '../../lib/mcpScope'
import { errMessage } from '../mcp/mcpHelpers'
import { ConnectorLogo } from './ConnectorLogo'
import { CustomBadge, EaseBadge } from './ConnectorTile'
import PresetForm from './PresetForm'
import { useConnectors } from './useConnectors'

type FormState = { kind: 'add' } | { kind: 'edit'; info: ConnectorInfo } | { kind: 'duplicate'; info: ConnectorInfo }

function onMenuKey(e: KeyboardEvent<HTMLDivElement>): void {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
  if (!keys.includes(e.key)) return
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)'))
  if (items.length === 0) return
  e.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLButtonElement)
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
  items[next]?.focus()
}

/** "Connected", "Not added", or why an added one is not ready. */
function presetState(info: ConnectorInfo): { label: string; tone: 'success' | 'neutral' | 'attention' | 'danger' } {
  if (info.state === 'connected') return { label: 'Connected', tone: 'success' }
  if (!info.library) return { label: 'Not added', tone: 'neutral' }
  const chip = stateChip(info)
  return { label: chip.label, tone: chip.tone === 'warning' ? 'attention' : chip.tone === 'success' ? 'success' : chip.tone }
}

/**
 * App settings > Connectors > Your presets: services the user describes once. They show as tiles in the gallery above.
 * Hidden when this build has no preset API.
 */
export default function PresetsSection(): ReactElement | null {
  const api = connectorPresetsApi()
  const { connectors, error, refresh } = useConnectors()
  const [form, setForm] = useState<FormState | null>(null)
  const [notice, setNotice] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [pendingFocus, setPendingFocus] = useState<{ removed: string; next: string | null } | null>(null)
  const rootRef = useRef<HTMLElement>(null)
  const { confirm, dialog } = useConfirm()
  const presets = useMemo(
    () => (connectors ?? []).filter(isCustomConnector).sort((a, b) => a.connector.name.localeCompare(b.connector.name)),
    [connectors]
  )

  // After a removal, focus the next row's Edit, else "Add a preset".
  useEffect(() => {
    if (!pendingFocus || !connectors) return
    if (connectors.some((c) => c.connector.id === pendingFocus.removed)) return
    const root = rootRef.current
    const target =
      (pendingFocus.next ? root?.querySelector<HTMLElement>(`[data-testid=preset-row][data-preset="${pendingFocus.next}"] [data-testid=preset-edit]`) : null) ??
      root?.querySelector<HTMLElement>('[data-testid=preset-add]')
    target?.focus()
    setPendingFocus(null)
  }, [pendingFocus, connectors])

  if (!api) return null

  const remove = async (info: ConnectorInfo): Promise<void> => {
    const name = clampText(info.connector.name, 60)
    setProblem(null)
    if (info.library) {
      setProblem(`Remove ${name} from the MCP library first. Open its tile above and choose Remove service.`)
      return
    }
    const ok = await confirm({
      title: `Remove the preset ${name}?`,
      body: <p>The tile goes away.</p>,
      confirmLabel: 'Remove preset',
      danger: true
    })
    if (!ok) return
    const at = presets.findIndex((p) => p.connector.id === info.connector.id)
    const next = presets[at + 1]?.connector.id ?? null
    try {
      await api.remove({ id: info.connector.id })
      setNotice(`Removed ${name}`)
      setPendingFocus({ removed: info.connector.id, next })
      refresh()
    } catch (e) {
      setProblem(clampText(errMessage(e), 300))
    }
  }

  const seed = form && form.kind !== 'add' ? presetOf(form.info) : undefined
  return (
    <SettingsSection
      id="appsettings-section-presets"
      title="Your presets"
      description="Services you describe once. They show as tiles above and travel in your practice kit without secret values."
      testId="presets-section"
      sectionRef={rootRef}
      actions={
        <Button icon={Plus} testId="preset-add" disabled={!canAddPreset(presets.length)} onClick={() => setForm({ kind: 'add' })}>
          Add a preset
        </Button>
      }
    >
      <div className="presets-body">
        <p className="sr-only" role="status" aria-live="polite" data-testid="presets-status">
          {notice}
        </p>
        {problem && (
          <Banner tone="danger" title="Could not remove the preset" onDismiss={() => setProblem(null)} testId="presets-error">
            {problem}
          </Banner>
        )}
        {error && !connectors ? (
          <Banner tone="danger" title="Could not load your presets" actions={<Button size="sm" onClick={refresh}>Retry</Button>}>
            {error}
          </Banner>
        ) : connectors === null ? (
          <p className="muted" aria-busy="true">
            Loading your presets…
          </p>
        ) : presets.length === 0 ? (
          <div className="card-block preset-empty" data-testid="presets-empty">
            <Icon icon={Puzzle} size="lg" />
            <strong>No presets yet</strong>
            <p>Describe a service your team uses that is not in the list, such as a client system. It then shows as a tile with a sign-in or token step.</p>
          </div>
        ) : (
          <ul className="card-block preset-list" aria-label="Your presets">
            {presets.map((info) => {
              const def = presetOf(info)
              if (!def) return null
              const name = info.connector.name
              const st = presetState(info)
              return (
                <li key={def.id} className="preset-item" data-testid="preset-row" data-preset={def.id}>
                  <ConnectorLogo def={info.connector} />
                  <div className="preset-item-main">
                    <span className="preset-item-name">
                      <span className="preset-item-title" title={name}>
                        {name}
                      </span>
                      {def.origin === 'kit' && <CustomBadge info={info} />}
                    </span>
                    <span className="preset-item-desc" title={def.description}>
                      {def.description}
                    </span>
                    <span className="preset-item-meta">
                      <EaseBadge ease={infoEase(info)} />
                      <Badge tone="neutral">{presetKindWord(def)}</Badge>
                      <span className="muted preset-item-count">{accessOptionCount(def.variants.length)}</span>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </span>
                  </div>
                  <div className="preset-item-act">
                    <Button size="sm" icon={Pencil} testId="preset-edit" ariaLabel={`Edit ${name}`} onClick={() => setForm({ kind: 'edit', info })}>
                      Edit
                    </Button>
                    <Popover
                      trigger={<Icon icon={Ellipsis} size="sm" />}
                      triggerClassName="icon-btn size-sm"
                      triggerLabel={`More actions for ${name}`}
                      triggerTitle={`More actions for ${name}`}
                      triggerTestId="preset-more"
                      label={`Actions for ${name}`}
                      role="menu"
                      placement="bottom-end"
                    >
                      {({ close }) => (
                        <div className="preset-menu" role="presentation" onKeyDown={onMenuKey}>
                          <button
                            type="button"
                            role="menuitem"
                            className="preset-menuitem"
                            data-testid="preset-duplicate"
                            disabled={!canAddPreset(presets.length)}
                            onClick={() => {
                              close()
                              setForm({ kind: 'duplicate', info })
                            }}
                          >
                            <Icon icon={Copy} size="sm" />
                            Duplicate
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="preset-menuitem danger"
                            data-testid="preset-remove"
                            onClick={() => {
                              close()
                              void remove(info)
                            }}
                          >
                            <Icon icon={Trash2} size="sm" />
                            Remove…
                          </button>
                        </div>
                      )}
                    </Popover>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {!canAddPreset(presets.length) && <p className="hint">100 presets is the most.</p>}
      </div>
      {form && (
        <PresetForm
          key={form.kind === 'add' ? 'add' : `${form.kind}-${form.info.connector.id}`}
          preset={form.kind === 'edit' ? seed : undefined}
          duplicateOf={form.kind === 'duplicate' ? seed : undefined}
          added={form.kind === 'edit' ? !!form.info.library : false}
          takenIds={(connectors ?? []).map((c) => c.connector.id)}
          takenNames={presets.map((p) => p.connector.name)}
          onClose={() => setForm(null)}
          onSaved={(def) => {
            setProblem(null)
            setNotice(`Saved ${clampText(def.name, 60)}`)
            refresh()
          }}
        />
      )}
      {dialog}
    </SettingsSection>
  )
}
