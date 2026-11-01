import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import type { CapabilityDiscovery, CapabilityItem, McpMutationResult, McpServerInfo, Project, Role } from '@shared/types'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Banner } from '../ui/Banner'
import { Badge } from '../ui/Badge'
import { Tabs, panelDomId, tabDomId } from '../ui/Tabs'
import { ConnectorLogo } from '../connectors/ConnectorLogo'
import AddServiceDialog from '../connectors/AddServiceDialog'
import { useConnectors } from '../connectors/useConnectors'
import { connectorAccess } from '../connectors/ConnectedServices'
import { useMcpLibrary } from '../mcp/useMcpLibrary'
import { linkedServerFor, setUpConnectors } from '../mcp/mcpLibraryHelpers'
import SkillForm from '../skills/SkillForm'
import { useProjectSkills } from '../skills/useSkills'
import { useSkillLibrary } from '../skills/useSkillLibrary'
import { cleanIpcError } from '../../lib/ipcError'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'
import { useAppStore } from '../../store/useAppStore'
import { serviceFor } from '../../lib/roleServices'
import { accessLabel, grantableServers, roleSkillSplit, serverReadOnly } from '../../lib/roleCapabilities'
import { chooserDesc, chooserName, localSkillCandidates, nextTabId, skillEmptyCopy } from '../../lib/chooser'
import { clampText, flagViews, pinLabel, sourceBadge } from '../../lib/capabilities'
import type { CapabilityKind } from './CapabilityBlock'

const ImportSkillsDialog = lazy(() => import('../skills/ImportSkillsDialog'))

/** What choosing an item does. Every action grants to the one role the chooser was opened for (least privilege). */
export interface ChooserActions {
  /** Let the role use a project server it cannot use yet. */
  grantServer: (info: McpServerInfo) => Promise<void>
  /** Link an app library entry or connected connector into the project for this role only. */
  linkLibraryServer: (libraryId: string) => Promise<void>
  /** The wrapped gallery dialog saved a project change. */
  applyResult: (r: McpMutationResult) => void
  grantSkill: (skillId: string) => void
}

interface Pick {
  id: string
  label: string
  description?: string
  lead?: ReactNode
  /** A skill found on this computer: its flags, source and digest are shown, and any flag asks for a confirm first. */
  item?: CapabilityItem
  /** May return the id of the row the caller should focus afterwards. */
  run: () => Promise<void | string> | void
}

type ConnTab = 'yours' | 'browse'
type SkillTab = 'project' | 'library' | 'local' | 'repo' | 'new'
type Sub = 'gallery' | 'import' | 'new' | null

/**
 * "+ Add" chooser for one group of a role's "What it can use", opened as a dialog (nothing floats over the canvas).
 * Choosing an item grants it to this role only. `onDone(id)` closes it and lets the caller move focus to the new row;
 * Escape or Close calls `onClose`, which returns focus to the "+ Add" button.
 */
export function CapabilityChooser({
  kind,
  project,
  role,
  servers,
  actions,
  onDone,
  onClose,
  onAskAssistant
}: {
  kind: Exclude<CapabilityKind, 'tools'>
  project: Project
  role: Role
  servers: McpServerInfo[]
  actions: ChooserActions
  onDone: (id: string | null) => void
  onClose: () => void
  onAskAssistant?: () => void
}): ReactElement {
  const isConn = kind === 'connections'
  const [connTab, setConnTab] = useState<ConnTab>('yours')
  const [skillTab, setSkillTab] = useState<SkillTab>('project')
  const [sub, setSub] = useState<Sub>(null)
  /** True while the service picker was opened for the user (the Your connections list was empty): closing it closes both. */
  const [autoGallery, setAutoGallery] = useState(false)
  const touchedTab = useRef(false)
  /** The picker reported a result (onDone ran): its own close right after must not close the chooser a second time. */
  const resultDone = useRef(false)
  const tabsWrap = useRef<HTMLDivElement>(null)
  const [disc, setDisc] = useState<CapabilityDiscovery | null>(null)
  const [discError, setDiscError] = useState(false)
  const replaceProject = useAppStore((s) => s.replaceProject)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** The local skill row waiting for its one-step confirm. */
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const setView = useAppStore((s) => s.setView)
  const { connectors, error: connectorsError } = useConnectors()
  const { library } = useMcpLibrary()
  const skillsApi = useProjectSkills(project.id)
  const skillLib = useSkillLibrary()

  // Skills on this computer: token-free, local sources only.
  useEffect(() => {
    if (isConn) return undefined
    let live = true
    window.orgai.capabilities
      .discover({ projectId: project.id })
      .then((d) => live && setDisc(d))
      .catch(() => live && setDiscError(true))
    return () => {
      live = false
    }
  }, [isConn, project.id])

  // Initial focus: the selected tab, not the dialog's Close control.
  useEffect(() => {
    if (sub === 'gallery') return
    tabsWrap.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus()
  }, [sub])

  const choose = async (p: Pick): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const made = await p.run()
      onDone(typeof made === 'string' ? made : p.id)
    } catch (e) {
      setError(cleanIpcError(e))
      setBusy(false)
    }
  }

  // ---- connections ----
  const connPicks: Pick[] = []
  for (const info of grantableServers(servers, role)) {
    const s = serviceFor(info.spec)
    connPicks.push({
      id: info.spec.id,
      label: s.label,
      description: accessLabel(serverReadOnly(info.spec)) ?? 'In this project',
      lead: <span className="role-service-tile" style={{ ['--hue' as string]: s.hue }} aria-hidden="true">{s.initial}</span>,
      run: () => actions.grantServer(info)
    })
  }
  const projectLibIds = new Set(servers.map((s) => s.spec.libraryId).filter(Boolean))
  for (const c of setUpConnectors(connectors).filter((c) => c.state === 'connected' && !linkedServerFor(c, servers))) {
    const libId = c.library?.entry.id
    if (!libId) continue
    projectLibIds.add(libId)
    connPicks.push({
      id: `lib:${libId}`,
      label: c.connector.name,
      description: `${connectorAccess(c)}. Connected in the app.`,
      lead: <ConnectorLogo def={c.connector} />,
      run: () => actions.linkLibraryServer(libId)
    })
  }
  for (const l of library ?? []) {
    if (l.entry.connectorId || projectLibIds.has(l.entry.id)) continue
    const s = serviceFor({ id: l.entry.id, name: l.entry.name, connectorId: undefined })
    connPicks.push({
      id: `lib:${l.entry.id}`,
      label: s.label,
      description: 'Custom connection from your app library.',
      lead: <span className="role-service-tile" style={{ ['--hue' as string]: s.hue }} aria-hidden="true">{s.initial}</span>,
      run: () => actions.linkLibraryServer(l.entry.id)
    })
  }

  // ---- skills ----
  const { available } = roleSkillSplit(skillsApi.skills.map((i) => i.spec), role)
  const projectSkillCount = skillsApi.skills.length
  const projectPicks: Pick[] = available.map((s) => ({
    id: s.id,
    label: chooserName(s.name),
    description: chooserDesc(s.description),
    run: () => actions.grantSkill(s.id)
  }))
  const linkedLib = new Set(skillsApi.skills.map((i) => i.spec.libraryId).filter(Boolean))
  const libraryPicks: Pick[] = (skillLib.library ?? [])
    .filter((l) => !linkedLib.has(l.entry.id))
    .map((l) => ({
      id: `lib:${l.entry.id}`,
      label: chooserName(l.entry.name),
      description: chooserDesc(l.entry.description),
      run: async () => {
        await skillsApi.linkLibrary(l.entry.id, [role.id])
      }
    }))

  const localPicks: Pick[] = localSkillCandidates(disc?.items ?? []).map((it) => ({
    id: it.id,
    label: chooserName(it.name),
    description: chooserDesc(it.description || it.location),
    item: it,
    run: async () => {
      if (!disc) return undefined
      const out = await window.orgai.capabilities.apply({ projectId: project.id, digest: disc.digest, candidateId: it.id, roleIds: [role.id] })
      replaceProject(out.project)
      return out.applied.id
    }
  }))

  // With nothing to pick from "Your connections", go straight to the service picker (one dialog fewer).
  const connReady = isConn && connectors !== null && library !== null
  useEffect(() => {
    if (connReady && connPicks.length === 0 && !touchedTab.current && sub === null) {
      setAutoGallery(true)
      setSub('gallery')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connReady])

  const openAppSettingsConnectors = (): void => {
    requestAppSettingsSection(APP_SETTINGS_SECTIONS.mcpLibrary)
    setView('appSettings')
    onClose()
  }

  const list = (picks: Pick[], empty: string, loading?: boolean): ReactElement =>
    loading ? (
      <p className="hint" role="status">
        Loading...
      </p>
    ) : picks.length === 0 ? (
      <p className="hint capability-chooser-empty">{empty}</p>
    ) : (
      <ul className="capability-chooser-list" aria-label={isConn ? 'Connections you can add' : 'Skills you can add'}>
        {picks.map((p) => {
          const flags = p.item ? flagViews(p.item) : []
          const asks = flags.length > 0
          const open = confirmId === p.id
          const pin = p.item ? pinLabel(p.item) : null
          return (
            <li key={p.id} className="capability-chooser-row">
              <button
                type="button"
                className="capability-chooser-item"
                data-testid="capability-chooser-item"
                data-name={p.label}
                aria-expanded={asks ? open : undefined}
                disabled={busy}
                onClick={() => (asks ? setConfirmId(open ? null : p.id) : void choose(p))}
              >
                {p.lead}
                <span className="capability-chooser-text">
                  <span className="capability-chooser-name">{p.label}</span>
                  {p.description && <span className="capability-chooser-desc">{p.description}</span>}
                  {p.item && (
                    <span className="capability-chooser-flags">
                      <Badge tone="neutral">{sourceBadge(p.item)}</Badge>
                      {flags.map((f) => (
                        <Badge key={f.key} tone={f.tone === 'danger' ? 'danger' : f.tone === 'attention' ? 'attention' : 'neutral'}>
                          {f.label}
                        </Badge>
                      ))}
                    </span>
                  )}
                </span>
              </button>
              {p.item && open && (
                <div className="capability-chooser-confirm" data-testid="capability-chooser-confirm" role="group" aria-label={`Review ${p.label}`}>
                  <div className="capability-chooser-meta">
                    {p.item.location && (
                      <span className="mono capability-location-full" title={clampText(p.item.location, 200)}>
                        {clampText(p.item.location, 200)}
                      </span>
                    )}
                    {pin && <span className="mono">{pin}</span>}
                  </div>
                  <p className="hint">Check what it can do, then add it. Only {role.name} gets it.</p>
                  <div className="row gap-2">
                    <Button variant="primary" disabled={busy} testId="chooser-confirm-add" onClick={() => void choose(p)}>
                      Add to {role.name}
                    </Button>
                    <Button variant="ghost" disabled={busy} onClick={() => setConfirmId(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    )

  const tabs = isConn
    ? [
        { id: 'yours', label: 'Your connections', testId: 'chooser-tab-yours' },
        { id: 'browse', label: 'Browse', testId: 'chooser-tab-browse' }
      ]
    : [
        { id: 'project', label: 'This project', testId: 'chooser-tab-project' },
        { id: 'library', label: 'Your library', testId: 'chooser-tab-library' },
        { id: 'local', label: 'On this computer', testId: 'chooser-tab-local' },
        { id: 'repo', label: 'Found in this repo', testId: 'chooser-tab-repo' },
        { id: 'new', label: 'New skill', testId: 'chooser-tab-new' }
      ]
  const current = isConn ? connTab : skillTab
  const idPrefix = `chooser-${kind}`

  let body: ReactElement
  if (isConn) {
    body =
      connTab === 'yours' ? (
        list(connPicks, 'Nothing else to add from this project or your app. Use Browse to connect a new service.', connectors === null && !connectorsError)
      ) : (
        <div className="stack-2">
          <p className="hint">
            Pick a service from the gallery. If it is not connected yet you sign in first, then {role.name} gets it.
          </p>
          <div>
            <Button variant="primary" testId="chooser-open-gallery" onClick={() => setSub('gallery')}>
              Browse connections
            </Button>
          </div>
        </div>
      )
  } else if (skillTab === 'project') {
    body = list(projectPicks, skillEmptyCopy('project', projectSkillCount), skillsApi.loading)
  } else if (skillTab === 'library') {
    body = list(libraryPicks, skillEmptyCopy('library', skillLib.library?.length ?? 0), skillLib.library === null && !skillLib.error)
  } else if (skillTab === 'local') {
    const found = (disc?.items ?? []).filter((i) => i.kind === 'skill' && i.origin === 'local').length
    body = list(localPicks, discError ? 'Could not look on this computer.' : skillEmptyCopy('local', found), disc === null && !discError)
  } else if (skillTab === 'repo') {
    body = (
      <div className="stack-2">
        <p className="hint">Look through this repo for skills it already has, review them, and import the ones you want. You choose who can load each one.</p>
        <div>
          <Button variant="primary" testId="chooser-open-import" onClick={() => setSub('import')}>
            Review skills found in this repo
          </Button>
        </div>
      </div>
    )
  } else {
    body = (
      <div className="stack-2">
        <p className="hint">Write a new skill. {role.name} gets it once you save.</p>
        <div>
          <Button variant="primary" testId="chooser-open-new" onClick={() => setSub('new')}>
            Write a new skill
          </Button>
        </div>
      </div>
    )
  }

  const tabIds = tabs.map((t) => t.id)
  const selectTab = (id: string): void => {
    touchedTab.current = true
    if (isConn) setConnTab(id as ConnTab)
    else setSkillTab(id as SkillTab)
  }
  // Tabs handles Left/Right/Home/End; Up/Down do the same here.
  const onTabsKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    if (!(e.target as HTMLElement).closest('[role=tab]')) return
    const next = nextTabId(tabIds, current, e.key)
    if (!next) return
    e.preventDefault()
    selectTab(next)
    document.getElementById(tabDomId(idPrefix, next))?.focus()
  }

  return (
    <>
      {sub !== 'gallery' && (
      <Dialog
        open
        onClose={busy ? () => undefined : onClose}
        title={isConn ? `Add a connection to ${role.name}` : `Add a skill to ${role.name}`}
        description="Only this role gets what you add. Other roles are not changed."
        size="md"
        testId="capability-chooser"
        footer={
          <>
            {onAskAssistant && (
              <Button variant="ghost" icon={Sparkles} testId="chooser-ask-assistant" onClick={onAskAssistant}>
                Ask the Team assistant
              </Button>
            )}
            <span className="grow" />
            <Button onClick={onClose} disabled={busy}>
              Close
            </Button>
          </>
        }
      >
        <div className="stack-3">
          <div ref={tabsWrap} onKeyDown={onTabsKey}>
            <Tabs
              tabs={tabs}
              value={current}
              onChange={selectTab}
              label={isConn ? 'Where to find connections' : 'Where to find skills'}
              idPrefix={idPrefix}
              compact
            />
          </div>
          <div role="tabpanel" id={panelDomId(idPrefix, current)} aria-labelledby={tabDomId(idPrefix, current)} className="stack-2">
            {error && (
              <Banner tone="danger" title="Could not add it">
                {error}
              </Banner>
            )}
            {body}
          </div>
        </div>
      </Dialog>
      )}
      {sub === 'gallery' && (
        <AddServiceDialog
          project={project}
          connectors={connectors}
          error={connectorsError}
          servers={servers}
          role={role}
          onClose={() => {
            setSub(null)
            if (autoGallery && !resultDone.current) onClose()
          }}
          onResult={(r) => {
            actions.applyResult(r)
            resultDone.current = true
            onDone(null)
          }}
          onOther={(way) => {
            if (way === 'assist') onAskAssistant?.()
            else openAppSettingsConnectors()
          }}
        />
      )}
      {sub === 'import' && (
        <Suspense fallback={null}>
          <ImportSkillsDialog
            project={project}
            onApplied={(result) => {
              skillsApi.apply(result)
              onDone(null)
            }}
            onClose={() => setSub(null)}
          />
        </Suspense>
      )}
      {sub === 'new' && (
        <SkillForm
          project={project}
          skillsApi={skillsApi}
          onSaved={(saved) => {
            if (saved.created && saved.skillId) actions.grantSkill(saved.skillId)
            onDone(saved.skillId)
          }}
          onClose={() => setSub(null)}
        />
      )}
    </>
  )
}
