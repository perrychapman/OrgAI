import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ChevronDown, ChevronRight, Copy, ExternalLink, RefreshCw, Sparkles } from 'lucide-react'
import type { ConnectionId, ConnectionInfo, ConnectionLoginStart, OpenAIConnection, AnthropicConnection, ProviderConnection } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { BrandMark } from '../brand/BrandMark'
import { brandMark } from '../brand/brandMarks'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { ConnectionStatusBadge } from '../ui/ConnectionStatusBadge'
import { CopyButton } from '../ui/CopyButton'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { Input } from '../ui/Input'
import { SegmentedControl } from '../ui/SegmentedControl'
import { useConfirm } from '../ui/ConfirmDialog'
import { relativeTime } from '../../lib/remap'
import ModelList from './ModelList'
import { appSecretReason } from '@shared/view/secretNotices'
import TierEditor from './TierEditor'
import { useConnectionsAnnounce } from './announce'
import { defaultChangeAnnouncement, defaultMode } from '../../lib/connectionLabel'

const META: Record<string, { name: string; icon: typeof Bot; hint: string }> = {
  anthropic: { name: 'Anthropic', icon: Sparkles, hint: 'Sign in with Claude Code to use Claude models.' },
  openai: { name: 'OpenAI', icon: Bot, hint: 'Sign in with ChatGPT to use OpenAI models.' }
}

const DISCONNECTED: Record<string, string> = {
  anthropic: 'Signed out of OrgAI. Your Claude Code login on this machine is unchanged.',
  openai: 'Signed out. Connect again to use OpenAI models.'
}

const statusWord = (state: ConnectionInfo['status']['state']): string =>
  state === 'connected' ? 'connected' : state === 'connecting' ? 'connecting' : state === 'error' ? 'connection error' : 'not connected'

const errText = (e: unknown): string => appSecretReason(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))

export default function ConnectionCard({ info }: { info: ConnectionInfo }): ReactElement {
  const id = info.connection.id
  const meta = META[id]
  const setInfo = useAppStore((s) => s.setConnectionInfo)
  const loadModels = useAppStore((s) => s.loadModels)
  const models = useAppStore((s) => s.models[id])
  const modelsError = useAppStore((s) => s.modelsError[id])
  // Collapsed by default, connected or not: a provider the user did not ask about stays one line with a Connect
  // button. Opens by itself only when something is wrong or a sign-in is pending.
  const [open, setOpen] = useState(info.status.state === 'error' || info.status.state === 'connecting')
  const card = useRef<HTMLElement>(null)
  const focusOnOpen = useRef(false)
  const [busy, setBusy] = useState<null | 'refresh' | 'connect'>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const announce = useConnectionsAnnounce()
  const [defaultError, setDefaultError] = useState<string | null>(null)
  const state = info.status.state
  const connected = state === 'connected'
  const isDefault = info.isDefault
  const chosen = useAppStore((s) => s.defaultConnectionChosen)
  const storedDefault = useAppStore((s) => s.defaultConnectionStored)
  const defaultChanges = useAppStore((s) => s.defaultConnectionChanges)
  const mode = defaultMode(id, chosen, storedDefault)
  const loadDefault = useAppStore((s) => s.loadDefaultConnection)
  const errorId = `conn-default-error-${id}`
  useEffect(() => {
    void loadDefault()
  }, [loadDefault])
  // Any card's successful default change makes an earlier refusal here stale (UI review L4).
  useEffect(() => {
    setDefaultError(null)
  }, [defaultChanges])
  const changeDefault = async (next: ConnectionId | null): Promise<void> => {
    setDefaultError(null)
    try {
      await useAppStore.getState().setDefaultConnection(next)
      announce(defaultChangeAnnouncement(next, useAppStore.getState().defaultConnection))
      requestAnimationFrame(() => card.current?.querySelector<HTMLElement>('.conn-title h4')?.focus())
    } catch (e) {
      // The refusal ("<Name> is not connected. ...") stays in the card as plain text and is announced by the pane.
      const msg = errText(e)
      setDefaultError(msg)
      announce(msg)
    }
  }
  // Status changes after the first render are read out through the pane's one live region.
  const lastState = useRef(state)
  useEffect(() => {
    if (lastState.current === state) return
    lastState.current = state
    announce(`${meta.name}: ${statusWord(state)}`)
  }, [state, announce, meta.name])

  useEffect(() => {
    if (state === 'error' || state === 'connecting') setOpen(true)
  }, [state])

  // After the header's Connect button opened the card, move focus to its first control.
  useEffect(() => {
    if (!open || !focusOnOpen.current) return
    focusOnOpen.current = false
    card.current?.querySelector<HTMLElement>('.conn-auth input, .conn-auth button')?.focus()
  }, [open])

  useEffect(() => {
    if (connected && !models) void loadModels(id)
  }, [connected, models, id, loadModels])

  const save = async (connection: ProviderConnection): Promise<ConnectionInfo> => {
    const next = await window.orgai.connections.update(connection)
    setInfo(next)
    return next
  }

  /** Save a changed auth mode, then re-run the status probe so the card never shows the previous mode's state. */
  const saveAndProbe = async (connection: ProviderConnection): Promise<ConnectionInfo> => {
    setNotice(null)
    const next = await save(connection)
    try {
      const status = await window.orgai.connections.test(id)
      const probed = { ...next, status }
      setInfo(probed)
      if (status.state === 'connected') void loadModels(id, true)
      return probed
    } catch {
      return next
    }
  }

  const refresh = async (): Promise<void> => {
    setBusy('refresh')
    setError(null)
    try {
      const status = await window.orgai.connections.test(id)
      setInfo({ ...info, status })
      if (status.state === 'connected') await loadModels(id, true)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(null)
    }
  }

  const connect = async (connection?: ProviderConnection): Promise<void> => {
    setBusy('connect')
    setError(null)
    try {
      if (connection) await save(connection)
      setInfo(await window.orgai.connections.connect(id))
      void loadModels(id, true)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async (): Promise<void> => {
    setError(null)
    setNotice(null)
    try {
      if (id === 'anthropic') setInfo(await window.orgai.connections.update({ ...(info.connection as AnthropicConnection), enabled: false }))
      else setInfo(await window.orgai.connections.logout(id))
      setNotice(DISCONNECTED[id])
    } catch (e) {
      setError(errText(e))
    }
  }

  // The store's reasons for a key that cannot be read name no terminal command (the Dashboard notice has the buttons).
  const statusDetail = info.status.detail ? appSecretReason(info.status.detail) : undefined
  const detail = useMemo(() => {
    if (state === 'connected') {
      // One-line summary: auth kind, model count, freshness.
      const conn = info.connection as AnthropicConnection | OpenAIConnection
      const auth = (conn as AnthropicConnection).auth.kind === 'apiKey' ? 'API key' : id === 'anthropic' ? 'Claude Code login' : 'ChatGPT sign-in'
      const when = relativeTime(info.status.checkedAt)
      return [info.status.account, auth, models ? `${models.length} models` : '', when ? `updated ${when}` : ''].filter(Boolean).join(' · ')
    }
    if (state === 'connecting') return statusDetail ?? 'Waiting for the browser sign-in'
    if (state === 'error') return statusDetail ?? 'Something went wrong.'
    const usesKey = (info.connection as AnthropicConnection | OpenAIConnection).auth?.kind === 'apiKey'
    if (usesKey && statusDetail) return `Not connected: ${statusDetail}`
    return statusDetail ?? meta.hint
  }, [state, info.status, statusDetail, info.connection, id, meta.hint, models])

  return (
    <section ref={card} className="card-block conn-card" data-testid="connection-card" data-provider={id} aria-label={meta.name}>
      <header className="card-sec conn-head">
        <span className="conn-mark">
          {brandMark(id) ? <BrandMark id={id} /> : <Icon icon={meta.icon} size="lg" />}
        </span>
        <div className="conn-title">
          <h4 tabIndex={-1}>{meta.name}</h4>
          <p className={state === 'error' ? 'conn-detail invalid-text' : 'conn-detail'} data-testid="connection-status">
            {detail}
          </p>
        </div>
        <ConnectionStatusBadge state={state} />
        {!connected && !open && (
          <Button
            size="sm"
            variant="primary"
            ariaLabel={`Connect ${meta.name}`}
            onClick={() => {
              focusOnOpen.current = true
              setOpen(true)
            }}
          >
            Connect
          </Button>
        )}
        <IconButton
          icon={RefreshCw}
          label={`Refresh ${meta.name} status and models`}
          size="sm"
          spin={busy === 'refresh'}
          disabled={busy !== null}
          onClick={() => void refresh()}
          testId="connection-refresh"
        />
        <IconButton icon={open ? ChevronDown : ChevronRight} label={open ? `Collapse ${meta.name}` : `Expand ${meta.name}`} size="sm" expanded={open} onClick={() => setOpen((v) => !v)} />
      </header>
      {(isDefault || connected) && (
        <div className="card-sec conn-default">
          {isDefault ? (
            <>
              <Badge tone="accent" testId="default-connection-badge">
                Default for new projects and assistants
              </Badge>
              {mode && (
                <span className="conn-default-mode" data-testid="default-connection-mode">
                  {mode === 'chosen' ? 'Chosen' : 'Automatic'}
                </span>
              )}
              {mode === 'chosen' && (
                <button
                  type="button"
                  className="btn sm"
                  data-testid="connection-default-auto"
                  aria-describedby={defaultError ? errorId : undefined}
                  onClick={() => void changeDefault(null)}
                >
                  Back to automatic
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              className="btn sm"
              data-testid="connection-make-default"
              aria-label={`Use for new projects: ${meta.name}`}
              aria-describedby={defaultError ? errorId : undefined}
              onClick={() => void changeDefault(id)}
            >
              Use for new projects
            </button>
          )}
          {defaultError && (
            <p className="conn-default-error invalid-text" id={errorId} data-testid="connection-default-error">
              {defaultError}
            </p>
          )}
        </div>
      )}
      {open && (
        <>
          {state === 'error' && (
            <div className="card-sec">
              <Banner tone="danger" title="Connection error" actions={<CopyDetails text={statusDetail ?? ''} />}>
                {statusDetail}
              </Banner>
            </div>
          )}
          {notice && !error && (
            <div className="card-sec">
              <Banner tone="success" onDismiss={() => setNotice(null)}>
                {notice}
              </Banner>
            </div>
          )}
          {error && (
            <div className="card-sec">
              <Banner tone="danger" onDismiss={() => setError(null)}>
                {error}
              </Banner>
            </div>
          )}
          <div className="card-sec">
            {id === 'anthropic' && <AnthropicAuth conn={info.connection as AnthropicConnection} connected={connected} busy={busy === 'connect'} onSave={save} onSaveProbe={saveAndProbe} onConnect={connect} onDisconnect={disconnect} />}
            {id === 'openai' && <OpenAIAuth conn={info.connection as OpenAIConnection} state={state} connected={connected} busy={busy === 'connect'} onSave={save} onSaveProbe={saveAndProbe} onConnect={connect} onDisconnect={disconnect} />}
          </div>
          {connected && (
            <>
              <div className="card-sec">
                {(info.modelsRefreshedAt || info.modelsError) && (
                  <p className={`field-msg${info.modelsError ? ' warn' : ''}`} data-testid="models-refreshed">
                    {info.modelsRefreshedAt ? `Models updated ${relativeTime(info.modelsRefreshedAt)}` : ''}
                    {info.modelsRefreshedAt && info.modelsError ? '. ' : ''}
                    {info.modelsError ? `Last refresh failed: ${info.modelsError}` : ''}
                  </p>
                )}
                <ModelList id={id} models={models} error={modelsError} onRetry={() => void loadModels(id, true)} tierModels={info.connection.tierModels} />
              </div>
              <div className="card-sec">
                <TierEditor info={info} models={models ?? []} onSave={save} />
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}

/** Long caveat behind a native "Learn more" disclosure (same look as SettingRow's). */
function More({ children }: { children: string }): ReactElement {
  return (
    <details className="setting-row-more">
      <summary>Learn more</summary>
      <div className="setting-row-more-body">{children}</div>
    </details>
  )
}

export function CopyDetails({ text }: { text: string }): ReactElement {
  return (
    <Button size="sm" variant="ghost" icon={Copy} onClick={() => void navigator.clipboard?.writeText(text)}>
      Copy details
    </Button>
  )
}

function AnthropicAuth({
  conn,
  connected,
  busy,
  onSave,
  onSaveProbe,
  onConnect,
  onDisconnect
}: {
  conn: AnthropicConnection
  connected: boolean
  busy: boolean
  onSave: (c: ProviderConnection) => Promise<ConnectionInfo>
  onSaveProbe: (c: ProviderConnection) => Promise<ConnectionInfo>
  onConnect: () => Promise<void>
  onDisconnect: () => Promise<void>
}): ReactElement {
  const [envVar, setEnvVar] = useState(conn.auth.kind === 'apiKey' ? conn.auth.envVar : 'ANTHROPIC_API_KEY')
  const isKey = conn.auth.kind === 'apiKey'
  const { confirm, dialog } = useConfirm()
  const switchAuth = async (kind: string): Promise<void> => {
    // Leaving a working login for a key that may be missing: ask once.
    if (kind === 'apiKey' && connected) {
      const ok = await confirm({ title: 'Switch to API key?', body: 'OrgAI signs out of the Claude login.', confirmLabel: 'Switch to API key' })
      if (!ok) return
    }
    await onSaveProbe({ ...conn, auth: kind === 'apiKey' ? { kind: 'apiKey', envVar: envVar || 'ANTHROPIC_API_KEY' } : { kind: 'subscription' } })
  }
  return (
    <div className="conn-auth">
      {dialog}
      <div className="field">
        <label>Authentication</label>
        <SegmentedControl
          label="Authentication"
          value={isKey ? 'apiKey' : 'subscription'}
          options={[
            { value: 'subscription', label: 'Claude Code login' },
            { value: 'apiKey', label: 'API key from environment variable' }
          ]}
          onChange={(kind) => void switchAuth(kind)}
        />
      </div>
      {isKey && (
        <div className="field">
          <label htmlFor="anthropic-env">Environment variable</label>
          <Input
            id="anthropic-env"
            mono
            value={envVar}
            onChange={(raw) => {
              const v = raw.replace(/[^A-Za-z0-9_]/g, '')
              setEnvVar(v)
              if (v) void onSave({ ...conn, auth: { kind: 'apiKey', envVar: v } })
            }}
            onBlur={() => {
              if (envVar) void onSaveProbe({ ...conn, auth: { kind: 'apiKey', envVar } })
            }}
          />
          <span className="hint">OrgAI never stores the key. It reads it from this variable when a run starts.</span>
        </div>
      )}
      <div className="conn-actions">
        {connected ? (
          <Button onClick={() => void onDisconnect()}>Sign out of OrgAI</Button>
        ) : (
          <Button variant="primary" loading={busy} onClick={() => void onConnect()}>
            Connect
          </Button>
        )}
      </div>
      {connected && <More>OrgAI stops using this connection. Your Claude Code login on this machine is not changed.</More>}
    </div>
  )
}

function OpenAIAuth({
  conn,
  state,
  connected,
  busy,
  onSave,
  onSaveProbe,
  onConnect,
  onDisconnect
}: {
  conn: OpenAIConnection
  state: ConnectionInfo['status']['state']
  connected: boolean
  busy: boolean
  onSave: (c: ProviderConnection) => Promise<ConnectionInfo>
  onSaveProbe: (c: ProviderConnection) => Promise<ConnectionInfo>
  onConnect: () => Promise<void>
  onDisconnect: () => Promise<void>
}): ReactElement {
  const login = useAppStore((s) => s.login)
  const loadConnections = useAppStore((s) => s.loadConnections)
  const loadModels = useAppStore((s) => s.loadModels)
  const [method, setMethod] = useState<'browser' | 'deviceCode'>('browser')
  const [start, setStart] = useState<ConnectionLoginStart | null>(null)
  const [signing, setSigning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [envVar, setEnvVar] = useState(conn.auth.kind === 'apiKey' ? conn.auth.envVar : 'OPENAI_API_KEY')
  const isKey = conn.auth.kind === 'apiKey'
  const mine = login && start && login.loginId === start.loginId ? login : null

  useEffect(() => {
    if (!mine) return
    if (mine.state === 'success') {
      setStart(null)
      setSigning(false)
      void loadConnections().then(() => loadModels('openai', true))
    } else if (mine.state === 'error' || mine.state === 'cancelled') {
      setSigning(false)
      setStart(null)
      setError(mine.state === 'cancelled' ? 'Sign-in was cancelled' : (mine.detail ?? 'Sign-in failed'))
    }
  }, [mine, loadConnections, loadModels])

  const signIn = async (): Promise<void> => {
    setError(null)
    setSigning(true)
    try {
      const res = await window.orgai.connections.login('openai', method)
      setStart(res)
    } catch (e) {
      setSigning(false)
      setError(errText(e))
    }
  }
  const cancel = async (): Promise<void> => {
    if (start) await window.orgai.connections.cancelLogin(start.loginId).catch(() => undefined)
    setStart(null)
    setSigning(false)
  }

  return (
    <div className="conn-auth">
      <div className="field">
        <label>Authentication</label>
        <SegmentedControl
          label="Authentication"
          value={isKey ? 'apiKey' : 'chatgpt'}
          options={[
            { value: 'chatgpt', label: 'Sign in with ChatGPT' },
            { value: 'apiKey', label: 'API key from environment variable' }
          ]}
          onChange={(kind) => void onSaveProbe({ ...conn, auth: kind === 'apiKey' ? { kind: 'apiKey', envVar: envVar || 'OPENAI_API_KEY' } : { kind: 'chatgpt' } })}
        />
      </div>
      {!isKey && <p className="muted">Uses your ChatGPT plan through Codex. No API key needed.</p>}
      {isKey ? (
        <>
          <div className="field">
            <label htmlFor="openai-env">Environment variable</label>
            <Input
              id="openai-env"
              mono
              value={envVar}
              onChange={(raw) => {
                const v = raw.replace(/[^A-Za-z0-9_]/g, '')
                setEnvVar(v)
                if (v) void onSave({ ...conn, auth: { kind: 'apiKey', envVar: v } })
              }}
              onBlur={() => {
                if (envVar) void onSaveProbe({ ...conn, auth: { kind: 'apiKey', envVar } })
              }}
            />
            <span className="hint">OrgAI never stores the key. It reads it from this variable when a run starts.</span>
          </div>
          <div className="conn-actions">
            {connected ? <Button onClick={() => void onDisconnect()}>Sign out of OrgAI</Button> : <Button variant="primary" loading={busy} onClick={() => void onConnect()}>Connect</Button>}
          </div>
          {connected && <More>OrgAI stops using this connection. The environment variable is not changed.</More>}
        </>
      ) : connected ? (
        <>
          <div className="conn-actions">
            <Button onClick={() => void onDisconnect()}>Sign out of ChatGPT</Button>
          </div>
          <More>Removes the ChatGPT login OrgAI keeps for Codex.</More>
        </>
      ) : (
        <>
          <SegmentedControl
            label="Sign-in method"
            value={method}
            options={[
              { value: 'browser', label: 'Browser' },
              { value: 'deviceCode', label: 'Device code' }
            ]}
            onChange={(m) => {
              if (!signing) setMethod(m)
            }}
          />
          {start?.method === 'deviceCode' ? (
            <div className="device-code" data-testid="device-code">
              <div className="device-row">
                <span className="muted">Go to</span>
                <span className="mono code-chip">{start.verificationUrl}</span>
                <CopyButton text={start.verificationUrl} label="Copy URL" />
                <IconButton icon={ExternalLink} label="Open in browser" size="sm" onClick={() => window.open(start.verificationUrl, '_blank', 'noopener')} />
              </div>
              <div className="device-row">
                <span className="muted">Enter</span>
                <span className="user-code" aria-label={`User code ${start.userCode.split('').join(' ')}`}>
                  {start.userCode}
                </span>
                <CopyButton text={start.userCode} label="Copy code" />
              </div>
              <div className="device-row">
                <span className="muted">Waiting for approval…</span>
                <Button size="sm" onClick={() => void cancel()}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="conn-actions">
              <Button variant="primary" loading={signing || state === 'connecting'} onClick={() => void signIn()}>
                {method === 'browser' ? 'Sign in with ChatGPT' : 'Get a code'}
              </Button>
              {signing && (
                <Button onClick={() => void cancel()}>Cancel</Button>
              )}
            </div>
          )}
          {signing && method === 'browser' && <p className="muted">Finish signing in in your browser. This page updates when you are done.</p>}
          {error && (
            <Banner tone="danger" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          )}
        </>
      )}
    </div>
  )
}
