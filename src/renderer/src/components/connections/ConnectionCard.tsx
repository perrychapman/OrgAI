import type { ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Bot, ChevronDown, ChevronRight, Copy, ExternalLink, Network, RefreshCw, Sparkles } from 'lucide-react'
import type { ConnectionId, ConnectionInfo, ConnectionLoginStart, OpenAIConnection, AnthropicConnection, LiteLLMConnection, ProviderConnection } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { ConfirmDialog } from '../ui/Dialog'
import { ConnectionStatusBadge } from '../ui/ConnectionStatusBadge'
import { CopyButton } from '../ui/CopyButton'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { Input } from '../ui/Input'
import { SecretField } from '../ui/SecretField'
import { SegmentedControl } from '../ui/SegmentedControl'
import { useConfirm } from '../ui/ConfirmDialog'
import { relativeTime } from '../../lib/remap'
import ModelList from './ModelList'
import TierEditor from './TierEditor'

const META: Record<ConnectionId, { name: string; icon: typeof Bot; hint: string }> = {
  anthropic: { name: 'Anthropic', icon: Sparkles, hint: 'Sign in with Claude Code to use Claude models.' },
  openai: { name: 'OpenAI', icon: Bot, hint: 'Sign in with ChatGPT to use OpenAI models.' },
  litellm: { name: 'LiteLLM proxy', icon: Network, hint: 'Enter the proxy URL and key, then test the connection.' }
}

const DISCONNECTED: Record<ConnectionId, string> = {
  anthropic: 'Signed out of OrgAI. Your Claude Code login on this machine is unchanged.',
  openai: 'Signed out. Connect again to use OpenAI models.',
  litellm: 'Disconnected. The stored API key was removed; the proxy URL is kept.'
}

const errText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))

export default function ConnectionCard({ info }: { info: ConnectionInfo }): ReactElement {
  const id = info.connection.id
  const meta = META[id]
  const setInfo = useAppStore((s) => s.setConnectionInfo)
  const loadModels = useAppStore((s) => s.loadModels)
  const models = useAppStore((s) => s.models[id])
  const modelsError = useAppStore((s) => s.modelsError[id])
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState<null | 'refresh' | 'connect'>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const state = info.status.state
  const connected = state === 'connected'

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

  const detail = useMemo(() => {
    if (state === 'connected') {
      const parts = [info.status.account, info.status.detail].filter(Boolean)
      const when = relativeTime(info.status.checkedAt)
      return [...parts, when ? `Updated ${when}` : ''].filter(Boolean).join(' · ') || 'Connected'
    }
    if (state === 'connecting') return info.status.detail ?? (id === 'litellm' ? 'Testing the proxy' : 'Waiting for the browser sign-in')
    if (state === 'error') return info.status.detail ?? 'Something went wrong.'
    const usesKey = (info.connection as AnthropicConnection | OpenAIConnection).auth?.kind === 'apiKey'
    if (usesKey && info.status.detail) return `Not connected: ${info.status.detail}`
    return info.status.detail ?? meta.hint
  }, [state, info.status, info.connection, id, meta.hint])

  return (
    <section className="card-block conn-card" data-testid="connection-card" data-provider={id} aria-label={meta.name}>
      <header className="card-sec conn-head">
        <span className="conn-mark">
          <Icon icon={meta.icon} size="lg" />
        </span>
        <div className="conn-title">
          <h3>{meta.name}</h3>
          <p className={state === 'error' ? 'conn-detail invalid-text' : 'conn-detail'} role="status" aria-live="polite" data-testid="connection-status">
            {detail}
          </p>
        </div>
        <ConnectionStatusBadge state={state} />
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
      {open && (
        <>
          {state === 'error' && (
            <div className="card-sec">
              <Banner tone="danger" title="Connection error" actions={<CopyDetails text={info.status.detail ?? ''} />}>
                {info.status.detail}
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
            {id === 'litellm' && (
              <LiteLLMAuth
                conn={info.connection as LiteLLMConnection}
                connected={connected}
                busy={busy === 'connect'}
                onConnect={connect}
                onDisconnect={disconnect}
                onRemove={() => setConfirmRemove(true)}
              />
            )}
          </div>
          {connected && (
            <>
              <div className="card-sec">
                <ModelList id={id} models={models} error={modelsError} onRetry={() => void loadModels(id, true)} tierModels={info.connection.tierModels} />
              </div>
              <div className="card-sec">
                <TierEditor info={info} models={models ?? []} onSave={save} />
              </div>
            </>
          )}
        </>
      )}
      <ConfirmDialog
        open={confirmRemove}
        title="Remove LiteLLM connection?"
        body={<p>The stored key is deleted and the proxy URL is cleared. Projects using it will need another connection.</p>}
        confirmLabel="Remove connection"
        danger
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false)
          void (async () => {
            try {
              await window.orgai.connections.logout('litellm')
              setInfo(await window.orgai.connections.update({ ...(info.connection as LiteLLMConnection), baseUrl: '', enabled: false }))
            } catch (e) {
              setError(errText(e))
            }
          })()
        }}
      />
    </section>
  )
}

function CopyDetails({ text }: { text: string }): ReactElement {
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
      {connected && <p className="muted">OrgAI stops using this connection. Your Claude Code login on this machine is not changed.</p>}
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
          {connected && <p className="muted">OrgAI stops using this connection. The environment variable is not changed.</p>}
        </>
      ) : connected ? (
        <>
          <div className="conn-actions">
            <Button onClick={() => void onDisconnect()}>Sign out of ChatGPT</Button>
          </div>
          <p className="muted">Removes the ChatGPT login OrgAI keeps for Codex.</p>
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

function LiteLLMAuth({
  conn,
  connected,
  busy,
  onConnect,
  onDisconnect,
  onRemove
}: {
  conn: LiteLLMConnection
  connected: boolean
  busy: boolean
  onConnect: (c?: ProviderConnection) => Promise<void>
  onDisconnect: () => Promise<void>
  onRemove: () => void
}): ReactElement {
  const setInfo = useAppStore((s) => s.setConnectionInfo)
  const [url, setUrl] = useState(conn.baseUrl)
  const [touched, setTouched] = useState(false)
  const valid = /^https?:\/\/\S+$/i.test(url.trim())
  const changed = url.trim() !== conn.baseUrl
  return (
    <div className="conn-auth">
      <div className="conn-fields">
        <div className="field">
          <label htmlFor="litellm-url">Base URL</label>
          <Input
            id="litellm-url"
            mono
            placeholder="http://localhost:4000"
            value={url}
            invalid={touched && !valid}
            aria-describedby={touched && !valid ? 'litellm-url-error' : undefined}
            onBlur={() => setTouched(true)}
            onChange={setUrl}
          />
          {touched && !valid && <span className="field-error" id="litellm-url-error">Enter a full URL starting with http:// or https://</span>}
        </div>
        <div className="field">
          <label>API key</label>
          <SecretField
            name="LITELLM_API_KEY"
            state={conn.hasApiKey ? 'set' : 'notSet'}
            onSave={async (v) => setInfo(await window.orgai.connections.setSecret({ id: 'litellm', apiKey: v }))}
            onClear={async () => setInfo(await window.orgai.connections.setSecret({ id: 'litellm', apiKey: null }))}
          />
        </div>
      </div>
      <p className="muted">The key is stored encrypted on this machine. It is never written to your project or shown again.</p>
      {connected && changed && <p className="muted">Changed. Test and connect to apply.</p>}
      {connected && <p className="muted">Disconnecting deletes the stored API key. The proxy URL stays.</p>}
      <div className="conn-actions">
        <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void onConnect({ ...conn, baseUrl: url.trim() })}>
          Test and connect
        </Button>
        {connected && <Button onClick={() => void onDisconnect()}>Disconnect and remove key</Button>}
        {(conn.baseUrl || conn.hasApiKey) && (
          <Button variant="ghost" onClick={onRemove}>
            Remove connection
          </Button>
        )}
      </div>
    </div>
  )
}
