import type { ReactElement } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, Ellipsis, KeyRound, Library, Pencil, Plus, Package, ShieldOff, Sparkles, Trash2 } from 'lucide-react'
import type { McpLibraryInfo, McpTestResult } from '@shared/types'
import { HARNESS_PROJECT_ID } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { focusPaneHeading } from '../../lib/settingsTarget'
import { modelDisplayName, useAssistantModel } from '../../lib/assistantModels'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { ConfirmDialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { SecretField } from '../ui/SecretField'
import { SettingsSection } from '../settings/SettingsSection'
import { AuthChip, AuthorizeControl, SourceBadge } from './McpAuth'
import McpServerForm from './McpServerForm'
import RegistryDialog from './RegistryDialog'
import TestResultPanel from './TestResultPanel'
import { errMessage, launchTarget, secretStatuses } from './mcpHelpers'
import { infoFromLibrary, transportWords } from './mcpLibraryHelpers'
import { libraryWriter } from './mcpWriter'
import { useMcpLibrary } from './useMcpLibrary'

type Modal = { kind: 'registry' } | { kind: 'form'; editing?: McpLibraryInfo } | null

/** App settings: the MCP library. Servers are defined here once and linked by projects. */
export default function McpLibrarySection(): ReactElement {
  const { library, error, refresh, setLibrary } = useMcpLibrary()
  const [modal, setModal] = useState<Modal>(null)
  const focus = useAppStore((s) => s.mcpFocus)
  const clearMcpFocus = useAppStore((s) => s.clearMcpFocus)
  const section = useRef<HTMLElement>(null)
  const assistRun = useAppStore((s) =>
    Object.values(s.runs).find(
      (r) => r.summary.projectId === HARNESS_PROJECT_ID && r.summary.kind === 'mcp-assist' && ['starting', 'running', 'idle'].includes(r.summary.status)
    )
  )
  const assistModel = modelDisplayName(useAssistantModel('mcpAssistModel'))
  const writer = useMemo(() => libraryWriter(setLibrary), [setLibrary])

  // A deep link ("Open in library") lands here: scroll to the section or the entry and move focus into it.
  useEffect(() => {
    if (focus?.kind !== 'library') return
    if (focus.libraryId && library === null) return
    const row = focus.libraryId ? section.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(focus.libraryId)}"]`) : null
    if (row) {
      row.scrollIntoView({ block: 'start' })
      row.querySelector<HTMLElement>('button')?.focus()
    } else {
      focusPaneHeading()
    }
    clearMcpFocus()
  }, [focus, library, clearMcpFocus])


  // Services from the Connectors gallery live there; this list is for servers added by hand, from the registry or by an agent.
  const infos = (library ?? []).filter((i) => !i.entry.connectorId)
  return (
    <SettingsSection
      id="appsettings-section-mcp-library"
      title="Custom servers (advanced)"
      description="For a service that is not in Connectors. Set a server up once here; any project can use it."
      testId="mcp-library-section"
      sectionRef={section}
      actions={
        <>
          <Button icon={Plus} testId="mcp-library-add-manual" onClick={() => setModal({ kind: 'form' })}>
            Add manually
          </Button>
          <Button icon={Sparkles} testId="mcp-library-assist" title={`Uses your assistant model (${assistModel}); counts toward your usage`} onClick={() => void useAppStore.getState().openAssistant('harness', { fresh: true })}>
            Configure with AI
          </Button>
          <Button variant="ghost" icon={Package} testId="mcp-library-add-registry" onClick={() => setModal({ kind: 'registry' })}>
            Browse community servers (unverified)
          </Button>
        </>
      }
    >
      <div className="mcp-body">
        <p className="muted" data-testid="mcp-library-assist-cost">
          Configure with AI uses your assistant model ({assistModel}) and counts toward your usage.
        </p>
        {assistRun && (
          <p className="muted" data-testid="mcp-library-assist-banner">
            An assistant run is configuring your library.{' '}
            <button type="button" className="link-btn" onClick={() => void useAppStore.getState().openAssistant('harness')}>
              Open the MCP assistant
            </button>
          </p>
        )}
        {error ? (
          <Banner
            tone="danger"
            title="Could not load custom servers"
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
            <strong>No custom servers</strong>
            <p className="muted">Most people never need this. Add one by hand only when a service is not in Connectors.</p>
          </div>
        ) : (
          <ul className="card-block mcp-list" aria-label="Custom servers">
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
      </div>
    </SettingsSection>
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
