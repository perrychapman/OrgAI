import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, Network, Sparkles } from 'lucide-react'
import type { AnthropicConnection, ConnectionInfo, ModelTier, OpenAIConnection, ProxyConnection } from '@shared/types'
import { PROXIES_MAX, isProxyConnection, isVirtualProjectId } from '@shared/types'
import { projectConnection, roleConnection } from '@shared/defaults'
import { useAppStore } from '../../store/useAppStore'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import RemapNotices from '../RemapNotices'
import { APP_SETTINGS_SECTIONS } from '../../lib/settingsTarget'
import { effectiveTiers } from '../../lib/tierMapping'
import { SettingsSection } from '../settings/SettingsSection'
import { SettingsGallery, type GalleryItem, type GalleryTone } from '../settings/SettingsGallery'
import { BrandMark } from '../brand/BrandMark'
import { brandMark } from '../brand/brandMarks'
import ConnectionCard from './ConnectionCard'
import ProxyCard from './ProxyCard'
import AddProxyDialog from './AddProxyDialog'
import type { ProxyAdded } from './AddProxyDialog'
import { ConnectionsAnnounceContext } from './announce'

const nameOf = (c: ConnectionInfo): string => (isProxyConnection(c.connection) ? c.connection.name : '')
const BUILTIN_NAME: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI' }
const ADD_TILE = 'add-proxy'

/**
 * Plain tier names (ui-overhaul owner decision 8, "Fast / Standard / Most capable"). The app has four tiers, so Deep
 * gets its own plain name; the app's tier word follows each so it matches the model selects elsewhere.
 */
export const TIER_PLAIN: Record<ModelTier, { name: string; bars: number; for: string }> = {
  top: { name: 'Most capable', bars: 4, for: 'Planning, hard problems and final checks.' },
  deep: { name: 'Deep thinking', bars: 3, for: 'Orchestration, architecture and long reasoning.' },
  everyday: { name: 'Standard', bars: 2, for: 'Most of the work: writing code, analysis, reviews.' },
  fast: { name: 'Fast', bars: 1, for: 'Quick, simple steps: lookups, searching, summaries.' }
}

function statusOf(c: ConnectionInfo): { text: string; tone: GalleryTone } {
  if (isProxyConnection(c.connection) && c.connection.enabled === false) return { text: 'Turned off', tone: 'off' }
  switch (c.status.state) {
    case 'connected':
      return { text: 'Connected', tone: 'ok' }
    case 'connecting':
      return { text: 'Signing in', tone: 'working' }
    case 'error':
      return { text: 'Needs attention', tone: 'warn' }
    default:
      return { text: 'Not connected', tone: 'off' }
  }
}

function howOf(c: ConnectionInfo): string {
  const conn = c.connection
  if (isProxyConnection(conn)) {
    const p = conn as ProxyConnection
    return (p.litellmFeatures ?? p.kind === 'litellm') ? 'A proxy you run · LiteLLM reporting' : 'A proxy you run'
  }
  const key = (conn as AnthropicConnection | OpenAIConnection).auth?.kind === 'apiKey'
  if (conn.id === 'anthropic') return key ? 'With an API key' : 'Signed in with Claude Code'
  return key ? 'With an API key' : 'Signed in with your ChatGPT plan'
}

/** App settings > AI providers (Providers board): a card grid of connections, the selected one's controls in the aside, then its tiers. */
export default function ConnectionsPanel(): ReactElement {
  const connections = useAppStore((s) => s.connections)
  const error = useAppStore((s) => s.connectionsError)
  const load = useAppStore((s) => s.loadConnections)
  const loadModels = useAppStore((s) => s.loadModels)
  const projects = useAppStore((s) => s.projects)
  const allModels = useAppStore((s) => s.models)
  const [busy, setBusy] = useState(false)
  /** The pane's one polite live region; cards announce through ConnectionsAnnounceContext. */
  const [live, setLive] = useState('')
  const announce = useCallback((message: string) => {
    // Clear first so a repeated message is read again.
    setLive('')
    setTimeout(() => setLive(message), 50)
  }, [])
  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [focusProxy, setFocusProxy] = useState<string | null>(null)
  const clearFocus = useCallback(() => setFocusProxy(null), [])

  useEffect(() => {
    void load()
  }, [load])

  const refreshAll = async (): Promise<void> => {
    setBusy(true)
    await load()
    await Promise.all(
      (useAppStore.getState().connections ?? []).filter((c) => c.status.state === 'connected').map((c) => loadModels(c.connection.id, true))
    )
    setBusy(false)
  }

  const onAdded = (a: ProxyAdded): void => {
    setAdding(false)
    setSelected(a.id)
    setFocusProxy(a.id)
    // After the card's own "connected" status announcement, so this fuller sentence is the one that stays.
    setTimeout(() => announce(`${a.name} added. ${a.connected ? 'Connected.' : (a.detail ?? 'Not connected yet.')}`), 250)
  }
  const onRemoved = (name: string): void => {
    setSelected(null)
    announce(`${name} removed`)
    setTimeout(() => document.getElementById('proxies-heading')?.focus(), 60)
  }
  const select = (id: string): void => {
    // Selecting a proxy re-reads the list so "used by" is current (projects change connection elsewhere).
    if (id !== selected && id !== ADD_TILE && connections?.find((c) => c.connection.id === id && isProxyConnection(c.connection))) void load()
    setSelected(id)
  }

  const proxies = (connections ?? []).filter((c) => isProxyConnection(c.connection))
  const atMax = proxies.length >= PROXIES_MAX
  const none = connections && connections.every((c) => c.status.state !== 'connected')

  // Projects (and roles per tier) on each connection, from the projects already in the store.
  const usage = useMemo(() => {
    const byConn = new Map<string, { projects: number; tiers: Partial<Record<ModelTier, number>> }>()
    const at = (id: string): { projects: number; tiers: Partial<Record<ModelTier, number>> } => {
      let u = byConn.get(id)
      if (!u) byConn.set(id, (u = { projects: 0, tiers: {} }))
      return u
    }
    for (const p of projects) {
      if (isVirtualProjectId(p.id) || p.provider.id === 'mock') continue
      at(projectConnection(p)).projects++
      for (const r of p.roles) {
        const tier = r.model as ModelTier
        if (!(tier in TIER_PLAIN)) continue
        const u = at(roleConnection(r, p))
        u.tiers[tier] = (u.tiers[tier] ?? 0) + 1
      }
    }
    return byConn
  }, [projects])

  const items: GalleryItem[] = (connections ?? []).map((c) => {
    const id = c.connection.id
    const proxy = isProxyConnection(c.connection)
    const name = isProxyConnection(c.connection) ? c.connection.name : (BUILTIN_NAME[id] ?? id)
    const used = proxy ? (c.usedBy?.length ?? 0) : (usage.get(id)?.projects ?? 0)
    const count = allModels[id]?.length ?? (c.status.state === 'connected' ? c.modelCount : 0)
    return {
      id,
      name,
      section: proxy ? 'proxy' : 'builtin',
      tag: howOf(c),
      summary: [c.isDefault ? 'Default for new projects' : '', used === 0 ? 'Not used by a project' : `Used by ${used} ${used === 1 ? 'project' : 'projects'}`, c.status.state === 'connected' && count ? `${count} models` : '']
        .filter(Boolean)
        .join(' · '),
      status: statusOf(c),
      mark: brandMark(id) ? <BrandMark id={id} /> : <Icon icon={proxy ? Network : id === 'openai' ? Bot : Sparkles} size="md" />,
      searchText: `${howOf(c)} ${proxy ? 'proxy gateway' : ''}`,
      testId: 'provider-tile',
      data: { provider: id, kind: proxy ? 'proxy' : 'builtin', name, default: c.isDefault ? 'true' : 'false' }
    }
  })
  items.push({
    id: ADD_TILE,
    name: 'Add a proxy',
    section: 'proxy',
    tag: 'A gateway your company runs',
    summary: 'Route Claude, GPT and other models through a LiteLLM or OpenAI-compatible gateway.',
    dashed: true,
    mark: '+',
    testId: 'provider-tile-add'
  })

  const selectedInfo = (connections ?? []).find((c) => c.connection.id === selected)

  return (
    <SettingsSection
      id={APP_SETTINGS_SECTIONS.connections}
      titleId="connections-title"
      title="Your providers"
      description="One provider is the default for new projects, Chat and the helpers. Each project picks a default for its roles, and each role can run on another."
      actions={
        <Button loading={busy} title="Reload status and model lists" onClick={() => void refreshAll()}>
          Refresh all
        </Button>
      }
    >
      <p className="sr-only" role="status" aria-live="polite" data-testid="connections-live">
        {live}
      </p>
      <RemapNotices />
      {error && !connections ? (
        <Banner tone="danger" title="Could not load connections" actions={<Button size="sm" onClick={() => void load()}>Retry</Button>}>
          {error}
        </Banner>
      ) : !connections ? (
        <div className="conn-stack" aria-busy="true" aria-label="Loading connections">
          {['anthropic', 'openai'].map((id) => (
            <div key={id} className="card-block">
              <div className="card-sec">
                <div className="skeleton w-40" />
                <div className="skeleton w-70" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <ConnectionsAnnounceContext.Provider value={announce}>
          {none && <Banner tone="neutral">No connection is set up. Connect one so projects can run.</Banner>}
          <SettingsGallery
            label="AI providers"
            testId="providers-gallery"
            items={items}
            selected={selected}
            onSelect={select}
            sections={[
              { id: 'builtin', label: 'Built in' },
              {
                id: 'proxy',
                label: `Proxies (${proxies.length})`,
                headingId: 'proxies-heading',
                headingTestId: 'proxies-heading',
                actions: (
                  <Button variant="primary" size="sm" testId="proxy-add" inert={atMax} ariaDescribedBy={atMax ? 'proxy-add-reason' : undefined} onClick={() => setAdding(true)}>
                    Add proxy
                  </Button>
                ),
                footnote: atMax ? (
                  <p className="field-msg warn" id="proxy-add-reason" data-testid="proxy-add-reason">
                    You have {PROXIES_MAX} proxies, the most OrgAI keeps. Remove one to add another.
                  </p>
                ) : proxies.length === 0 ? (
                  <p className="muted settings-gallery-footnote" data-testid="proxies-empty">
                    No proxies yet. Add one to route Claude, GPT and other models through a gateway you run.
                  </p>
                ) : undefined
              }
            ]}
            renderDetail={(item) => {
              if (item.id === ADD_TILE) {
                return (
                  <div className="providers-add-detail" data-testid="provider-add-detail">
                    <h3 className="settings-detail-name">Add a proxy</h3>
                    <p className="muted">
                      A proxy is a gateway your company runs (LiteLLM or any OpenAI-compatible endpoint). OrgAI checks it can reach it, that the key works and which models it lists.
                      The key is stored with your system's secure storage and never shown again.
                    </p>
                    <div className="settings-detail-actions">
                      <Button variant="primary" inert={atMax} ariaDescribedBy={atMax ? 'proxy-add-reason' : undefined} onClick={() => setAdding(true)}>
                        Add proxy
                      </Button>
                    </div>
                  </div>
                )
              }
              const info = (connections ?? []).find((c) => c.connection.id === item.id)
              if (!info) return null
              return isProxyConnection(info.connection) ? (
                <ProxyCard
                  key={info.connection.id}
                  info={info}
                  embedded
                  open
                  onToggle={() => undefined}
                  focusToken={focusProxy}
                  onFocused={clearFocus}
                  onRemoved={onRemoved}
                  existingNames={['Anthropic', 'OpenAI', ...proxies.filter((p) => p.connection.id !== info.connection.id).map(nameOf)]}
                />
              ) : (
                <ConnectionCard key={info.connection.id} info={info} embedded />
              )
            }}
          />
          {selectedInfo && <TierTable info={selectedInfo} roleCounts={usage.get(selectedInfo.connection.id)?.tiers ?? {}} />}
          <AddProxyDialog open={adding} onClose={() => setAdding(false)} existingNames={proxies.map(nameOf)} onAdded={onAdded} />
        </ConnectionsAnnounceContext.Provider>
      )}
    </SettingsSection>
  )
}

/**
 * The selected connection's four tiers in plain words (Providers board): what each is for, how strong, the exact model
 * it resolves to on this connection (explicit mapping or the catalog's automatic pick, as a role resolves it) and how
 * many roles in your projects use it there. Editing stays in the card's "Model tiers" editor.
 */
function TierTable({ info, roleCounts }: { info: ConnectionInfo; roleCounts: Partial<Record<ModelTier, number>> }): ReactElement {
  const catalog = useAppStore((s) => s.models[info.connection.id])
  const tiers = effectiveTiers(info.connection.id, info.connection.tierModels, catalog ?? [])
  const name = isProxyConnection(info.connection) ? info.connection.name : (BUILTIN_NAME[info.connection.id] ?? info.connection.id)
  return (
    <div className="providers-tiers" data-testid="provider-tiers" data-provider={info.connection.id}>
      <h3 className="settings-gallery-section-title">Model tiers on {name}</h3>
      <ul className="providers-tier-grid" role="list">
        {tiers.map((t) => {
          const plain = TIER_PLAIN[t.tier]
          const roles = roleCounts[t.tier] ?? 0
          return (
            <li key={t.tier} className="providers-tier glass" data-testid="provider-tier" data-tier={t.tier}>
              <div className="providers-tier-head">
                <span className="providers-tier-bars" aria-hidden="true">
                  {[1, 2, 3, 4].map((i) => (
                    <span key={i} className={i <= plain.bars ? 'is-lit' : undefined} />
                  ))}
                </span>
                <span className="providers-tier-name">{plain.name}</span>
                <span className="providers-tier-word">{t.label} tier</span>
              </div>
              <p className="providers-tier-for">{plain.for}</p>
              <dl className="providers-tier-facts">
                <div>
                  <dt>Model</dt>
                  <dd className="mono" data-testid="provider-tier-model">
                    {t.model ?? 'No model'}
                    {t.automatic ? <span className="providers-tier-auto"> (automatic)</span> : null}
                  </dd>
                </div>
                <div>
                  <dt>Roles</dt>
                  <dd>{roles === 0 ? 'None' : `${roles} ${roles === 1 ? 'role' : 'roles'}`}</dd>
                </div>
              </dl>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
