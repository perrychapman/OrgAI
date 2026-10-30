import type { ReactElement } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Key, Search, TriangleAlert } from 'lucide-react'
import type { McpMutationResult, McpRegistryEntry, McpServerInfo, Project } from '@shared/types'
import { isValidMcpServerName } from '@shared/defaults'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { CopyButton } from '../ui/CopyButton'
import { Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { Input } from '../ui/Input'
import { SecretField } from '../ui/SecretField'
import { RoleChecklist } from './RoleAccess'
import {
  REGISTRY_SUGGESTIONS,
  SECURITY_SECRETS,
  allRoleSlugs,
  dedupeRegistryEntries,
  errMessage,
  launchTarget,
  newServerBase,
  registryOptions,
  securityPhrase,
  slugName,
  type RegistryOption
} from './mcpHelpers'

type Load = { state: 'idle' } | { state: 'loading' } | { state: 'error'; message: string } | { state: 'done'; entries: McpRegistryEntry[]; query: string }

/** Add MCP server from registry: search, pick a pinned package or remote, fill env vars, add. */
export default function RegistryDialog({
  project,
  servers,
  onClose,
  onResult,
  onAddManually
}: {
  project: Project
  servers: McpServerInfo[]
  onClose: () => void
  onResult: (result: McpMutationResult) => void
  onAddManually: () => void
}): ReactElement {
  const [query, setQuery] = useState('')
  const [load, setLoad] = useState<Load>({ state: 'idle' })
  const [picked, setPicked] = useState<McpRegistryEntry | null>(null)
  const seq = useRef(0)
  const searchId = useId()

  const search = (q: string): void => {
    const mine = ++seq.current
    setLoad({ state: 'loading' })
    window.orgai.mcp
      .registrySearch({ query: q.trim(), limit: 20 })
      .then((r) => {
        if (mine === seq.current) setLoad({ state: 'done', entries: dedupeRegistryEntries(r.entries), query: q.trim() })
      })
      .catch((e) => {
        if (mine === seq.current) setLoad({ state: 'error', message: errMessage(e) })
      })
  }
  // Debounced search while typing; Enter searches immediately.
  useEffect(() => {
    if (!query.trim()) return undefined
    const t = setTimeout(() => search(query), 400)
    return () => clearTimeout(t)
  }, [query])

  return (
    <Dialog open onClose={onClose} title="Add MCP server from registry" size="lg" testId="mcp-registry">
      <div className={`mcp-reg${picked ? ' has-pick' : ''}`}>
        <div className="mcp-reg-list">
          <div className="field mcp-field">
            <label htmlFor={searchId}>Search registry</label>
            <div className="mcp-search">
              <Icon icon={Search} size="sm" />
              <Input
                id={searchId}
                type="search"
                value={query}
                autoComplete="off"
                data-autofocus
                placeholder="Name or capability"
                onChange={setQuery}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    if (query.trim()) search(query)
                  }
                }}
              />
            </div>
          </div>
          <Results
            load={load}
            onSuggest={(q) => {
              setQuery(q)
              search(q)
            }} picked={picked} onPick={setPicked} onRetry={() => search(query)} onAddManually={onAddManually} />
        </div>
        {picked && (
          <Detail
            key={picked.name}
            entry={picked}
            project={project}
            servers={servers}
            onBack={() => setPicked(null)}
            onResult={onResult}
            onDone={onClose}
          />
        )}
      </div>
    </Dialog>
  )
}

function Results({
  load,
  picked,
  onPick,
  onSuggest,
  onRetry,
  onAddManually
}: {
  load: Load
  onSuggest: (query: string) => void
  picked: McpRegistryEntry | null
  onPick: (e: McpRegistryEntry) => void
  onRetry: () => void
  onAddManually: () => void
}): ReactElement {
  const list = useRef<HTMLUListElement>(null)
  const [active, setActive] = useState(0)
  useEffect(() => setActive(0), [load])
  if (load.state === 'idle')
    return (
      <div className="stack-2">
        <p className="muted">Type a name or capability to search the registry, or start with one of these.</p>
        <div className="row gap-2 mcp-suggest">
          {REGISTRY_SUGGESTIONS.map((q) => (
            <Button key={q} size="sm" onClick={() => onSuggest(q)}>
              {q}
            </Button>
          ))}
        </div>
      </div>
    )
  if (load.state === 'loading')
    return (
      <div className="mcp-skeletons" aria-busy="true" aria-label="Searching the registry">
        <div className="skeleton mcp-sk" />
        <div className="skeleton mcp-sk" />
        <div className="skeleton mcp-sk" />
      </div>
    )
  if (load.state === 'error')
    return (
      <Banner
        tone="danger"
        title="Registry unavailable"
        actions={
          <>
            <Button size="sm" onClick={onRetry}>
              Retry
            </Button>
            <Button size="sm" variant="ghost" onClick={onAddManually}>
              Add manually
            </Button>
          </>
        }
      >
        {load.message}
      </Banner>
    )
  if (load.entries.length === 0)
    return (
      <p className="muted">
        No servers match “{load.query}”.{' '}
        <Button size="sm" variant="ghost" onClick={onAddManually}>
          Add manually
        </Button>
      </p>
    )
  const move = (to: number): void => {
    const next = Math.max(0, Math.min(load.entries.length - 1, to))
    setActive(next)
    list.current?.querySelectorAll<HTMLElement>('[role="option"]')[next]?.focus()
  }
  return (
    <ul
      ref={list}
      className="mcp-results"
      role="listbox"
      aria-label="Registry results"
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          move(active + 1)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          move(active - 1)
        } else if (e.key === 'Home') {
          e.preventDefault()
          move(0)
        } else if (e.key === 'End') {
          e.preventDefault()
          move(load.entries.length - 1)
        }
      }}
    >
      {load.entries.map((entry, i) => (
        <ResultRow key={`${entry.name}@${entry.version}`} entry={entry} selected={picked?.name === entry.name && picked.version === entry.version} tabbable={i === active} onFocus={() => setActive(i)} onPick={() => onPick(entry)} />
      ))}
    </ul>
  )
}

function ResultRow({
  entry,
  selected,
  tabbable,
  onFocus,
  onPick
}: {
  entry: McpRegistryEntry
  selected: boolean
  tabbable: boolean
  onFocus: () => void
  onPick: () => void
}): ReactElement {
  const options = registryOptions(entry)
  const installable = options.some((o) => !o.blocked)
  const blockedReason = options.length === 0 ? 'No installable package' : options.find((o) => !o.blocked) ? undefined : options[0]?.blocked
  const vars = options.flatMap((o) => o.vars).filter((v, i, a) => a.findIndex((x) => x.name === v.name) === i)
  return (
    <li
      role="option"
      aria-selected={selected}
      aria-disabled={!installable}
      tabIndex={tabbable ? 0 : -1}
      className={`mcp-result${selected ? ' selected' : ''}${installable ? '' : ' blocked'}`}
      onFocus={onFocus}
      onClick={() => installable && onPick()}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && installable) {
          e.preventDefault()
          onPick()
        }
      }}
    >
      <span className="mcp-result-name">{entry.title ?? entry.name}</span>
      <span className="muted mcp-clamp">{entry.description}</span>
      {options.map((o) => (
        <span key={o.key} className="mcp-pkg">
          <span className="mono mcp-trunc" title={o.label}>
            {o.label}
            {o.version ? `@${o.version}` : ''}
          </span>
          <Badge>{o.transport}</Badge>
          {o.pinned ? <Badge tone="success">Pinned</Badge> : <Badge tone="danger" icon={TriangleAlert}>Version not pinned</Badge>}
        </span>
      ))}
      {vars.length > 0 && (
        <span className="mcp-chips">
          {vars.map((v) => (
            <span key={v.name} className="mcp-chip mono">
              {v.isSecret && <Icon icon={Key} size="xs" label="Secret" />}
              {v.name}
            </span>
          ))}
        </span>
      )}
      {blockedReason && <span className="mcp-reason">Cannot select: {blockedReason}.</span>}
    </li>
  )
}

function Detail({
  entry,
  project,
  servers,
  onBack,
  onResult,
  onDone
}: {
  entry: McpRegistryEntry
  project: Project
  servers: McpServerInfo[]
  onBack: () => void
  onResult: (result: McpMutationResult) => void
  onDone: () => void
}): ReactElement {
  const options = useMemo(() => registryOptions(entry).filter((o) => !o.blocked), [entry])
  const taken = servers.map((s) => s.spec.name)
  const [optKey, setOptKey] = useState(options[0]?.key)
  const option: RegistryOption | undefined = options.find((o) => o.key === optKey)
  const [name, setName] = useState(() => slugName(entry.name, taken))
  const [roles, setRoles] = useState<string[]>(() => allRoleSlugs(project.roles))
  const [values, setValues] = useState<Record<string, string>>({})
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [base] = useState(() => newServerBase('', project.roles).id)
  const nameId = useId()

  const nameError = !name ? 'Enter a name.' : !isValidMcpServerName(name) ? 'Use lowercase letters, numbers and single hyphens.' : taken.includes(name) ? 'Another server already uses this name.' : null

  if (!option) return <div className="mcp-reg-detail">This server has no installable package.</div>

  const spec = option.build({ id: base, name, enabled: true, roles, addedAt: new Date().toISOString() }, values)
  const missing = option.vars.filter((v) => v.isRequired && (v.isSecret ? secrets[v.name] === undefined : !(values[v.name] ?? v.default)))
  const target = launchTarget(spec)

  const add = async (): Promise<void> => {
    setTouched(true)
    if (nameError) return
    setBusy(true)
    setError(null)
    try {
      let result = await window.orgai.mcp.upsert({ projectId: project.id, spec })
      onResult(result)
      const failed: string[] = []
      for (const v of option.vars.filter((x) => x.isSecret)) {
        const value = secrets[v.name]
        if (value === undefined) continue
        try {
          result = await window.orgai.mcp.setSecret({ projectId: project.id, serverId: spec.id, kind: option.varKind, name: v.name, value })
          onResult(result)
        } catch (e) {
          failed.push(`${v.name}: ${errMessage(e)}`)
        }
      }
      if (failed.length > 0) {
        setError(`The server was added, but some secrets were not saved: ${failed.join('; ')}. Set them from the server row.`)
        setBusy(false)
        return
      }
      onDone()
    } catch (e) {
      setError(errMessage(e))
      setBusy(false)
    }
  }

  return (
    <div className="mcp-reg-detail">
      <div className="mcp-detail-head">
        <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={onBack}>
          Back
        </Button>
        <strong>{entry.title ?? entry.name}</strong>
      </div>
      {error && (
        <Banner tone="danger" title="Could not add the server">
          {error}
        </Banner>
      )}
      <p className="muted mcp-clamp">{entry.description}</p>
      {options.length > 1 && (
        <div className="field mcp-field">
          <label htmlFor={`${nameId}-opt`}>Package</label>
          <select id={`${nameId}-opt`} className="select mono-select" value={optKey} onChange={(e) => setOptKey(e.target.value)}>
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
                {o.version ? `@${o.version}` : ''}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field mcp-field">
        <span className="mcp-label">{spec.transport === 'stdio' ? 'Command that will run' : 'URL that will be used'}</span>
        <div className="mcp-exact">
          <code className="code-block mcp-exact-code" data-testid="mcp-registry-command">{target}</code>
          <CopyButton text={target} label="Copy command" />
        </div>
        <span className="hint">
          {spec.registry?.registryType === 'remote' ? `Registry version ${spec.registry.version}` : `Pinned to version ${spec.registry?.version}`}
        </span>
      </div>
      <div className="field mcp-field">
        <label htmlFor={nameId}>Name</label>
        <Input
          id={nameId}
          mono
          invalid={touched && !!nameError}
          value={name}
          autoComplete="off"
          spellCheck={false}
          onChange={setName}
          onBlur={() => setTouched(true)}
        />
        {touched && nameError && <span className="hint invalid-text">{nameError}</span>}
      </div>
      {option.vars.length > 0 && (
        <fieldset className="mcp-vars">
          <legend>{option.varKind === 'env' ? 'Environment variables' : 'Headers'}</legend>
          {option.vars.map((v) => (
            <div key={v.name} className="field mcp-field">
              <span className="mcp-label mono">
                {v.name}
                {v.isRequired ? ' (required)' : ''}
              </span>
              {v.isSecret ? (
                <SecretField
                  name={v.name}
                  state={secrets[v.name] !== undefined ? 'set' : 'notSet'}
                  hint={v.description}
                  onSave={(value) => setSecrets((s) => ({ ...s, [v.name]: value }))}
                  onClear={() =>
                    setSecrets((s) => {
                      const next = { ...s }
                      delete next[v.name]
                      return next
                    })
                  }
                />
              ) : (
                <>
                  <Input
                    mono
                    aria-label={v.name}
                    value={values[v.name] ?? v.default ?? ''}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(value) => setValues((s) => ({ ...s, [v.name]: value }))}
                  />
                  {v.description && <span className="hint">{v.description}</span>}
                </>
              )}
            </div>
          ))}
          {missing.length > 0 && (
            <Banner tone="warning">
              {missing.map((m) => m.name).join(', ')} {missing.length === 1 ? 'is' : 'are'} required and not set. You can add the server now and set it later.
            </Banner>
          )}
        </fieldset>
      )}
      <fieldset className="mcp-vars">
        <legend>Role access</legend>
        <RoleChecklist roles={project.roles} value={roles} onChange={setRoles} label="Role access" />
      </fieldset>
      <p className="muted">
        {securityPhrase(spec.transport)} {SECURITY_SECRETS}
      </p>
      <div className="mcp-detail-actions">
        <Button variant="primary" loading={busy} onClick={() => void add()}>
          Add server
        </Button>
        <Button onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
