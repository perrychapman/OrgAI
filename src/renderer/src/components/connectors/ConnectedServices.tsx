import type { ReactElement } from 'react'
import { useRef, useState } from 'react'
import { Ellipsis, ExternalLink, Unlink } from 'lucide-react'
import type { ConnectorInfo, McpMutationResult, McpServerInfo, Project } from '@shared/types'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { ConfirmDialog, Dialog } from '../ui/Dialog'
import { IconButton } from '../ui/IconButton'
import { Switch } from '../ui/Switch'
import { RoleAccess, RoleChecklist } from '../mcp/RoleAccess'
import { errMessage } from '../mcp/mcpHelpers'
import { linkedServerFor, setUpConnectors, useInProjectBlocker } from '../mcp/mcpLibraryHelpers'
import { accessWords, connectorInitial, stateChip } from '../../lib/connectors'
import { useAppStore } from '../../store/useAppStore'
import ConnectorDialog from './ConnectorDialog'

/** The access words for a connector's variant ("Can read" / "Can read and change"). */
export function connectorAccess(info: ConnectorInfo): string {
  const v = info.connector.variants.find((x) => x.id === (info.variant ?? info.connector.defaultVariant)) ?? info.connector.variants[0]
  return v ? accessWords(v) : ''
}

export function ConnectorLogo({ info }: { info: ConnectorInfo }): ReactElement {
  return (
    <span className="cs-logo" aria-hidden="true">
      {connectorInitial(info.connector)}
    </span>
  )
}

/**
 * "Use in this project": choose who may use a connected service, then link its library entry. Least privilege: no role
 * is selected until the user picks some (or All roles).
 */
export function UseInProjectDialog({
  project,
  info,
  onClose,
  onResult
}: {
  project: Project
  info: ConnectorInfo
  onClose: () => void
  onResult: (r: McpMutationResult) => void
}): ReactElement {
  const [roles, setRoles] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const noRoles = project.roles.length === 0
  const blocker = useInProjectBlocker(project.roles.length, roles)
  const entry = info.library?.entry

  const confirm = async (): Promise<void> => {
    if (!entry) return
    setBusy(true)
    setError(null)
    try {
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

  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onClose}
      title={`Use ${info.connector.name} in this project`}
      description={`${connectorAccess(info)}. Pick which roles may use it. You can change this later.`}
      size="md"
      testId="connector-use-dialog"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!entry || blocker !== null} testId="connector-use-confirm" onClick={() => void confirm()}>
            Use in this project
          </Button>
        </>
      }
    >
      {error && (
        <Banner tone="danger" title="Could not add the service">
          {error}
        </Banner>
      )}
      <fieldset className="mcp-vars">
        <legend>Who can use it?</legend>
        <RoleChecklist roles={project.roles} value={roles} onChange={setRoles} label={`Role access for ${info.connector.name}`} />
        {blocker && (
          <span className="hint" role="status" data-testid="connector-use-blocker">
            {blocker}
          </span>
        )}
      </fieldset>
    </Dialog>
  )
}

type Step = { kind: 'use'; info: ConnectorInfo } | { kind: 'setup'; info: ConnectorInfo } | null

/** Project settings > Tools: the services connected in the app, and how this project uses them. */
export default function ConnectedServices({
  project,
  connectors,
  servers,
  onResult,
  onChanged
}: {
  project: Project
  connectors: ConnectorInfo[] | null
  servers: McpServerInfo[]
  onResult: (r: McpMutationResult) => void
  onChanged: () => void
}): ReactElement | null {
  const [step, setStep] = useState<Step>(null)
  const items = setUpConnectors(connectors)
  if (items.length === 0) return null
  return (
    <>
      <ul className="card-block mcp-list" aria-label="Connected services">
        {items.map((info) => (
          <ConnectedServiceRow
            key={info.connector.id}
            info={info}
            server={linkedServerFor(info, servers)}
            project={project}
            onResult={onResult}
            onUse={() => setStep({ kind: 'use', info })}
            onSetup={() => setStep({ kind: 'setup', info })}
          />
        ))}
      </ul>
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
  onSetup
}: {
  info: ConnectorInfo
  server: McpServerInfo | undefined
  project: Project
  onResult: (r: McpMutationResult) => void
  onUse: () => void
  onSetup: () => void
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
      onKeyDown={(e) => {
        if (e.key === 'Escape' && menu) {
          setMenu(false)
          actionsRef.current?.querySelector<HTMLElement>('[aria-expanded]')?.focus()
        }
      }}
    >
      <div className="cs-main">
        <ConnectorLogo info={info} />
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
            <RoleAccess
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
