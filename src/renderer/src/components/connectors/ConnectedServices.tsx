import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Ellipsis, ExternalLink, Unlink } from 'lucide-react'
import type { ConnectorInfo, McpMutationResult, McpServerInfo, Project, Role } from '@shared/types'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { ConfirmDialog, Dialog } from '../ui/Dialog'
import { IconButton } from '../ui/IconButton'
import { Switch } from '../ui/Switch'
import { RoleAccess, RoleChecklist } from '../mcp/RoleAccess'
import { UsedBy } from '../team/CatalogUsedBy'
import { errMessage } from '../mcp/mcpHelpers'
import { linkedServerFor, setUpConnectors, useInProjectBlocker } from '../mcp/mcpLibraryHelpers'
import { grantServerRoles } from '../../lib/roleCapabilities'
import { accessWords, stateChip } from '../../lib/connectors'
import { useAppStore } from '../../store/useAppStore'
import ConnectorDialog from './ConnectorDialog'
import { ConnectorLogo } from './ConnectorLogo'

/** The access words for a connector's variant ("Can read" / "Can read and change"). */
export function connectorAccess(info: ConnectorInfo): string {
  const v = info.connector.variants.find((x) => x.id === (info.variant ?? info.connector.defaultVariant)) ?? info.connector.variants[0]
  return v ? accessWords(v) : ''
}

/**
 * "Use in this project": choose who may use a connected service, then link its library entry. Least privilege: no role
 * is selected until the user picks some (or All roles). With `role` (started from one role's "+ Add") that role is the only
 * one granted and the dialog confirms by itself: nothing left to decide, so it just reports the result or the error.
 */
export function UseInProjectDialog({
  project,
  info,
  onClose,
  onResult,
  role,
  linked
}: {
  project: Project
  info: ConnectorInfo
  onClose: () => void
  onResult: (r: McpMutationResult) => void
  role?: Role
  /** The project's server for this connector when it is already linked (a re-sign-in): the role is granted on it. */
  linked?: McpServerInfo
}): ReactElement {
  const [roles, setRoles] = useState<string[]>(() => (role ? [role.slug] : []))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const noRoles = project.roles.length === 0
  const blocker = useInProjectBlocker(project.roles.length, roles)
  const entry = info.library?.entry
  const canRun = !!entry || !!(linked && role)
  const autoStarted = useRef(false)

  const confirm = async (): Promise<void> => {
    if (!canRun) return
    setBusy(true)
    setError(null)
    try {
      if (linked && role) {
        // Already linked (it only needed a new sign-in): linkLibrary would refuse, so grant the role on the project server.
        const roles = grantServerRoles(linked.spec, role)
        const result = await window.orgai.mcp.upsert({ projectId: project.id, spec: { ...linked.spec, ...(roles ? { roles } : {}) } })
        onResult(result)
        onClose()
        return
      }
      if (!entry) {
        setBusy(false)
        return
      }
      const result = await window.orgai.mcp.linkLibrary({
        projectId: project.id,
        libraryId: entry.id,
        ...(noRoles ? {} : { roles }),
        enabled: true
      })
      onResult(result)
      onClose()
    } catch (e) {
      setError(errMessage(e))
      setBusy(false)
    }
  }
  useEffect(() => {
    if (!role || !canRun || autoStarted.current) return
    autoStarted.current = true
    void confirm()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.id])

  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onClose}
      title={role ? `Add ${info.connector.name} for ${role.name}` : `Use ${info.connector.name} in this project`}
      description={role ? `${connectorAccess(info)}. Only ${role.name} gets it. You can change this later.` : `${connectorAccess(info)}. Pick which roles may use it. You can change this later.`}
      size="md"
      testId="connector-use-dialog"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!canRun || blocker !== null} testId="connector-use-confirm" onClick={() => void confirm()}>
            {role ? `Add for ${role.name}` : 'Use in this project'}
          </Button>
        </>
      }
    >
      {error && (
        <Banner tone="danger" title="Could not add the service">
          {error}
        </Banner>
      )}
      {role ? (
        <p className="hint" role="status">
          {busy ? `Adding ${info.connector.name} for ${role.name}...` : `${role.name} will be able to use ${info.connector.name}.`}
        </p>
      ) : (
      <fieldset className="mcp-vars">
        <legend>Who can use it?</legend>
        <RoleChecklist roles={project.roles} value={roles} onChange={setRoles} label={`Role access for ${info.connector.name}`} />
        {blocker && (
          <span className="hint" role="status" data-testid="connector-use-blocker">
            {blocker}
          </span>
        )}
      </fieldset>
      )}
    </Dialog>
  )
}

/** Connected services listed before the unused ones fold away. */
const CONNECTED_ROWS_CAP = 8

type Step = { kind: 'use'; info: ConnectorInfo } | { kind: 'setup'; info: ConnectorInfo } | null

/** Team > Catalog > Connections: the services connected in the app, and how this project uses them. */
export default function ConnectedServices({
  project,
  connectors,
  servers,
  onResult,
  onChanged,
  onSelectRole
}: {
  project: Project
  connectors: ConnectorInfo[] | null
  servers: McpServerInfo[]
  onResult: (r: McpMutationResult) => void
  onChanged: () => void
  onSelectRole?: (roleId: string) => void
}): ReactElement | null {
  const [step, setStep] = useState<Step>(null)
  const [showAll, setShowAll] = useState(false)
  const items = setUpConnectors(connectors)
  if (items.length === 0) return null
  // Past CONNECTED_ROWS_CAP services, rows this project does not use collapse behind "and N more".
  const inUse = items.filter((i) => !!linkedServerFor(i, servers) || i.state !== 'connected')
  const spare = items.filter((i) => !inUse.includes(i))
  const room = showAll || items.length <= CONNECTED_ROWS_CAP ? spare.length : Math.max(0, CONNECTED_ROWS_CAP - inUse.length)
  const visible = items.filter((i) => inUse.includes(i) || spare.indexOf(i) < room)
  const hidden = items.length - visible.length
  return (
    <>
      <ul className="card-block mcp-list" aria-label="Connected services">
        {visible.map((info) => (
          <ConnectedServiceRow
            key={info.connector.id}
            info={info}
            server={linkedServerFor(info, servers)}
            project={project}
            onResult={onResult}
            onUse={() => setStep({ kind: 'use', info })}
            onSetup={() => setStep({ kind: 'setup', info })}
            onSelectRole={onSelectRole}
          />
        ))}
      </ul>
      {hidden > 0 && (
        <p className="hint">
          and {hidden} more connected {hidden === 1 ? 'service' : 'services'} not used here.{' '}
          <button type="button" className="link-btn" data-testid="connected-more" onClick={() => setShowAll(true)}>
            Show {hidden === 1 ? 'it' : 'them'}
          </button>
        </p>
      )}
      {step?.kind === 'use' && <UseInProjectDialog project={project} info={step.info} onClose={() => setStep(null)} onResult={onResult} />}
      {step?.kind === 'setup' && (
        <ConnectorDialog
          info={step.info}
          onClose={() => {
            setStep(null)
            onChanged()
          }}
          onConnected={() => onChanged()}
        />
      )}
    </>
  )
}

function ConnectedServiceRow({
  info,
  server,
  project,
  onResult,
  onUse,
  onSetup,
  onSelectRole
}: {
  info: ConnectorInfo
  server: McpServerInfo | undefined
  project: Project
  onResult: (r: McpMutationResult) => void
  onUse: () => void
  onSetup: () => void
  onSelectRole?: (roleId: string) => void
}): ReactElement {
  const { connector } = info
  const chip = stateChip(info)
  const [menu, setMenu] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const spec = server?.spec
  const loseRoles = !spec ? [] : spec.roles === undefined ? project.roles : project.roles.filter((r) => spec.roles?.includes(r.slug))
  const needsSetup = info.state !== 'connected'

  const mutate = async (fn: () => Promise<McpMutationResult>): Promise<void> => {
    setError(null)
    try {
      onResult(await fn())
    } catch (e) {
      setError(errMessage(e))
    }
  }

  return (
    <li
      className={`mcp-row cs-row${spec && !spec.enabled ? ' off' : ''}${needsSetup ? ' warn' : ''}`}
      data-testid="connected-service-row"
      data-connector={connector.id}
      data-id={spec?.id}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && menu) {
          setMenu(false)
          actionsRef.current?.querySelector<HTMLElement>('[aria-expanded]')?.focus()
        }
      }}
    >
      <div className="cs-main">
        <ConnectorLogo def={connector} />
        <div className="cs-id">
          <span className="mcp-name">{connector.name}</span>
          <span className="cs-access">{connectorAccess(info)}</span>
        </div>
        <div className="cs-state">
          <Badge tone={chip.tone} testId="connected-service-state">
            {chip.label}
          </Badge>
        </div>
        <div className="cs-actions" ref={actionsRef}>
          {!spec && !needsSetup && (
            <Button size="sm" variant="primary" testId="connector-use" ariaLabel={`Use ${connector.name} in this project`} onClick={onUse}>
              Use in this project
            </Button>
          )}
          {needsSetup && (
            <Button size="sm" variant={spec ? 'secondary' : 'primary'} testId="connector-finish-setup" ariaLabel={`Finish setup for ${connector.name}`} onClick={onSetup}>
              Finish setup
            </Button>
          )}
          {spec && <IconButton icon={Ellipsis} label={`More actions for ${connector.name}`} size="sm" expanded={menu} onClick={() => setMenu((m) => !m)} />}
        </div>
        {spec && (
          <div className="cs-use">
            <span className="cs-avail" title="Turn off to pause use in this project. The service stays connected.">
              <Switch
                checked={spec.enabled}
                label={`Available to agents: ${connector.name}`}
                onChange={(enabled) => void mutate(() => window.orgai.mcp.upsert({ projectId: project.id, spec: { ...spec, enabled } }))}
              />
              <span>Available to agents</span>
            </span>
            <span className="muted cs-avail-hint">{spec.enabled ? 'Off pauses it in this project only.' : 'Paused in this project. Still connected.'}</span>
            <UsedBy all={spec.roles === undefined} roles={loseRoles} onSelectRole={onSelectRole} />
            <RoleAccess
              quiet
              serverName={connector.name}
              roles={project.roles}
              value={spec.roles}
              onChange={(roles) => void mutate(() => window.orgai.mcp.upsert({ projectId: project.id, spec: { ...spec, roles } }))}
            />
          </div>
        )}
      </div>
      {menu && spec && (
        <div className="mcp-menu cs-menu" role="group" aria-label={`Actions for ${connector.name}`}>
          <Button
            size="sm"
            icon={ExternalLink}
            onClick={() => {
              setMenu(false)
              useAppStore.getState().openMcpLibrary(spec.libraryId)
            }}
          >
            Open in Connectors
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon={Unlink}
            onClick={() => {
              setMenu(false)
              setConfirm(true)
            }}
          >
            Unlink...
          </Button>
        </div>
      )}
      {error && (
        <p className="invalid-text mcp-row-error" role="alert">
          {error}
        </p>
      )}
      {spec && (
        <ConfirmDialog
          open={confirm}
          title={`Stop using ${connector.name} here?`}
          body={
            <p>
              {loseRoles.length > 0 ? `${loseRoles.map((r) => r.name).join(', ')} will lose ${connector.name} right away.` : 'No roles use it.'} The service
              stays connected in App settings.
            </p>
          }
          confirmLabel="Unlink service"
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false)
            void mutate(() => window.orgai.mcp.remove({ projectId: project.id, serverId: spec.id }))
          }}
        />
      )}
    </li>
  )
}
