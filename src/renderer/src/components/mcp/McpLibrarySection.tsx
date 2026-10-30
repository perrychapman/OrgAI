import type { ReactElement } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, Ellipsis, KeyRound, Library, Pencil, Plus, Package, ShieldOff, Sparkles, Trash2 } from 'lucide-react'
import type { McpLibraryInfo, McpTestResult } from '@shared/types'
import { HARNESS_PROJECT_ID } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { ConfirmDialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { SecretField } from '../ui/SecretField'
import { AuthChip, AuthorizeControl, SourceBadge } from './McpAuth'
import McpAssistDialog from './McpAssistDialog'
import McpServerForm from './McpServerForm'
import RegistryDialog from './RegistryDialog'
import TestResultPanel from './TestResultPanel'
import { errMessage, launchTarget, secretStatuses } from './mcpHelpers'
import { infoFromLibrary, transportWords } from './mcpLibraryHelpers'
import { libraryWriter } from './mcpWriter'
import { useMcpLibrary } from './useMcpLibrary'

type Modal = { kind: 'registry' } | { kind: 'form'; editing?: McpLibraryInfo } | { kind: 'assist' } | null

/** App settings: the MCP library. Servers are defined here once and linked by projects. */
export default function McpLibrarySection(): ReactElement {
  const { library, error, refresh, setLibrary } = useMcpLibrary()
  const [modal, setModal] = useState<Modal>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const focus = useAppStore((s) => s.mcpFocus)
  const clearMcpFocus = useAppStore((s) => s.clearMcpFocus)
  const section = useRef<HTMLElement>(null)
  const assistRun = useAppStore((s) =>
    Object.values(s.runs).find(
      (r) => r.summary.projectId === HARNESS_PROJECT_ID && r.summary.kind === 'mcp-assist' && ['starting', 'running', 'idle'].includes(r.summary.status)
    )
  )
  const writer = useMemo(() => libraryWriter(setLibrary), [setLibrary])

  // A deep link ("Open in library") lands here: scroll to the section or the entry and move focus into it.
  useEffect(() => {
    if (focus?.kind !== 'library') return
    if (focus.libraryId && library === null) return
    const row = focus.libraryId ? section.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(focus.libraryId)}"]`) : null
    const target = row ?? section.current
    target?.scrollIntoView({ block: 'start' })
    row?.querySelector<HTMLElement>('button')?.focus()
    clearMcpFocus()
  }, [focus, library, clearMcpFocus])

  const openRun = async (runId: string): Promise<void> => {
    setOpenError(null)
    try {
      await window.orgai.window.openRun({ projectId: HARNESS_PROJECT_ID, runId })
    } catch (e) {
      setOpenError(errMessage(e))
    }
  }
  const startAssist = async (instruction: string): Promise<void> => {
    const summary = await useAppStore.getState().startLibraryAssist(instruction)
    await openRun(summary.id)
  }

  const infos = library ?? []
  return (
    <section ref={section} id="appsettings-section-mcp-library" className="settings-section mcp-section" aria-labelledby="mcp-library-title" data-testid="mcp-library-section" tabIndex={-1}>
      <div className="section-head">
        <div>
          <h2 id="mcp-library-title">MCP library</h2>
          <p>Define tool servers once, then add them to any project. Credentials and sign-in live here.</p>
        </div>
        <div className="section-actions mcp-actions">
          <Button variant="primary" icon={Package} testId="mcp-library-add-registry" onClick={() => setModal({ kind: 'registry' })}>
            Add from registry
          </Button>
          <Button icon={Plus} testId="mcp-library-add-manual" onClick={() => setModal({ kind: 'form' })}>
            Add manually
          </Button>
          <Button icon={Sparkles} testId="mcp-library-assist" onClick={() => setModal({ kind: 'assist' })}>
            Configure with AI
          </Button>
        </div>
      </div>
      {assistRun && (
        <Banner
          tone="neutral"
          testId="mcp-library-assist-banner"
          actions={
            <Button size="sm" onClick={() => void openRun(assistRun.summary.id)}>
              Open run
            </Button>
          }
        >
          An assistant run is configuring your library.
        </Banner>
      )}
      {openError && (
        <Banner tone="danger" title="Could not open the run">
          {openError}
        </Banner>
      )}
      {error ? (
        <Banner
          tone="danger"
          title="Could not load the MCP library"
          actions={
            <Button size="sm" onClick={refresh}>
              Retry
            </Button>
          }
        >
          {error}
        </Banner>
      ) : library === null ? (
        <div className="card-block mcp-list" aria-busy="true" aria-label="Loading the MCP library">
          {[0, 1].map((i) => (
            <div key={i} className="card-sec">
              <div className="skeleton mcp-sk" />
            </div>
          ))}
        </div>
      ) : infos.length === 0 ? (
        <div className="card-block mcp-empty">
          <Icon icon={Library} size="lg" />
          <strong>Your library is empty</strong>
          <p className="muted">Add a server from the registry or by hand, or ask an assistant to set one up. Projects then pick what they need.</p>
        </div>
      ) : (
        <ul className="card-block mcp-list" aria-label="MCP library">
          {infos.map((info) => (
            <LibraryRow key={info.entry.id} info={info} onList={setLibrary} onEdit={() => setModal({ kind: 'form', editing: info })} />
          ))}
        </ul>
      )}

      {modal?.kind === 'registry' && (
        <RegistryDialog writer={writer} servers={infos.map(infoFromLibrary)} onClose={() => setModal(null)} onAddManually={() => setModal({ kind: 'form' })} />
      )}
      {modal?.kind === 'form' && (
        <McpServerForm
          key={modal.editing?.entry.id ?? 'new'}
          writer={writer}
          servers={infos.map(infoFromLibrary)}
          editing={modal.editing ? infoFromLibrary(modal.editing) : undefined}
          onClose={() => setModal(null)}
        />
      )}
      <McpAssistDialog
        open={modal?.kind === 'assist'}
        onClose={() => setModal(null)}
        onStart={startAssist}
        title="Configure the MCP library with AI"
        description="An assistant run proposes library servers in its own window. You approve each one there."
        placeholder="Connect GitHub and a Postgres database..."
      />
    </section>
  )
}

function LibraryRow({ info, onList, onEdit }: { info: McpLibraryInfo; onList: (l: McpLibraryInfo[]) => void; onEdit: () => void }): ReactElement {
  const { entry, auth } = info
  const [menu, setMenu] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [secretsOpen, setSecretsOpen] = useState(false)
  const [usedOpen, setUsedOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<McpTestResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = useRef(0)
  const panelId = useId()
  const usedId = useId()
  const spec = useMemo(() => ({ ...entry, enabled: true }), [entry])
  const secrets = secretStatuses(infoFromLibrary(info))
  const secretsSet = secrets.filter((s) => s.set).length
  const remote = entry.transport !== 'stdio'

  const guard = async (fn: () => Promise<void>): Promise<void> => {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errMessage(e))
    }
  }
  const test = (): void => {
    const mine = ++run.current
    setTesting(true)
    setError(null)
    window.orgai.mcpLibrary
      .test({ libraryId: entry.id })
      .then((r) => mine === run.current && setResult(r))
      .catch((e) => mine === run.current && setResult({ ok: false, error: errMessage(e) }))
      .finally(() => mine === run.current && setTesting(false))
  }
  const refreshAfterAuth = (): void => {
    void window.orgai.mcpLibrary.list().then(onList).catch(() => undefined)
  }
  const target = launchTarget(spec)

  return (
    <li
      className={`mcp-row mcp-lib-row${info.missingSecrets.length > 0 ? ' warn' : ''}`}
      data-testid="mcp-library-row"
      data-server={entry.name}
      data-id={entry.id}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && menu) {
          setMenu(false)
          e.currentTarget.querySelector<HTMLElement>('.mcp-row-actions [aria-expanded]')?.focus()
        }
      }}
    >
      <div className="mcp-lib-main">
        <div className="mcp-row-id">
          <span className="mcp-name">{entry.name}</span>
          <span className="mono mcp-target" title={target}>
            {target}
          </span>
          {entry.description && <span className="muted mcp-clamp">{entry.description}</span>}
        </div>
        <div className="mcp-row-meta">
          <Badge>{transportWords(entry.transport)}</Badge>
          <SourceBadge source={entry.source} />
          <AuthChip auth={auth} />
          {secrets.length > 0 && (
            <button type="button" className="mcp-link" aria-expanded={secretsOpen} aria-controls={secretsOpen ? panelId : undefined} onClick={() => setSecretsOpen((o) => !o)}>
              <Icon icon={KeyRound} size="xs" />
              Secrets: {secretsSet} of {secrets.length} set
              <Icon icon={ChevronDown} size="xs" />
            </button>
          )}
          {info.usedBy.length > 0 ? (
            <button type="button" className="mcp-link" aria-expanded={usedOpen} aria-controls={usedOpen ? usedId : undefined} onClick={() => setUsedOpen((o) => !o)}>
              Used by {info.usedBy.length} project{info.usedBy.length === 1 ? '' : 's'}
              <Icon icon={ChevronDown} size="xs" />
            </button>
          ) : (
            <span className="muted">Not used by any project</span>
          )}
        </div>
        <div className="mcp-row-actions">
          {remote && <AuthorizeControl target={{ libraryId: entry.id }} auth={auth} serverName={entry.name} onChanged={refreshAfterAuth} />}
          {testing ? (
            <>
              <Button
                size="sm"
                onClick={() => {
                  run.current++
                  setTesting(false)
                }}
              >
                Stop waiting
              </Button>
              <span className="muted" role="status">
                Testing
              </span>
            </>
          ) : (
            <Button size="sm" testId="mcp-test" title={`Test ${entry.name}`} onClick={test}>
              Test
            </Button>
          )}
          <IconButton icon={Ellipsis} label={`More actions for ${entry.name}`} size="sm" expanded={menu} onClick={() => setMenu((m) => !m)} />
        </div>
      </div>
      {usedOpen && (
        <ul id={usedId} className="mcp-used-by" aria-label={`Projects using ${entry.name}`}>
          {info.usedBy.map((u) => (
            <li key={u.projectId}>{u.projectName}</li>
          ))}
        </ul>
      )}
      {secretsOpen && (
        <div id={panelId} className="mcp-lib-secrets">
          {secrets.map((s) => {
            const kind = (entry.secretEnv ?? []).includes(s.name) ? ('env' as const) : ('header' as const)
            return (
              <div key={`${kind}:${s.name}`} className="field mcp-field">
                <span className="mcp-label mono">{s.name}</span>
                <SecretField
                  name={s.name}
                  state={s.set ? 'set' : 'notSet'}
                  onSave={async (value) => onList(await window.orgai.mcpLibrary.setSecret({ libraryId: entry.id, kind, name: s.name, value }))}
                  onClear={async () => onList(await window.orgai.mcpLibrary.setSecret({ libraryId: entry.id, kind, name: s.name, value: null }))}
                />
              </div>
            )
          })}
        </div>
      )}
      {menu && (
        <div className="mcp-menu" role="group" aria-label={`Actions for ${entry.name}`}>
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
          {remote && auth.state !== 'notRequired' && auth.state !== 'notAuthorized' && (
            <Button
              size="sm"
              icon={ShieldOff}
              testId="mcp-library-revoke"
              onClick={() => {
                setMenu(false)
                void guard(async () => {
                  await window.orgai.mcp.revokeAuth({ libraryId: entry.id })
                  refreshAfterAuth()
                })
              }}
            >
              Remove authorization
            </Button>
          )}
          <Button
            size="sm"
            variant="danger"
            icon={Trash2}
            onClick={() => {
              setMenu(false)
              setConfirm(true)
            }}
          >
            Remove from library...
          </Button>
        </div>
      )}
      {error && (
        <p className="invalid-text mcp-row-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <TestResultPanel
          serverName={entry.name}
          result={result}
          authorize={{ target: { libraryId: entry.id }, auth, onChanged: refreshAfterAuth }}
        />
      )}
      <ConfirmDialog
        open={confirm}
        title={`Remove ${entry.name} from the library?`}
        body={
          <p>
            {info.usedBy.length > 0
              ? `${info.usedBy.map((u) => u.projectName).join(', ')} will lose this server and any role access to it.`
              : 'No project uses this server.'}{' '}
            Its stored secrets and authorization are deleted.
          </p>
        }
        confirmLabel="Remove from library"
        danger
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false)
          void guard(async () => onList(await window.orgai.mcpLibrary.remove({ libraryId: entry.id })))
        }}
      />
    </li>
  )
}
