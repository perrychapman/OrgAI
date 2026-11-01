import type { ReactElement, ReactNode } from 'react'
import { lazy, Suspense, useState } from 'react'
import { Sparkles } from 'lucide-react'
import type { McpMutationResult, McpServerInfo, Project, Role } from '@shared/types'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Banner } from '../ui/Banner'
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
import { projectProvenance } from '../../lib/skills'
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
  run: () => Promise<void> | void
}

type ConnTab = 'yours' | 'browse'
type SkillTab = 'project' | 'library' | 'repo' | 'new'
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
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const setView = useAppStore((s) => s.setView)
  const { connectors, error: connectorsError } = useConnectors()
  const { library } = useMcpLibrary()
  const skillsApi = useProjectSkills(project.id)
  const skillLib = useSkillLibrary()

  const choose = async (p: Pick): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await p.run()
      onDone(p.id)
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
  const projectPicks: Pick[] = available.map((s) => ({
    id: s.id,
    label: s.name,
    description: s.description,
    run: () => actions.grantSkill(s.id)
  }))
  const linkedLib = new Set(skillsApi.skills.map((i) => i.spec.libraryId).filter(Boolean))
  const libraryPicks: Pick[] = (skillLib.library ?? [])
    .filter((l) => !linkedLib.has(l.entry.id))
    .map((l) => ({
      id: `lib:${l.entry.id}`,
      label: l.entry.name,
      description: l.entry.description,
      run: async () => {
        await skillsApi.linkLibrary(l.entry.id, [role.id])
      }
    }))

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
        {picks.map((p) => (
          <li key={p.id}>
            <button type="button" className="capability-chooser-item" data-testid="capability-chooser-item" data-name={p.label} disabled={busy} onClick={() => void choose(p)}>
              {p.lead}
              <span className="capability-chooser-text">
                <span className="capability-chooser-name">{p.label}</span>
                {p.description && <span className="capability-chooser-desc">{p.description}</span>}
              </span>
            </button>
          </li>
        ))}
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
            Pick a service from the gallery. If it is not connected yet you sign in first, then choose who may use it: tick {role.name}.
          </p>
          <div>
            <Button variant="primary" testId="chooser-open-gallery" onClick={() => setSub('gallery')}>
              Browse connections
            </Button>
          </div>
        </div>
      )
  } else if (skillTab === 'project') {
    body = list(projectPicks, 'Every skill in this project is already on this role. Try Your library or New skill.', skillsApi.loading)
  } else if (skillTab === 'library') {
    body = list(libraryPicks, 'Nothing new in your skill library.', skillLib.library === null && !skillLib.error)
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

  return (
    <>
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
          <Tabs
            tabs={tabs}
            value={current}
            onChange={(id) => (isConn ? setConnTab(id as ConnTab) : setSkillTab(id as SkillTab))}
            label={isConn ? 'Where to find connections' : 'Where to find skills'}
            idPrefix={idPrefix}
            compact
          />
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
      {sub === 'gallery' && (
        <AddServiceDialog
          project={project}
          connectors={connectors}
          error={connectorsError}
          servers={servers}
          onClose={() => setSub(null)}
          onResult={(r) => {
            actions.applyResult(r)
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
