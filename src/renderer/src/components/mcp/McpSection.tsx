import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Ellipsis, ExternalLink, Library, Minus, Package, Pencil, Plug, Plus, Sparkles, TriangleAlert, Trash2, Unlink, Upload } from 'lucide-react'
import type { McpMutationResult, McpServerInfo, McpServerSpec, McpTestResult, Project } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { ConfirmDialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { Switch } from '../ui/Switch'
import { AuthChip, AuthorizeControl, SourceBadge } from './McpAuth'
import McpAssistDialog from './McpAssistDialog'
import McpLinkDialog from './McpLinkDialog'
import McpServerForm from './McpServerForm'
import RegistryDialog from './RegistryDialog'
import { RoleAccess } from './RoleAccess'
import TestResultPanel from './TestResultPanel'
import { errMessage, launchTarget, secretStatuses } from './mcpHelpers'
import { authTarget, authWarning, transportWords } from './mcpLibraryHelpers'
import { projectWriter } from './mcpWriter'
import { useMcpLibrary } from './useMcpLibrary'

type Modal =
  | { kind: 'registry' }
  | { kind: 'link' }
  | { kind: 'form'; editing?: McpServerInfo; seed?: McpServerSpec }
  | { kind: 'assist' }
  | null

/** Moves the viewer to a server row and onto its first control (the Authorize button when it has one). */
function focusRow(root: HTMLElement | null, match: { id?: string; name?: string }): boolean {
  if (!root) return false
  const row = [...root.querySelectorAll<HTMLElement>('[data-testid="mcp-row"]')].find((r) => (match.id ? r.dataset.id === match.id : r.dataset.server === match.name))
  if (!row) return false
  row.scrollIntoView({ block: 'center' })
  const control = row.querySelector<HTMLElement>('[data-testid="mcp-library-authorize"]') ?? row.querySelector<HTMLElement>('button')
  control?.focus()
  return true
}

export default function McpSection({ project }: { project: Project }): ReactElement {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [modal, setModal] = useState<Modal>(null)
  const seq = useRef(0)
  const root = useRef<HTMLElement>(null)
  const setView = useAppStore((s) => s.setView)
  const focus = useAppStore((s) => s.mcpFocus)
  const clearMcpFocus = useAppStore((s) => s.clearMcpFocus)
  const { library, refresh: refreshLibrary } = useMcpLibrary()
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
  const linked = all.filter((s) => s.spec.libraryId)
  const local = all.filter((s) => !s.spec.libraryId)
  const warnings = authWarning(all)
  const libraryCount = library?.length ?? 0

  const actions = (
    <div className="section-actions mcp-actions">
      <Button variant="primary" icon={Library} testId="mcp-add-library" onClick={() => setModal({ kind: 'link' })}>
        Add from library
      </Button>
      <Button icon={Package} onClick={() => setModal({ kind: 'registry' })}>
        Add from registry
      </Button>
      <Button icon={Plus} onClick={() => setModal({ kind: 'form' })}>
        Add manually
      </Button>
      <Button icon={Sparkles} onClick={() => setModal({ kind: 'assist' })}>
        Configure with AI
      </Button>
    </div>
  )

  const rowProps = (info: McpServerInfo): Parameters<typeof McpRow>[0] => ({
    info,
    project,
    onResult: applyResult,
    onRefresh: () => {
      refresh()
      refreshLibrary()
    },
    onEdit: () => setModal({ kind: 'form', editing: info }),
    onDuplicate: () => setModal({ kind: 'form', seed: info.spec })
  })

  return (
    <section ref={root} id="settings-section-mcp" className="mcp-section" aria-labelledby="mcp-title" data-testid="mcp-section">
      <div className="section-head">
        <div>
          <h2 id="mcp-title">MCP servers</h2>
          <p>Tools agents can call. Servers run code on this machine or connect to remote hosts.</p>
        </div>
        {actions}
      </div>
      {assistRun && (
        <Banner
          tone="neutral"
          actions={
            <Button size="sm" onClick={() => setView('run')}>
              Open run
            </Button>
          }
        >
          An assistant run is configuring MCP servers.
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
          title="Could not load MCP servers"
          actions={
            <Button size="sm" onClick={refresh}>
              Retry
            </Button>
          }
        >
          {loadError}
        </Banner>
      ) : servers === null ? (
        <div className="card-block mcp-list" aria-busy="true" aria-label="Loading MCP servers">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card-sec">
              <div className="skeleton mcp-sk" />
            </div>
          ))}
        </div>
      ) : servers.length === 0 ? (
        <div className="card-block mcp-empty">
          <Icon icon={Plug} size="lg" />
          <strong>No MCP servers</strong>
          <p className="muted">
            {libraryCount > 0
              ? 'Start with Add from library to reuse a server you already set up. Or add one from the registry, by hand, or ask an assistant.'
              : 'Add one from the registry, set one up by hand, or ask an assistant. Servers you add to the MCP library in app settings can be reused in every project.'}
          </p>
        </div>
      ) : (
        <>
          <div className="mcp-group" data-testid="mcp-group-library">
            <h3 className="mcp-group-title">From your library</h3>
            {linked.length === 0 ? (
              <p className="muted">
                {libraryCount > 0 ? 'Nothing from the library is in this project yet. Use Add from library.' : 'Your MCP library is empty.'}
              </p>
            ) : (
              <ul className="card-block mcp-list" aria-label="MCP servers from your library">
                {linked.map((info) => (
                  <McpRow key={info.spec.id} {...rowProps(info)} />
                ))}
              </ul>
            )}
          </div>
          <div className="mcp-group" data-testid="mcp-group-local">
            <h3 className="mcp-group-title">Only in this project</h3>
            {local.length === 0 ? (
              <p className="muted">No project-only servers.</p>
            ) : (
              <ul className="card-block mcp-list" aria-label="MCP servers only in this project">
                {local.map((info) => (
                  <McpRow key={info.spec.id} {...rowProps(info)} />
                ))}
              </ul>
            )}
          </div>
        </>
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
        title="Configure MCP servers with AI"
        description="An assistant run proposes servers, using your library first. You approve each one in the live run."
        placeholder="Search the web, read GitHub issues..."
      />
    </section>
  )
}

function McpRow({
  info,
  project,
  onResult,
  onRefresh,
  onEdit,
  onDuplicate
}: {
  info: McpServerInfo
  project: Project
  onResult: (r: McpMutationResult) => void
  onRefresh: () => void
  onEdit: () => void
  onDuplicate: () => void
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
          <RoleAccess serverName={spec.name} roles={project.roles} value={spec.roles} onChange={(roles) => void upsert({ ...spec, roles })} />
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
              Open in library
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
                Open in library
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
