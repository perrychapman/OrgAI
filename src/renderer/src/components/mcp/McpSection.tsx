import type { ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, Check, Copy, Ellipsis, Minus, Package, Pencil, Plug, Plus, Sparkles, Trash2, User } from 'lucide-react'
import type { McpMutationResult, McpServerInfo, McpServerSpec, McpTestResult, Project } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { ConfirmDialog, Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { Switch } from '../ui/Switch'
import McpServerForm from './McpServerForm'
import RegistryDialog from './RegistryDialog'
import { RoleAccess } from './RoleAccess'
import TestResultPanel from './TestResultPanel'
import { errMessage, launchTarget, secretStatuses } from './mcpHelpers'

type Modal =
  | { kind: 'registry' }
  | { kind: 'form'; editing?: McpServerInfo; seed?: McpServerSpec }
  | { kind: 'assist' }
  | null

export default function McpSection({ project }: { project: Project }): ReactElement {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [modal, setModal] = useState<Modal>(null)
  const seq = useRef(0)
  const setView = useAppStore((s) => s.setView)
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

  const applyResult = useCallback((result: McpMutationResult): void => {
    seq.current++
    setServers(result.servers)
    setLoadError(null)
    useAppStore.getState().replaceProject(result.project)
  }, [])

  const actions = (
    <div className="section-actions mcp-actions">
      <Button variant="primary" icon={Package} onClick={() => setModal({ kind: 'registry' })}>
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

  return (
    <section id="settings-section-mcp" className="mcp-section" aria-labelledby="mcp-title" data-testid="mcp-section">
      <div className="section-head">
        <div>
          <h2 id="mcp-title">MCP servers</h2>
          <p>Tools agents can call. Servers run code on this machine.</p>
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
          <p className="muted">Add one from the registry, set one up by hand, or ask an assistant.</p>
        </div>
      ) : (
        <ul className="card-block mcp-list" aria-label="MCP servers">
          {servers.map((info) => (
            <McpRow
              key={info.spec.id}
              info={info}
              project={project}
              onResult={applyResult}
              onEdit={() => setModal({ kind: 'form', editing: info })}
              onDuplicate={() => setModal({ kind: 'form', seed: info.spec })}
            />
          ))}
        </ul>
      )}

      {modal?.kind === 'registry' && (
        <RegistryDialog
          project={project}
          servers={servers ?? []}
          onClose={() => setModal(null)}
          onResult={applyResult}
          onAddManually={() => setModal({ kind: 'form' })}
        />
      )}
      {modal?.kind === 'form' && (
        <McpServerForm
          key={modal.editing?.spec.id ?? modal.seed?.id ?? 'new'}
          project={project}
          servers={servers ?? []}
          editing={modal.editing}
          seed={modal.seed}
          onClose={() => setModal(null)}
          onResult={applyResult}
        />
      )}
      <AssistDialog open={modal?.kind === 'assist'} onClose={() => setModal(null)} />
    </section>
  )
}

function AssistDialog({ open, onClose }: { open: boolean; onClose: () => void }): ReactElement {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const start = async (): Promise<void> => {
    if (!text.trim()) return
    setBusy(true)
    setError(null)
    try {
      await useAppStore.getState().startMcpAssist(text.trim())
      setText('')
      onClose()
    } catch (e) {
      setError(errMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="Configure MCP servers with AI"
      description="An assistant run proposes servers. You approve each one in the live run."
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!text.trim()} onClick={() => void start()}>
            Start assistant run
          </Button>
        </>
      }
    >
      {error && (
        <Banner tone="danger" title="Could not start the assistant">
          {error}
        </Banner>
      )}
      <div className="field mcp-field">
        <label htmlFor="mcp-assist-text">What should agents be able to do?</label>
        <textarea
          id="mcp-assist-text"
          className="textarea"
          data-autofocus
          rows={4}
          value={text}
          placeholder="Search the web, read GitHub issues..."
          onChange={(e) => setText(e.target.value)}
        />
      </div>
    </Dialog>
  )
}

function McpRow({
  info,
  project,
  onResult,
  onEdit,
  onDuplicate
}: {
  info: McpServerInfo
  project: Project
  onResult: (r: McpMutationResult) => void
  onEdit: () => void
  onDuplicate: () => void
}): ReactElement {
  const { spec } = info
  const [menu, setMenu] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<McpTestResult | null>(null)
  const [focusResult, setFocusResult] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useRef(0)
  const moreBtn = useRef<HTMLButtonElement>(null)
  const target = launchTarget(spec)
  const secrets = secretStatuses(info)
  const needsSecret = info.missingSecrets.length > 0
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
  const failed = result && !result.ok ? result.error?.split('\n').filter(Boolean)[0] : undefined

  const sourceBadge =
    spec.source === 'registry' ? (
      <Badge tone="info" icon={Package}>
        Registry
      </Badge>
    ) : spec.source === 'agent' ? (
      <Badge tone="warning" icon={Bot} title="An agent requested this server and you approved it.">
        Agent
      </Badge>
    ) : (
      <Badge icon={User}>You</Badge>
    )

  return (
    <li
      className={`mcp-row${spec.enabled ? '' : ' off'}${needsSecret ? ' warn' : ''}`}
      data-testid="mcp-row"
      data-server={spec.name}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && menu) {
          setMenu(false)
          moreBtn.current?.focus()
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
          <Badge>{spec.transport}</Badge>
          {sourceBadge}
          <RoleAccess
            serverName={spec.name}
            roles={project.roles}
            value={spec.roles}
            onChange={(roles) => void upsert({ ...spec, roles })}
          />
        </div>
        <div className="mcp-row-actions">
          {testing ? (
            <Button size="sm" onClick={cancelTest} title="Cancel the test (Esc)">
              Cancel
            </Button>
          ) : (
            <button
              type="button"
              className="btn sm"
              data-testid="mcp-test"
              aria-label="Test"
              title={`Test ${spec.name}`}
              onClick={(e) => test(e.detail === 0)}
            >
              Test
            </button>
          )}
          {testing && (
            <span className="muted" role="status">
              Testing
            </span>
          )}
          <button
            ref={moreBtn}
            type="button"
            className="icon-btn size-sm"
            aria-label={`More actions for ${spec.name}`}
            title="More actions"
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
          >
            <Icon icon={Ellipsis} size="sm" />
          </button>
        </div>
      </div>
      {menu && (
        <div className="mcp-menu" role="group" aria-label={`Actions for ${spec.name}`}>
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
            variant="danger"
            icon={Trash2}
            onClick={() => {
              setMenu(false)
              setConfirm(true)
            }}
          >
            Remove server...
          </Button>
        </div>
      )}
      {error && (
        <p className="invalid-text mcp-row-error" role="alert">
          {error}
        </p>
      )}
      {failed && !error && <p className="invalid-text mcp-row-error">Failed to start: {failed}</p>}
      {result && <TestResultPanel serverName={spec.name} result={result} focusOnMount={focusResult} />}
      <ConfirmDialog
        open={confirm}
        title={`Remove ${spec.name}?`}
        body={
          <p>
            {loseRoles.length > 0
              ? `${loseRoles.map((r) => r.name).join(', ')} will lose the tools from this server.`
              : 'No roles use this server.'}{' '}
            Stored secrets for it are deleted.
          </p>
        }
        confirmLabel="Remove server"
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
