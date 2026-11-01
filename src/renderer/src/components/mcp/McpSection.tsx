import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Ellipsis, ExternalLink, Library, Minus, Pencil, Plug, Plus, TriangleAlert, Trash2, Unlink, Upload } from 'lucide-react'
import type { McpMutationResult, McpServerInfo, McpServerSpec, McpTestResult, Project } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { ConfirmDialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { Switch } from '../ui/Switch'
import { SettingsGroup } from '../settings/SettingsSection'
import { CatalogGroup } from '../team/CatalogGroup'
import { UsedBy } from '../team/CatalogUsedBy'
import { AuthChip, AuthorizeControl, SourceBadge } from './McpAuth'
import McpAssistDialog from './McpAssistDialog'
import McpLinkDialog from './McpLinkDialog'
import McpServerForm from './McpServerForm'
import RegistryDialog from './RegistryDialog'
import { RoleAccess } from './RoleAccess'
import TestResultPanel from './TestResultPanel'
import { errMessage, launchTarget, secretStatuses } from './mcpHelpers'
import { authTarget, authWarning, emptyKind, setUpConnectors, splitConnectorServers, transportWords } from './mcpLibraryHelpers'
import AddServiceDialog from '../connectors/AddServiceDialog'
import ConnectedServices from '../connectors/ConnectedServices'
import { useConnectors } from '../connectors/useConnectors'
import { projectWriter } from './mcpWriter'
import { useMcpLibrary } from './useMcpLibrary'

type Modal =
  | { kind: 'service' }
  | { kind: 'registry' }
  | { kind: 'link' }
  | { kind: 'form'; editing?: McpServerInfo; seed?: McpServerSpec }
  | { kind: 'assist' }
  | null

const reducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true || document.documentElement.getAttribute('data-reduce-motion') === 'on'

/**
 * Moves the viewer to a connection row (a custom server row or a connected-service row), highlights it and puts focus on
 * its primary action (Authorize / Finish setup when it has one, else its first button).
 */
function focusRow(root: HTMLElement | null, match: { id?: string; name?: string }): boolean {
  if (!root) return false
  const row = [...root.querySelectorAll<HTMLElement>('[data-testid="mcp-row"], [data-testid="connected-service-row"]')].find((r) =>
    match.id ? r.dataset.id === match.id : r.dataset.server === match.name
  )
  if (!row) return false
  row.scrollIntoView({ block: 'center' })
  const control =
    row.querySelector<HTMLElement>('[data-testid="mcp-library-authorize"], [data-testid="connector-finish-setup"]') ?? row.querySelector<HTMLElement>('button')
  control?.focus()
  if (!reducedMotion()) {
    row.classList.add('is-flash')
    window.setTimeout(() => row.classList.remove('is-flash'), 1800)
  }
  return true
}

/**
 * Team > Catalog > Connections: the services (connectors) and custom servers this project uses, with who may use them.
 * One "Add a connection" button opens the picker that also holds the other ways to add. Sign-in lives in App settings.
 */
export default function McpSection({ project, onSelectRole }: { project: Project; onSelectRole?: (roleId: string) => void }): ReactElement {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [modal, setModal] = useState<Modal>(null)
  const seq = useRef(0)
  const root = useRef<HTMLElement>(null)
  const setView = useAppStore((s) => s.setView)
  const focus = useAppStore((s) => s.mcpFocus)
  const clearMcpFocus = useAppStore((s) => s.clearMcpFocus)
  const { library, refresh: refreshLibrary } = useMcpLibrary()
  const { connectors, error: connectorsError, refresh: refreshConnectors } = useConnectors()
  const assistRun = useAppStore((s) => {
    const id = s.activeRunByProject[project.id]
    const summary = id ? s.runs[id]?.summary : undefined
    return summary?.kind === 'mcp-assist' && ['starting', 'running', 'idle'].includes(summary.status) ? summary : null
  })

  const refresh = useCallback((): void => {
    const mine = ++seq.current
    window.orgai.mcp
      .list(project.id)
      .then((list) => {
        if (mine !== seq.current) return
        setServers(list)
        setLoadError(null)
      })
      .catch((e) => {
        if (mine === seq.current) setLoadError(errMessage(e))
      })
  }, [project.id])

  useEffect(() => {
    setServers(null)
    setLoadError(null)
    refresh()
  }, [project.id, refresh])
  // Servers added by an approved proposal or install card change project.mcpServers: reload quietly.
  useEffect(() => {
    if (servers !== null) refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.mcpServers])
  // A library edit, authorization or removal changes the linked rows' snapshots and status.
  useEffect(() => {
    if (servers !== null) refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library])

  // Deep link (a run's "not authorized" notice): scroll to the section or the named server once the rows exist.
  useEffect(() => {
    if (focus?.kind !== 'server' || focus.projectId !== project.id || servers === null) return
    if (!(focus.serverId && focusRow(root.current, { id: focus.serverId }))) root.current?.scrollIntoView({ block: 'start' })
    // Finish setup: a project-level server with a missing secret opens its edit form on that secret.
    const target = focus.edit ? servers.find((s) => s.spec.id === focus.serverId) : undefined
    if (target && !target.spec.libraryId && target.missingSecrets.length > 0) {
      setModal({ kind: 'form', editing: target })
      const missing = target.missingSecrets[0]
      window.setTimeout(() => {
        const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid=mcp-form] .mcp-var-row'))
        const row = rows.find((r) => r.querySelector<HTMLInputElement>('input')?.value === missing)
        row?.querySelector<HTMLElement>('.mcp-var-value button:not([disabled]), .mcp-var-value input:not([disabled])')?.focus()
      }, 200)
    }
    clearMcpFocus()
  }, [focus, servers, project.id, clearMcpFocus])

  const applyResult = useCallback((result: McpMutationResult): void => {
    seq.current++
    setServers(result.servers)
    setLoadError(null)
    useAppStore.getState().replaceProject(result.project)
    refreshLibrary()
  }, [refreshLibrary])
  const writer = useMemo(() => projectWriter(project, applyResult), [project, applyResult])

  const all = servers ?? []
  const { rest } = splitConnectorServers(all, connectors)
  const linked = rest.filter((s) => s.spec.libraryId)
  const local = rest.filter((s) => !s.spec.libraryId)
  const hasConnectedServices = setUpConnectors(connectors).length > 0
  // Connector-linked servers show their own state and "Finish setup" on the row; the banner is for the rest.
  const warnings = authWarning(all.filter((s) => !s.spec.connectorId))
  const libraryCount = library?.length ?? 0

  const empty = servers !== null && servers.length === 0 && !hasConnectedServices
  const addButton = (
    <Button variant="primary" icon={Plus} testId="mcp-add-service" onClick={() => setModal({ kind: 'service' })}>
      Add a connection
    </Button>
  )
  const openConnectors = (): void => {
    requestAppSettingsSection(APP_SETTINGS_SECTIONS.mcpLibrary)
    setView('appSettings')
  }

  const rowProps = (info: McpServerInfo): Parameters<typeof McpRow>[0] => ({
    info,
    project,
    onResult: applyResult,
    onRefresh: () => {
      refresh()
      refreshLibrary()
    },
    onEdit: () => setModal({ kind: 'form', editing: info }),
    onDuplicate: () => setModal({ kind: 'form', seed: info.spec }),
    onSelectRole
  })

  return (
    <CatalogGroup
      id="catalog-section-connections"
      title="Connections"
      count={servers === null ? undefined : all.length}
      description="Services your agents can reach, like Slack or Gmail, plus custom servers."
      actions={servers === null || empty ? undefined : addButton}
      testId="catalog-connections"
      sectionRef={root}
    >
      <div className="mcp-body" data-testid="mcp-section">
        {assistRun && (
          <Banner
            tone="neutral"
            actions={
              <Button size="sm" onClick={() => setView('run')}>
                Open run
              </Button>
            }
          >
            An assistant run is setting up servers.
          </Banner>
        )}
        {warnings.length > 0 && (
          <Banner
            tone="warning"
            testId="mcp-auth-warning"
            title={warnings.length === 1 ? `${warnings[0].name} is not authorized` : `${warnings.length} servers are not authorized`}
            actions={warnings.map((w) => (
              <Button key={w.id} size="sm" onClick={() => focusRow(root.current, { id: w.id })}>
                {w.expired ? 'Reauthorize' : 'Authorize'} {w.name}
              </Button>
            ))}
          >
            Agents will not be able to use {warnings.length === 1 ? 'it' : 'them'} until you sign in.
          </Banner>
        )}
        {loadError ? (
          <Banner
            tone="danger"
            title="Could not load connections"
            actions={
              <Button size="sm" onClick={refresh}>
                Retry
              </Button>
            }
          >
            {loadError}
          </Banner>
        ) : servers === null ? (
          <div className="card-block mcp-list" aria-busy="true" aria-label="Loading connections">
            {[0, 1, 2].map((i) => (
              <div key={i} className="card-sec">
                <div className="skeleton mcp-sk" />
              </div>
            ))}
          </div>
        ) : servers.length === 0 && !hasConnectedServices ? (
          <div className="card-block mcp-empty" data-testid="mcp-empty">
            <Icon icon={Plug} size="lg" />
            {emptyKind(connectors) === 'use' ? (
              <>
                <strong>Use a connected service</strong>
                <p className="muted">Pick one of your connected services and choose which roles may use it.</p>
                {addButton}
              </>
            ) : (
              <>
                <strong>No connections yet</strong>
                <p className="muted">Connect a service like Slack or Gmail, or set up a custom server. You then choose which roles in this project may use it.</p>
                {addButton}
              </>
            )}
          </div>
        ) : (
          <>
            {hasConnectedServices && (
              <div data-testid="mcp-group-connectors">
                <SettingsGroup title="Connected services">
                  <ConnectedServices project={project} connectors={connectors} servers={all} onResult={applyResult} onChanged={refreshConnectors} onSelectRole={onSelectRole} />
                </SettingsGroup>
              </div>
            )}
            {(linked.length > 0 || (!hasConnectedServices && local.length === 0)) && (
            <div data-testid="mcp-group-library">
              <SettingsGroup title="Custom servers you added">
                {linked.length === 0 ? (
                  <p className="muted">{libraryCount > 0 ? 'None added yet.' : 'None yet. Custom servers are defined in App settings.'}</p>
                ) : (
                  <ul className="card-block mcp-list" aria-label="Custom servers you added">
                    {linked.map((info) => (
                      <McpRow key={info.spec.id} {...rowProps(info)} />
                    ))}
                  </ul>
                )}
              </SettingsGroup>
            </div>
            )}
            {(local.length > 0 || !hasConnectedServices) && (
            <div data-testid="mcp-group-local">
              <SettingsGroup title="Only in this project">
                {local.length === 0 ? (
                  <p className="muted">No project-only servers.</p>
                ) : (
                  <ul className="card-block mcp-list" aria-label="Servers only in this project">
                    {local.map((info) => (
                      <McpRow key={info.spec.id} {...rowProps(info)} />
                    ))}
                  </ul>
                )}
              </SettingsGroup>
            </div>
            )}
          </>
        )}

        {modal?.kind === 'service' && (
          <AddServiceDialog
            project={project}
            connectors={connectors}
            error={connectorsError}
            servers={all}
            onClose={() => setModal(null)}
            onResult={applyResult}
            onOther={(way) => setModal({ kind: way })}
          />
        )}
        {modal?.kind === 'link' && (
          <McpLinkDialog
            project={project}
            library={library ?? []}
            servers={all}
            onClose={() => setModal(null)}
            onResult={applyResult}
            onOpenLibrary={() => {
              setModal(null)
              useAppStore.getState().openMcpLibrary()
            }}
          />
        )}
        {modal?.kind === 'registry' && <RegistryDialog writer={writer} servers={all} onClose={() => setModal(null)} onAddManually={() => setModal({ kind: 'form' })} />}
        {modal?.kind === 'form' && (
          <McpServerForm key={modal.editing?.spec.id ?? modal.seed?.id ?? 'new'} writer={writer} servers={all} editing={modal.editing} seed={modal.seed} onClose={() => setModal(null)} />
        )}
        <McpAssistDialog
          open={modal?.kind === 'assist'}
          onClose={() => setModal(null)}
          onStart={(text) => useAppStore.getState().startMcpAssist(text)}
          title="Ask the Team assistant"
          description="An assistant run proposes servers, using your connected services and custom servers first. You approve each one in the live run."
          placeholder="Search the web, read GitHub issues..."
        />
        {!empty && servers !== null && (
          <p className="hint catalog-note">
            Sign in, tokens and permissions are managed in App settings.{' '}
            <button type="button" className="link-btn" data-testid="catalog-open-connectors" onClick={openConnectors}>
              Open Connectors
            </button>
          </p>
        )}
      </div>
    </CatalogGroup>
  )
}

function McpRow({
  info,
  project,
  onResult,
  onRefresh,
  onEdit,
  onDuplicate,
  onSelectRole
}: {
  info: McpServerInfo
  project: Project
  onResult: (r: McpMutationResult) => void
  onRefresh: () => void
  onEdit: () => void
  onDuplicate: () => void
  onSelectRole?: (roleId: string) => void
}): ReactElement {
  const { spec } = info
  const linked = !!spec.libraryId
  const [menu, setMenu] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<McpTestResult | null>(null)
  const [focusResult, setFocusResult] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useRef(0)
  const pointer = useRef(false)
  const target = launchTarget(spec)
  const secrets = secretStatuses(info)
  const needsSecret = info.missingSecrets.length > 0
  const remote = spec.transport !== 'stdio'
  const loseRoles = spec.roles === undefined ? project.roles : project.roles.filter((r) => spec.roles?.includes(r.slug))

  const mutate = async (fn: () => Promise<McpMutationResult>): Promise<void> => {
    setError(null)
    try {
      onResult(await fn())
    } catch (e) {
      setError(errMessage(e))
    }
  }
  const upsert = (next: McpServerSpec): Promise<void> => mutate(() => window.orgai.mcp.upsert({ projectId: project.id, spec: next }))

  const test = (viaKeyboard: boolean): void => {
    const mine = ++run.current
    setTesting(true)
    setError(null)
    window.orgai.mcp
      .test({ projectId: project.id, serverId: spec.id })
      .then((r) => {
        if (mine !== run.current) return
        setResult(r)
        setFocusResult(viaKeyboard)
      })
      .catch((e) => {
        if (mine !== run.current) return
        setResult({ ok: false, error: errMessage(e) })
        setFocusResult(viaKeyboard)
      })
      .finally(() => {
        if (mine === run.current) setTesting(false)
      })
  }
  const cancelTest = (): void => {
    run.current++
    setTesting(false)
  }

  const showAuth = remote && info.auth.state !== 'notRequired' && !info.libraryMissing

  return (
    <li
      className={`mcp-row${spec.enabled ? '' : ' off'}${needsSecret || info.libraryMissing ? ' warn' : ''}`}
      data-testid="mcp-row"
      data-server={spec.name}
      data-id={spec.id}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && menu) {
          setMenu(false)
          e.currentTarget.querySelector<HTMLElement>('.mcp-row-actions [aria-expanded]')?.focus()
        } else if (e.key === 'Escape' && testing) cancelTest()
      }}
    >
      <div className="mcp-row-main">
        <Switch checked={spec.enabled} label={`Enable ${spec.name}`} onChange={(enabled) => void upsert({ ...spec, enabled })} />
        <div className="mcp-row-id">
          <span className="mcp-name">{spec.name}</span>
          <span className="mono mcp-target" title={target}>
            {target}
          </span>
          {secrets.length > 0 && (
            <span className={`mcp-secrets${needsSecret ? ' warn' : ''}`}>
              {secrets.map((s, i) => (
                <span key={s.name} className="mcp-secret">
                  <Icon icon={s.set ? Check : Minus} size="xs" />
                  <span className="mono">{s.name}</span> {s.set ? 'set' : 'not set'}
                  {i < secrets.length - 1 ? <span aria-hidden="true"> · </span> : null}
                </span>
              ))}
            </span>
          )}
        </div>
        <div className="mcp-row-meta">
          <Badge>{transportWords(spec.transport)}</Badge>
          {linked ? (
            <Badge tone="accent" icon={Library} testId="mcp-row-library-badge" title="Defined in your MCP library">
              Library
            </Badge>
          ) : (
            <SourceBadge source={spec.source} />
          )}
          {showAuth && <AuthChip auth={info.auth} />}
        </div>
        <div className="mcp-row-roles">
          <UsedBy all={spec.roles === undefined} roles={loseRoles} onSelectRole={onSelectRole} />
          <RoleAccess quiet serverName={spec.name} roles={project.roles} value={spec.roles} onChange={(roles) => void upsert({ ...spec, roles })} />
        </div>
        <div className="mcp-row-actions">
          {remote && !info.libraryMissing && (
            <AuthorizeControl target={authTarget(project.id, spec)} auth={info.auth} serverName={spec.name} onChanged={onRefresh} />
          )}
          {testing ? (
            <Button size="sm" onClick={cancelTest} title="Cancel the test (Esc)">
              Cancel
            </Button>
          ) : (
            <span onPointerDown={() => (pointer.current = true)} className="mcp-test-btn">
              <Button
                size="sm"
                testId="mcp-test"
                title={`Test ${spec.name}`}
                onClick={() => {
                  test(!pointer.current)
                  pointer.current = false
                }}
              >
                Test
              </Button>
            </span>
          )}
          {testing && (
            <span className="muted" role="status">
              Testing
            </span>
          )}
          <IconButton icon={Ellipsis} label={`More actions for ${spec.name}`} size="sm" expanded={menu} onClick={() => setMenu((m) => !m)} />
        </div>
      </div>
      {info.libraryMissing && (
        <p className="mcp-row-note warn" role="status" data-testid="mcp-library-missing">
          <Icon icon={TriangleAlert} size="sm" />
          <span>Its library entry was removed. Agents will not get this server. Unlink it, or add it back to the library.</span>
        </p>
      )}
      {linked && needsSecret && !info.libraryMissing && (
        <p className="mcp-row-note warn" role="status">
          <Icon icon={TriangleAlert} size="sm" />
          <span>
            Secrets not set in the library: <span className="mono">{info.missingSecrets.join(', ')}</span>.{' '}
            <button type="button" className="link-btn" onClick={() => useAppStore.getState().openMcpLibrary(spec.libraryId)}>
              {spec.connectorId ? 'Open in Connectors' : 'Open in library'}
            </button>
          </span>
        </p>
      )}
      {menu && (
        <div className="mcp-menu" role="group" aria-label={`Actions for ${spec.name}`}>
          {linked ? (
            <>
              <Button
                size="sm"
                icon={ExternalLink}
                onClick={() => {
                  setMenu(false)
                  useAppStore.getState().openMcpLibrary(spec.libraryId)
                }}
              >
                {spec.connectorId ? 'Open in Connectors' : 'Open in library'}
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
            </>
          ) : (
            <>
              <Button
                size="sm"
                icon={Pencil}
                onClick={() => {
                  setMenu(false)
                  onEdit()
                }}
              >
                Edit
              </Button>
              <Button
                size="sm"
                icon={Copy}
                onClick={() => {
                  setMenu(false)
                  onDuplicate()
                }}
              >
                Duplicate
              </Button>
              <Button
                size="sm"
                icon={Upload}
                testId="mcp-promote"
                title="Move this server, with its secrets and sign-in, into your MCP library and link it here"
                onClick={() => {
                  setMenu(false)
                  void mutate(() => window.orgai.mcp.promote({ projectId: project.id, serverId: spec.id }))
                }}
              >
                Add to library
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon={Trash2}
                onClick={() => {
                  setMenu(false)
                  setConfirm(true)
                }}
              >
                Remove server...
              </Button>
            </>
          )}
        </div>
      )}
      {error && (
        <p className="invalid-text mcp-row-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <TestResultPanel
          serverName={spec.name}
          result={result}
          focusOnMount={focusResult}
          authorize={
            remote
              ? {
                  target: authTarget(project.id, spec),
                  auth: info.auth,
                  onChanged: onRefresh,
                  onUseToken: linked ? undefined : onEdit
                }
              : undefined
          }
        />
      )}
      <ConfirmDialog
        open={confirm}
        title={linked ? `Unlink ${spec.name}?` : `Remove ${spec.name}?`}
        body={
          <p>
            {loseRoles.length > 0 ? `${loseRoles.map((r) => r.name).join(', ')} will lose the tools from this server right away.` : 'No roles use this server.'}{' '}
            {linked ? 'The library entry, its secrets and its sign-in stay.' : 'Stored secrets for it are deleted.'}
          </p>
        }
        confirmLabel={linked ? 'Unlink server' : 'Remove server'}
        danger
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false)
          void mutate(() => window.orgai.mcp.remove({ projectId: project.id, serverId: spec.id }))
        }}
      />
    </li>
  )
}
