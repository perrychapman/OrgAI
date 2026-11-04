import type { ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import type { McpMutationResult, McpServerInfo } from '@shared/types'
import { MCP_OVERRIDE_VALUE_MAX, mcpProjectApi } from '../../lib/mcpScope'
import { cleanIpcError } from '../../lib/ipcError'
import { Input } from '../ui/Input'
import { SecretField } from '../ui/SecretField'
import { nextOverrides, perProjectState } from './mcpHelpers'
import { createSerialQueue } from './serialQueue'

/**
 * "For this <noun>": the values this project enters for a linked library server. Plain values save on blur and Enter
 * (mcpProject.setOverrides replaces the whole map, so the full map is sent); secrets use the write-only SecretField and
 * the existing mcp.setSecret, which main routes to this project's own slot. Renders nothing when the entry declares no
 * per-project slot.
 */
export default function PerProjectValues({
  info,
  projectId,
  noun,
  onResult
}: {
  info: McpServerInfo
  projectId: string
  noun: string
  onResult: (r: McpMutationResult) => void
}): ReactElement | null {
  const { spec } = info
  const state = perProjectState(info)
  const api = mcpProjectApi()
  const titleId = useId()
  const baseId = useId()
  const savedKey = JSON.stringify(state.plain)
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(state.plain.map((p) => [p.name, p.value])))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [status, setStatus] = useState('')
  const timer = useRef<number | undefined>(undefined)
  const saved = Object.fromEntries(state.plain.filter((p) => p.value !== '').map((p) => [p.name, p.value]))
  // The last map main confirmed (seeded from props). Every save builds its full map from this, one at a time,
  // because main replaces the whole map and a second save must not drop the first one's value.
  const confirmed = useRef<Record<string, string>>(saved)
  const queue = useRef(createSerialQueue())
  // Values changed elsewhere (a refresh, a copy) replace the drafts, and the confirmed map unless a save is in flight.
  useEffect(() => {
    setDrafts(Object.fromEntries(state.plain.map((p) => [p.name, p.value])))
    if (!queue.current.busy()) confirmed.current = Object.fromEntries(state.plain.filter((p) => p.value !== '').map((p) => [p.name, p.value]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  if (!state.declared) return null

  const remote = spec.transport !== 'stdio'

  const commit = (name: string): Promise<void> => {
    const value = (drafts[name] ?? '').trim()
    if (!api) return Promise.resolve()
    if (value.length > MCP_OVERRIDE_VALUE_MAX) {
      setErrors((e) => ({ ...e, [name]: `Use at most ${MCP_OVERRIDE_VALUE_MAX} characters.` }))
      return Promise.resolve()
    }
    setErrors((e) => {
      const { [name]: _gone, ...rest } = e
      return rest
    })
    return queue.current.enqueue(async () => {
      if ((confirmed.current[name] ?? '') === value) return
      try {
        const map = nextOverrides(confirmed.current, name, value)
        const result = await api.setOverrides({ projectId, serverId: spec.id, ...(remote ? { headers: map } : { env: map }) })
        confirmed.current = map
        onResult(result)
        setStatus(`Saved ${name}`)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setStatus(''), 2000)
      } catch (e) {
        setErrors((x) => ({ ...x, [name]: cleanIpcError(e) }))
      }
    })
  }

  return (
    <div className="mcp-per-project" data-testid="mcp-per-project" data-server={spec.name} role="group" aria-labelledby={titleId}>
      <p className="mcp-pp-title" id={titleId}>
        For this {noun}
      </p>
      {api &&
        state.plain.map((p) => {
          const id = `${baseId}-${p.name}`
          return (
            <div key={p.name} className="mcp-pp-row" data-name={p.name}>
              <label htmlFor={id} className="mono mcp-pp-label">
                {p.name}
              </label>
              <div className="mcp-pp-field">
                <Input
                  id={id}
                  mono
                  value={drafts[p.name] ?? ''}
                  invalid={!!errors[p.name]}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={errors[p.name] ? `${id}-err` : undefined}
                  onChange={(value) => setDrafts((d) => ({ ...d, [p.name]: value }))}
                  onBlur={() => void commit(p.name)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void commit(p.name)
                    }
                  }}
                />
                {errors[p.name] && (
                  <span id={`${id}-err`} className="hint invalid-text">
                    {errors[p.name]}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      {state.secrets.map((s) => (
        <div key={`${s.kind}:${s.name}`} className="mcp-pp-row" data-name={s.name}>
          <span className="mono mcp-pp-label">{s.name}</span>
          <div className="mcp-pp-field">
            <SecretField
              name={s.name}
              state={s.set ? 'set' : 'notSet'}
              onSave={async (value) => onResult(await window.orgai.mcp.setSecret({ projectId, serverId: spec.id, kind: s.kind, name: s.name, value }))}
              onClear={async () => onResult(await window.orgai.mcp.setSecret({ projectId, serverId: spec.id, kind: s.kind, name: s.name, value: null }))}
            />
          </div>
        </div>
      ))}
      <span className="mcp-pp-status hint" role="status" aria-live="polite" data-testid="mcp-per-project-status">
        {status}
      </span>
    </div>
  )
}
