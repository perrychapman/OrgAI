import type { ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { ExternalLink, PlugZap, ShieldCheck, Unplug } from 'lucide-react'
import type { ConnectorInfo, McpTestResult } from '@shared/types'
import { CONNECTOR_REDIRECT_URI, connectorEase, connectorVariant } from '@shared/connectors'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { CopyButton } from '../ui/CopyButton'
import { ConfirmDialog, Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { Input } from '../ui/Input'
import {
  accessLine,
  accessWords,
  clampText,
  connectLabel,
  connectMissing,
  defaultVariantId,
  dialogLead,
  dialogTitle,
  honestyNote,
  missingSentence,
  noteForUser,
  plainToolName,
  removeConsequence,
  variantExplain
} from '../../lib/connectors'
import { authFailure, connectStep, disconnectKind, httpsUrl, testFailure } from '../../lib/connectorFlow'
import { errMessage } from '../mcp/mcpHelpers'
import { ConnectorLogo } from './ConnectorLogo'
import { EaseBadge } from './ConnectorTile'
import { useConnectors } from './useConnectors'

type Phase = 'idle' | 'working' | 'waiting'

function ExtLink({ href, children }: { href: string; children: string }): ReactElement | null {
  const safe = httpsUrl(href)
  if (!safe) return null
  return (
    <a className="connector-link" href={safe} target="_blank" rel="noreferrer noopener">
      {children}
      <Icon icon={ExternalLink} size="xs" />
    </a>
  )
}

/** Connect, check, disconnect or remove one service. Plain words only; the live state comes from connectors:list. */
export default function ConnectorDialog({ info, onClose, onConnected }: { info: ConnectorInfo; onClose: () => void; onConnected?: (info: ConnectorInfo) => void }): ReactElement {
  const { connectors, refresh } = useConnectors()
  const live = connectors?.find((c) => c.connector.id === info.connector.id) ?? info
  const def = live.connector
  const entry = live.library
  const [variantId, setVariantId] = useState(() => info.variant ?? defaultVariantId(def))
  const variant = connectorVariant(def, entry ? live.variant : variantId)
  const auth = variant.auth
  const ease = connectorEase(def, variant.id)
  const [haveClient, setHaveClient] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [token, setToken] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [stuck, setStuck] = useState(false)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<McpTestResult | null>(null)
  const [confirm, setConfirm] = useState<'disconnect' | 'remove' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const libraryId = useRef<string | null>(null)
  const cancelled = useRef(false)
  const testRun = useRef(0)
  const checkBtn = useRef<HTMLButtonElement>(null)
  const waitingRef = useRef(false)
  const ids = useId()

  const connected = live.state === 'connected'
  const usedBy = entry?.usedBy ?? []
  const account = entry?.auth.account
  const note = honestyNote(def)
  const missing = connected ? [] : connectMissing(auth, { clientId, clientSecret, token })
  const sentence = missingSentence(missing)
  const busy = phase !== 'idle'
  waitingRef.current = phase === 'waiting'
  const priorError = !error && live.state === 'error' ? entry?.auth.error : undefined

  // After the sign-in lands, move focus to the first useful control of the connected view.
  const wasConnected = useRef(connected)
  useEffect(() => {
    if (connected && !wasConnected.current) checkBtn.current?.focus()
    wasConnected.current = connected
  }, [connected])
  useEffect(
    () => () => {
      testRun.current += 1
      // Closing while the browser sign-in is pending must not leave the loopback listener open.
      if (waitingRef.current && libraryId.current) void window.orgai.mcp.cancelAuthorize({ libraryId: libraryId.current }).catch(() => undefined)
    },
    []
  )

  const connect = async (): Promise<void> => {
    if (missing.length > 0 || busy) return
    setError(null)
    setStuck(false)
    setPhase('working')
    cancelled.current = false
    try {
      const lib = entry ?? (await window.orgai.connectors.add({ connectorId: def.id, variant: variantId }))
      const id = lib.entry.id
      libraryId.current = id
      let failure: string | undefined
      // The entry may already exist with its own variant: branch on that, not on what the form showed.
      const usedAuth = connectorVariant(def, lib.entry.connectorVariant).auth
      const step = connectStep(usedAuth)
      if (step === 'token') {
        try {
          await window.orgai.connectors.setToken({ connectorId: def.id, token: token.trim() })
        } catch (e) {
          failure = errMessage(e)
        }
      } else if (step === 'authorize') {
        setPhase('waiting')
        const withClient = usedAuth.kind === 'oauthClient' ? { clientId: clientId.trim(), ...(clientSecret ? { clientSecret } : {}) } : {}
        const status = await window.orgai.mcp.authorize({ libraryId: id, ...withClient })
        failure = authFailure(status, cancelled.current)
      }
      if (failure) setError(clampText(failure, 200))
      else if (!cancelled.current) {
        let fresh = (await window.orgai.connectors.list()).find((c) => c.connector.id === def.id)
        if (fresh?.state !== 'connected') fresh = (await window.orgai.connectors.list()).find((c) => c.connector.id === def.id)
        if (fresh?.state === 'connected') onConnected?.(fresh)
        else setStuck(true)
      }
    } catch (e) {
      if (!cancelled.current) setError(errMessage(e))
    } finally {
      // Secrets live in state only until the call settles.
      setClientSecret('')
      setToken('')
      setPhase('idle')
      refresh()
    }
  }

  const cancel = (): void => {
    cancelled.current = true
    if (libraryId.current) void window.orgai.mcp.cancelAuthorize({ libraryId: libraryId.current }).catch(() => undefined)
  }

  const requestClose = (): void => {
    if (phase === 'working') return
    if (phase === 'waiting') cancel()
    onClose()
  }

  const check = (): void => {
    if (!entry) return
    const mine = ++testRun.current
    setChecking(true)
    setResult(null)
    window.orgai.mcpLibrary
      .test({ libraryId: entry.entry.id })
      .then((r) => mine === testRun.current && setResult(r))
      .catch((e) => mine === testRun.current && setResult({ ok: false, error: errMessage(e) }))
      .finally(() => mine === testRun.current && setChecking(false))
  }

  const doConfirmed = async (): Promise<void> => {
    const what = confirm
    setConfirm(null)
    if (!entry || !what) return
    setActionError(null)
    try {
      if (what === 'remove') {
        await window.orgai.mcpLibrary.remove({ libraryId: entry.entry.id })
        onClose()
        return
      }
      if (disconnectKind(auth) === 'clearToken') await window.orgai.connectors.setToken({ connectorId: def.id, token: null })
      else await window.orgai.mcp.revokeAuth({ libraryId: entry.entry.id })
      setResult(null)
    } catch (e) {
      setActionError(errMessage(e))
    } finally {
      refresh()
    }
  }

  const form = !connected
  const multi = def.variants.length > 1
  const secretOptional = auth.kind === 'oauthClient' && auth.clientSecret === 'optional'
  const missingId = `${ids}-missing`
  const formId = `${ids}-form`
  const notes = connected ? [] : noteForUser(def.notes, def.name)
  /** A token service leads with the token field; the access choice and notes come after it. */
  const tokenFirst = form && auth.kind === 'token'
  const extras = (
    <>
      {multi && (
        <fieldset className="connector-variants" disabled={!!entry || busy}>
          <legend>What agents can do</legend>
          {def.variants.map((v) => (
            <label key={v.id} className={`connector-variant${v.id === variant.id ? ' on' : ''}`}>
              <input type="radio" name={`${ids}-variant`} value={v.id} checked={v.id === variant.id} onChange={() => setVariantId(v.id)} />
              <span className="connector-variant-text">
                <strong>
                  {v.label} <span className="muted">· {accessWords(v)}</span>
                </strong>
                <span className="muted">
                  {v.description ? `${v.description} ` : ''}
                  {variantExplain(v)}
                </span>
              </span>
            </label>
          ))}
          {entry && <p className="muted connector-locked">Access is set when the service is added. To switch it, remove the service and add it again.</p>}
        </fieldset>
      )}
      {!multi && (
        <p className="muted connector-access">
          <Icon icon={ShieldCheck} size="xs" /> {accessLine(def, variant)}
        </p>
      )}
      {notes.length > 0 && (
        <ul className="muted connector-notes" aria-label="Good to know">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {note && (
        <p className="muted connector-honesty" data-testid="connector-honesty">
          {note}
        </p>
      )}
    </>
  )

  return (
    <Dialog
      open
      onClose={requestClose}
      title={dialogTitle(def, ease, connected)}
      size="md"
      testId="connector-dialog"
      footer={
        <>
          {form && phase === 'waiting' && (
            <>
              <span className="muted connector-foot-status" role="status" data-testid="connector-waiting">
                Waiting for your browser…
              </span>
              <Button onClick={cancel}>Cancel</Button>
            </>
          )}
          {form && phase !== 'waiting' && (
            <>
              <Button onClick={requestClose} disabled={phase === 'working'}>
                Close
              </Button>
              <button
                type="submit"
                form={formId}
                className="btn primary"
                data-testid="connector-connect"
                disabled={missing.length > 0 || busy}
                aria-describedby={sentence ? missingId : undefined}
                aria-busy={phase === 'working' || undefined}
                aria-label={ease === 'signIn' && !error && !priorError ? `Sign in with ${def.name}` : undefined}
              >
                <Icon icon={PlugZap} size="sm" />
                {connectLabel(ease, !!(error || priorError))}
              </button>
            </>
          )}
          {!form && (
            <Button autoFocusDialog onClick={requestClose} disabled={phase === 'working'}>
              Close
            </Button>
          )}
        </>
      }
    >
      <div className="connector-dlg">
        <div className="connector-dlg-head">
          <ConnectorLogo def={def} size="lg" />
          <div className="connector-dlg-id">
            <span className="connector-dlg-vendor">by {def.vendor}</span>
            <div className="connector-badges">
              {!connected && <EaseBadge ease={ease} />}
              {def.status === 'preview' && <Badge>Preview</Badge>}
            </div>
          </div>
          <ExtLink href={def.docsUrl}>{`About ${def.name}`}</ExtLink>
        </div>
        {form && (
          <p className="connector-lead" data-testid="connector-lead">
            {dialogLead(ease)}
          </p>
        )}
        {!tokenFirst && extras}

        {form && (
          <form
            id={formId}
            className="connector-connect"
            onSubmit={(e) => {
              e.preventDefault()
              void connect()
            }}
          >
            {auth.kind === 'oauthClient' && (
              <>
                <details className="connector-setup" open={!haveClient} onToggle={(e) => setHaveClient(!e.currentTarget.open)} data-testid="connector-setup-steps">
                  <summary className="connector-step-title">Before you connect</summary>
                  <ol className="connector-steps">
                    {def.setup.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                  <div className="connector-uri">
                    <span className="muted">Redirect address to register</span>
                    <div className="connector-uri-row">
                      <code className="mono" data-testid="connector-redirect-uri">
                        {CONNECTOR_REDIRECT_URI}
                      </code>
                      <CopyButton text={CONNECTOR_REDIRECT_URI} label="Copy redirect address" />
                    </div>
                    <ExtLink href={auth.consoleUrl}>Open the developer console</ExtLink>
                  </div>
                </details>
                {!haveClient && (
                  <button
                    type="button"
                    className="link-btn connector-have"
                    data-testid="connector-have-client"
                    onClick={() => {
                      setHaveClient(true)
                      document.getElementById(`${ids}-cid`)?.focus()
                    }}
                  >
                    I already have a client ID
                  </button>
                )}
                <div className="field">
                  <label htmlFor={`${ids}-cid`}>Client ID</label>
                  <Input id={`${ids}-cid`} mono value={clientId} autoComplete="off" spellCheck={false} disabled={busy} onChange={setClientId} />
                </div>
                <div className="field">
                  <label htmlFor={`${ids}-sec`}>Client secret{secretOptional ? ' (optional)' : ''}</label>
                  <Input id={`${ids}-sec`} mono type="password" value={clientSecret} autoComplete="off" spellCheck={false} disabled={busy} onChange={setClientSecret} />
                  <span className="hint">Stored encrypted on this computer and never shown again.</span>
                </div>
              </>
            )}
            {auth.kind === 'token' && (
              <div className="field">
                <label htmlFor={`${ids}-tok`}>{auth.label}</label>
                <Input id={`${ids}-tok`} mono type="password" value={token} autoComplete="off" spellCheck={false} disabled={busy} onChange={setToken} />
                <span className="hint">{auth.help}</span>
                {auth.link && <ExtLink href={auth.link}>Create one</ExtLink>}
                <span className="hint">Stored encrypted on this computer and never shown again.</span>
              </div>
            )}

            {(error ?? priorError) && (
              <p className="invalid-text connector-error" role="alert" data-testid="connector-error">
                {clampText(error ?? priorError ?? '', 200)}
              </p>
            )}
            {error && !busy && ((auth.kind === 'token' && !token) || (auth.kind === 'oauthClient' && !secretOptional && !clientSecret)) && (
              <p className="muted" data-testid="connector-reenter">
                {auth.kind === 'token' ? 'Re-enter the token to try again.' : 'Re-enter the client secret to try again.'}
              </p>
            )}
            {stuck && !error && (
              <p className="invalid-text connector-error" role="alert" data-testid="connector-stuck">
                Connected, but we could not continue. Close this and use it from your project's Tools settings.
              </p>
            )}
            {sentence && (
              <p id={missingId} className="muted connector-missing" data-testid="connector-missing">
                {sentence}
              </p>
            )}
          </form>
        )}
        {tokenFirst && extras}

        {connected && entry && (
          <div className="connector-connected">
            <p className="connector-status" data-testid="connector-status">
              <Icon icon={ShieldCheck} size="sm" />
              <span>{account ? `Connected as ${clampText(account, 200)}` : 'Connected'}</span>
            </p>
            <p className="muted">
              {usedBy.length > 0 ? `Used by: ${usedBy.map((u) => clampText(u.projectName, 80)).join(', ')}` : "Not used by any project yet. Add it from a project's Tools settings."}
            </p>
            <div className="connector-actions">
              <button ref={checkBtn} type="button" className="btn" data-testid="connector-test" disabled={checking} aria-busy={checking || undefined} onClick={check}>
                {checking ? 'Checking…' : 'Check connection'}
              </button>
            </div>
            {result && (
              <div className="connector-result" role="status" data-testid="connector-result" data-ok={result.ok}>
                {result.ok ? (
                  <>
                    <strong>Working. Agents can use {result.tools?.length ?? 0} {result.tools?.length === 1 ? 'action' : 'actions'}.</strong>
                    {result.tools && result.tools.length > 0 && (
                      <ul className="connector-tools" data-testid="connector-tools" aria-label="What agents can do here">
                        {result.tools.slice(0, 50).map((t, i) => (
                          <li key={i} title={clampText(t, 200)}>
                            {clampText(plainToolName(t), 80)}
                          </li>
                        ))}
                        {result.tools.length > 50 && <li className="muted">and {result.tools.length - 50} more</li>}
                      </ul>
                    )}
                  </>
                ) : (
                  <>
                    <strong className="invalid-text">The service did not answer.</strong>
                    <span>{clampText(testFailure(result, auth.kind).message, 200)}</span>
                    {testFailure(result, auth.kind).hint && <span className="muted">{testFailure(result, auth.kind).hint}</span>}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {entry && (
          <section className="connector-danger" aria-label="Disconnect or remove">
            {actionError && (
              <p className="invalid-text" role="alert">
                {actionError}
              </p>
            )}
            {disconnectKind(auth) !== 'none' && (
              <div className="connector-danger-row">
                <p className="muted">{disconnectKind(auth) === 'clearToken' ? 'Disconnect clears the saved token but keeps the service here.' : 'Disconnect signs out but keeps the service here.'}</p>
                {connected && (
                  <Button icon={Unplug} testId="connector-disconnect" onClick={() => setConfirm('disconnect')}>
                    Disconnect
                  </Button>
                )}
              </div>
            )}
            <div className="connector-danger-row">
              <p className="muted">Remove deletes the service and its saved sign-in from this computer.</p>
              <Button variant="danger" testId="connector-remove" onClick={() => setConfirm('remove')}>
                Remove service
              </Button>
            </div>
          </section>
        )}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'remove' ? `Remove ${def.name}?` : `Disconnect ${def.name}?`}
        body={<p>{removeConsequence(usedBy, confirm === 'remove' ? 'remove' : 'disconnect')}</p>}
        confirmLabel={confirm === 'remove' ? 'Remove service' : 'Disconnect'}
        danger
        onCancel={() => setConfirm(null)}
        onConfirm={() => void doConfirmed()}
      />
    </Dialog>
  )
}
