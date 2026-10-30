import type { ReactElement } from 'react'
import { useId, useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { McpServerInfo, McpServerSpec, McpTransport } from '@shared/types'
import { isValidMcpServerName, newId } from '@shared/defaults'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Dialog } from '../ui/Dialog'
import { IconButton } from '../ui/IconButton'
import { Input } from '../ui/Input'
import { SecretField } from '../ui/SecretField'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Textarea } from '../ui/Textarea'
import { RoleChecklist } from './RoleAccess'
import type { McpWriter } from './mcpWriter'
import { SECURITY_SECRETS, allRoleSlugs, errMessage, securityPhrase } from './mcpHelpers'

interface VarRow {
  rid: string
  name: string
  value: string
  secret: boolean
}

const TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse']
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/

function rowsFrom(plain: Record<string, string> | undefined, secrets: string[] | undefined): VarRow[] {
  return [
    ...Object.entries(plain ?? {}).map(([name, value]) => ({ rid: newId('r'), name, value, secret: false })),
    ...(secrets ?? []).map((name) => ({ rid: newId('r'), name, value: '', secret: true }))
  ]
}

/**
 * Add manually / Edit / Duplicate form in a Dialog. `editing` is the saved server being edited; `seed` prefills a new
 * server (Duplicate). Secret values typed for slots not yet saved are held here and sent with mcp.setSecret after the
 * upsert succeeds; slots already saved write straight through.
 */
export default function McpServerForm({
  writer,
  servers,
  editing,
  seed,
  onClose
}: {
  writer: McpWriter
  servers: McpServerInfo[]
  editing?: McpServerInfo
  seed?: McpServerSpec
  onClose: () => void
}): ReactElement {
  const library = writer.roles === null
  const base = editing?.spec ?? seed
  const baseId = useId()
  const [id] = useState(() => editing?.spec.id ?? newId('mcp'))
  const [name, setName] = useState(seed ? `${seed.name}-copy` : (editing?.spec.name ?? ''))
  const [transport, setTransport] = useState<McpTransport>(base?.transport ?? 'stdio')
  const [command, setCommand] = useState(base?.command ?? '')
  const [argsText, setArgsText] = useState((base?.args ?? []).join('\n'))
  const [url, setUrl] = useState(base?.url ?? '')
  const [env, setEnv] = useState<VarRow[]>(() => rowsFrom(base?.env, base?.secretEnv))
  const [headers, setHeaders] = useState<VarRow[]>(() => rowsFrom(base?.headers, base?.secretHeaders))
  const [roles, setRoles] = useState<string[]>(base?.roles ?? allRoleSlugs(writer.roles ?? []))
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [pending, setPending] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const live = editing ? servers.find((s) => s.spec.id === editing.spec.id) : undefined
  const touch = (k: string): void => setTouched((t) => ({ ...t, [k]: true }))

  const otherNames = useMemo(() => servers.filter((s) => s.spec.id !== id).map((s) => s.spec.name), [servers, id])
  const errors = useMemo(() => {
    const e: Record<string, string> = {}
    if (!name) e.name = 'Enter a name.'
    else if (!isValidMcpServerName(name)) e.name = 'Use lowercase letters, numbers and single hyphens, up to 48 characters.'
    else if (otherNames.includes(name)) e.name = 'Another server already uses this name.'
    if (transport === 'stdio') {
      if (!command.trim()) e.command = 'Enter the command to run.'
    } else if (!url.trim()) e.url = 'Enter the server URL.'
    else {
      try {
        const u = new URL(url.trim())
        if (u.protocol !== 'http:' && u.protocol !== 'https:') e.url = 'Use an http:// or https:// URL.'
      } catch {
        e.url = 'Enter a valid URL.'
      }
    }
    const check = (rows: VarRow[], key: string, pattern: RegExp): void => {
      const seen = new Set<string>()
      rows.forEach((r) => {
        if (!r.name) e[`${key}:${r.rid}`] = 'Enter a name.'
        else if (!pattern.test(r.name)) e[`${key}:${r.rid}`] = 'Contains characters that are not allowed.'
        else if (seen.has(r.name)) e[`${key}:${r.rid}`] = 'Duplicate name.'
        seen.add(r.name)
      })
    }
    if (transport === 'stdio') check(env, 'env', ENV_NAME)
    else check(headers, 'hdr', HEADER_NAME)
    return e
  }, [name, otherNames, transport, command, url, env, headers])

  const rows = transport === 'stdio' ? env : headers
  const setRows = transport === 'stdio' ? setEnv : setHeaders
  const kind = transport === 'stdio' ? 'env' : 'header'
  const prefix = transport === 'stdio' ? 'env' : 'hdr'

  const buildSpec = (): McpServerSpec => {
    const plain: Record<string, string> = {}
    const secret: string[] = []
    for (const r of rows) {
      if (r.secret) secret.push(r.name)
      else plain[r.name] = r.value
    }
    const spec: McpServerSpec = {
      id,
      name,
      transport,
      enabled: editing?.spec.enabled ?? true,
      ...(library ? {} : { roles }),
      source: editing?.spec.source ?? 'user',
      addedAt: editing?.spec.addedAt ?? new Date().toISOString(),
      ...(editing?.spec.registry ? { registry: editing.spec.registry } : {}),
      ...(editing?.spec.description ? { description: editing.spec.description } : {})
    }
    if (transport === 'stdio') {
      spec.command = command.trim()
      spec.args = argsText
        .split('\n')
        .map((l) => l.replace(/\r$/, ''))
        .filter((l) => l.trim() !== '')
      if (Object.keys(plain).length) spec.env = plain
      if (secret.length) spec.secretEnv = secret
    } else {
      spec.url = url.trim()
      if (Object.keys(plain).length) spec.headers = plain
      if (secret.length) spec.secretHeaders = secret
    }
    return spec
  }

  const submit = async (): Promise<void> => {
    setTouched({ name: true, command: true, url: true, ...Object.fromEntries(Object.keys(errors).map((k) => [k, true])) })
    if (Object.keys(errors).length > 0) return
    setBusy(true)
    setError(null)
    try {
      const spec = buildSpec()
      await writer.upsert(spec)
      const slots = [...(spec.secretEnv ?? []).map((n) => ({ kind: 'env' as const, n })), ...(spec.secretHeaders ?? []).map((n) => ({ kind: 'header' as const, n }))]
      const failed: string[] = []
      for (const slot of slots) {
        const value = pending[`${slot.kind}:${slot.n}`]
        if (value === undefined) continue
        try {
          await writer.setSecret(id, slot.kind, slot.n, value)
        } catch (e) {
          failed.push(`${slot.n}: ${errMessage(e)}`)
        }
      }
      if (failed.length > 0) {
        setError(`The server was saved, but some secrets were not: ${failed.join('; ')}`)
        setBusy(false)
        return
      }
      setPending({})
      onClose()
    } catch (e) {
      setError(errMessage(e))
      setBusy(false)
    }
  }

  const secretState = (r: VarRow): 'set' | 'notSet' => {
    const saved = live ? (kind === 'env' ? live.envSet : live.headersSet).includes(r.name) && (kind === 'env' ? live.spec.secretEnv : live.spec.secretHeaders)?.includes(r.name) : false
    return saved || pending[`${kind}:${r.name}`] !== undefined ? 'set' : 'notSet'
  }
  const isSaved = (r: VarRow): boolean => !!live && ((kind === 'env' ? live.spec.secretEnv : live.spec.secretHeaders) ?? []).includes(r.name)

  const patchRow = (rid: string, patch: Partial<VarRow>): void => setRows((rs) => rs.map((r) => (r.rid === rid ? { ...r, ...patch } : r)))

  const title = editing ? `Edit ${editing.spec.name}` : seed ? 'Duplicate MCP server' : library ? 'Add MCP server to the library' : 'Add MCP server manually'

  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onClose}
      title={title}
      description={securityPhrase(transport)}
      size="lg"
      testId="mcp-form"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {editing ? 'Save changes' : 'Add server'}
          </Button>
        </>
      }
    >
      {error && (
        <Banner tone="danger" title="Could not save the server">
          {error}
        </Banner>
      )}
      <div className="field mcp-field">
        <label htmlFor={`${baseId}-name`}>Name</label>
        <Input
          id={`${baseId}-name`}
          mono
          invalid={touched.name && !!errors.name}
          value={name}
          autoComplete="off"
          spellCheck={false}
          data-autofocus
          aria-describedby={`${baseId}-name-h`}
          onChange={setName}
          onBlur={() => touch('name')}
        />
        <span id={`${baseId}-name-h`} className={`hint${touched.name && errors.name ? ' invalid-text' : ''}`}>
          {touched.name && errors.name ? errors.name : 'Tools appear to agents as mcp__name__tool.'}
        </span>
      </div>

      <div className="field mcp-field">
        <span className="mcp-label">Transport</span>
        <SegmentedControl label="Transport" value={transport} options={TRANSPORTS.map((t) => ({ value: t, label: t }))} onChange={setTransport} />
        <span className="hint">stdio runs a program on this machine. http and sse connect to a remote server (sse is the legacy kind).</span>
      </div>

      {transport === 'stdio' ? (
        <>
          <div className="field mcp-field">
            <label htmlFor={`${baseId}-cmd`}>Command</label>
            <Input
              id={`${baseId}-cmd`}
              mono
              invalid={touched.command && !!errors.command}
              value={command}
              placeholder="npx"
              autoComplete="off"
              spellCheck={false}
              onChange={setCommand}
              onBlur={() => touch('command')}
            />
            {touched.command && errors.command && <span className="hint invalid-text">{errors.command}</span>}
          </div>
          <div className="field mcp-field">
            <label htmlFor={`${baseId}-args`}>Arguments</label>
            <Textarea
              id={`${baseId}-args`}
              mono
              value={argsText}
              rows={4}
              spellCheck={false}
              placeholder={'-y\n@scope/server@1.2.3'}
              onChange={setArgsText}
            />
            <span className="hint">One argument per line.</span>
          </div>
        </>
      ) : (
        <div className="field mcp-field">
          <label htmlFor={`${baseId}-url`}>URL</label>
          <Input
            id={`${baseId}-url`}
            mono
            invalid={touched.url && !!errors.url}
            value={url}
            placeholder="https://example.com/mcp"
            autoComplete="off"
            spellCheck={false}
            onChange={setUrl}
            onBlur={() => touch('url')}
          />
          {touched.url && errors.url && <span className="hint invalid-text">{errors.url}</span>}
        </div>
      )}

      <fieldset className="mcp-vars">
        <legend>{transport === 'stdio' ? 'Environment variables' : 'Headers'}</legend>
        {transport !== 'stdio' && (
          <p className="muted" data-testid="mcp-header-guidance">
            Servers that sign you in with OAuth are authorized from their row after you save, so no header is needed. To use a static token
            instead, add a secret header named <span className="mono">Authorization</span> with the value <span className="mono">Bearer your-token</span>.
          </p>
        )}
        {rows.length === 0 && <p className="muted">{transport === 'stdio' ? 'No environment variables.' : 'No headers.'}</p>}
        {rows.map((r, i) => {
          const errKey = `${prefix}:${r.rid}`
          const label = transport === 'stdio' ? 'variable' : 'header'
          return (
            <div key={r.rid} className="mcp-var-row">
              <Input
                mono
                invalid={touched[errKey] && !!errors[errKey]}
                value={r.name}
                placeholder="NAME"
                aria-label={`Name of ${label} ${i + 1}`}
                autoComplete="off"
                spellCheck={false}
                onChange={(value) => patchRow(r.rid, { name: value })}
                onBlur={() => touch(errKey)}
              />
              <div className="mcp-var-value">
                {r.secret ? (
                  <SecretField
                    name={r.name || `${label} ${i + 1}`}
                    state={secretState(r)}
                    disabled={!r.name}
                    onSave={async (value) => {
                      if (isSaved(r)) {
                        await writer.setSecret(id, kind, r.name, value)
                      } else setPending((p) => ({ ...p, [`${kind}:${r.name}`]: value }))
                    }}
                    onClear={async () => {
                      if (isSaved(r)) {
                        await writer.setSecret(id, kind, r.name, null)
                      }
                      setPending((p) => {
                        const next = { ...p }
                        delete next[`${kind}:${r.name}`]
                        return next
                      })
                    }}
                  />
                ) : (
                  <Input
                    mono
                    value={r.value}
                    aria-label={`Value of ${r.name || `${label} ${i + 1}`}`}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(value) => patchRow(r.rid, { value })}
                  />
                )}
              </div>
              <Checkbox label="Secret" checked={r.secret} disabled={isSaved(r)} onChange={(secret) => {
                // Keep what the user typed: moving a value into the secret slot must not drop it silently.
                if (secret && r.value && r.name) setPending((p) => ({ ...p, [`${kind}:${r.name}`]: r.value }))
                patchRow(r.rid, { secret, value: '' })
              }} />
              <IconButton icon={Trash2} label={`Remove ${label} ${r.name || i + 1}`} size="sm" onClick={() => setRows((rs) => rs.filter((x) => x.rid !== r.rid))} />
              {touched[errKey] && errors[errKey] && <span className="hint invalid-text mcp-var-err">{errors[errKey]}</span>}
            </div>
          )
        })}
        <div>
          <Button size="sm" icon={Plus} onClick={() => setRows((rs) => [...rs, { rid: newId('r'), name: '', value: '', secret: false }])}>
            {transport === 'stdio' ? 'Add variable' : 'Add header'}
          </Button>
        </div>
        <p className="muted">{SECURITY_SECRETS}</p>
      </fieldset>

      {writer.roles && (
        <fieldset className="mcp-vars">
          <legend>Role access</legend>
          <RoleChecklist roles={writer.roles} value={roles} onChange={setRoles} label="Role access" />
        </fieldset>
      )}

      <p className="muted">{editing ? 'Use Test on the server row to check the saved configuration.' : 'Save first to test.'}</p>
    </Dialog>
  )
}
