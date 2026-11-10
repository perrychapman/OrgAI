/**
 * The run-start models line (cli-parity 3.1): which concrete model each tier of a work run's roles resolves to on its
 * connection(s), and one warning when a tier in use sits on an older member of its family, on a built-in fallback, or
 * on a connection whose model discovery last failed. Pure; RunManager calls `runModelLogs` once at run start and
 * emits what it returns as run `log` events. Never throws.
 */
import { MODEL_TIERS, type ConnectionId, type ModelTier, type ProviderModel, type Role } from '@shared/types'

/** A model id read as family + version: `claude-opus-4-1-20250805` = claude-opus, [4, 1], date 20250805. */
export interface ModelVersion {
  family: string
  version: number[]
  /** A snapshot date (YYYYMMDD), when the id carries one. */
  date?: number
}

const NUMERIC = /^\d+(?:\.\d+)*$/

/**
 * Family and version of a model id, or undefined when the id carries no version (an alias such as 'opus') or no
 * family. Provider prefixes ('anthropic/', 'us.anthropic.'), a context marker ('[1m]'), a Bedrock ':0' suffix and a
 * trailing snapshot date ('-20250805', '@20250805', '-2024-08-06') are set aside. Numeric tokens make the version in
 * order ('gpt-6.1-sol' = gpt-sol [6, 1]; 'claude-3-5-sonnet' = claude-sonnet [3, 5]); every other token names the family.
 */
export function parseModelVersion(id: string): ModelVersion | undefined {
  let s = id.trim().toLowerCase()
  s = s.slice(s.lastIndexOf('/') + 1)
  s = s.replace(/\[[^\]]*\]$/, '').replace(/:\d+$/, '')
  let date: number | undefined
  const compact = /[-@](\d{8})$/.exec(s)
  const dashed = /-(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (compact) {
    date = Number(compact[1])
    s = s.slice(0, compact.index)
  } else if (dashed) {
    date = Number(`${dashed[1]}${dashed[2]}${dashed[3]}`)
    s = s.slice(0, dashed.index)
  }
  const tokens = s.split('-').filter(Boolean)
  if (tokens.length === 0) return undefined
  // 'us.anthropic.claude' (a Bedrock region / vendor prefix): keep the last dotted part of a non-numeric first token.
  if (!NUMERIC.test(tokens[0]!) && tokens[0]!.includes('.')) tokens[0] = tokens[0]!.slice(tokens[0]!.lastIndexOf('.') + 1)
  const family: string[] = []
  const version: number[] = []
  for (const t of tokens) {
    if (NUMERIC.test(t)) version.push(...t.split('.').map(Number))
    else family.push(t)
  }
  if (family.length === 0 || version.length === 0 || version.some((n) => !Number.isFinite(n))) return undefined
  return { family: family.join('-'), version, ...(date !== undefined ? { date } : {}) }
}

/**
 * Which of two model ids is newer within one family: > 0 when `a` is newer, < 0 when older, 0 when the same version.
 * undefined when the comparison cannot tell (different families, or an id without a version).
 */
export function compareModelIds(a: string, b: string): number | undefined {
  const x = parseModelVersion(a)
  const y = parseModelVersion(b)
  if (!x || !y || x.family !== y.family) return undefined
  const n = Math.max(x.version.length, y.version.length)
  for (let i = 0; i < n; i++) {
    const d = (x.version[i] ?? 0) - (y.version[i] ?? 0)
    if (d !== 0) return d
  }
  if (x.date !== undefined && y.date !== undefined) return x.date - y.date
  return 0
}

/** The newest id in `candidates` that is newer than `model` in its family, or undefined (it is the newest, or cannot tell). */
export function newerInFamily(model: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined
  for (const c of candidates) {
    const d = compareModelIds(c, model)
    if (d === undefined || d <= 0) continue
    if (!best || (compareModelIds(c, best) ?? 0) > 0) best = c
  }
  return best
}

export interface RunModelsInput {
  /** The roles the run uses (after single-assistant and quick-run settling). */
  roles: readonly Pick<Role, 'id' | 'model' | 'tier'>[]
  /** The connection a role runs on. */
  connectionOf: (roleId: string) => ConnectionId
  /** Every connection's catalog (ConnectionService.catalog), read inside the guard; entries are matched per connection. */
  catalog: () => readonly Pick<ProviderModel, 'id' | 'connection' | 'source'>[]
  connectionName: (id: ConnectionId) => string
  /** The last background discovery failure of a connection (ConnectionInfo.modelsError). */
  modelsError?: (id: ConnectionId) => string | undefined
}

export interface RunModelLog {
  level: 'info' | 'warn'
  message: string
}

const ID_MAX = 80
const ERROR_MAX = 160

function cut(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

interface Use {
  tier?: ModelTier
  model: string
}

/**
 * The run-start log lines: one `info` "Models: deep = claude-opus-5-5, everyday = claude-sonnet-5-5 (Anthropic)" (a
 * role on an exact model id with no tier is listed by its id; one group per connection, '; ' between them) and at most
 * one `warn` naming each tier on an older family member, on a built-in fallback, or on a connection whose discovery
 * last failed, with the remedy. Empty when no role names a model (every role inherits) or on any error.
 */
export function runModelLogs(input: RunModelsInput): RunModelLog[] {
  try {
    const byConnection = new Map<ConnectionId, Use[]>()
    for (const r of input.roles) {
      const model = typeof r.model === 'string' ? r.model.trim() : ''
      if (!model || model === 'inherit') continue
      const on = input.connectionOf(r.id)
      const list = byConnection.get(on) ?? []
      if (!list.some((u) => u.tier === r.tier && u.model === model)) list.push({ ...(r.tier ? { tier: r.tier } : {}), model })
      byConnection.set(on, list)
    }
    if (byConnection.size === 0) return []
    const all = input.catalog()
    const rank = (u: Use): number => (u.tier ? MODEL_TIERS.indexOf(u.tier) : MODEL_TIERS.length)
    const groups: string[] = []
    const problems: string[] = []
    const fix = new Set<ConnectionId>()
    for (const [on, uses] of byConnection) {
      uses.sort((a, b) => rank(a) - rank(b))
      const name = cut(input.connectionName(on), 60)
      groups.push(`${uses.map((u) => (u.tier ? `${u.tier} = ${cut(u.model, ID_MAX)}` : cut(u.model, ID_MAX))).join(', ')} (${name})`)
      const catalog = all.filter((m) => m.connection === on)
      const ids = catalog.map((m) => m.id)
      for (const u of uses) {
        if (!u.tier) continue
        const entry = catalog.find((m) => m.id === u.model)
        const label = `${u.tier} = ${cut(u.model, ID_MAX)}`
        if (entry && entry.source !== 'discovered') {
          problems.push(`${label} is a built-in fallback, not a model discovered on ${name}`)
          fix.add(on)
          continue
        }
        const newer = newerInFamily(u.model, ids)
        if (newer) {
          problems.push(`${label} is not the newest of its family on ${name} (${cut(newer, ID_MAX)} is listed)`)
          fix.add(on)
        }
      }
      const error = input.modelsError?.(on)?.trim()
      if (error && uses.some((u) => u.tier)) {
        problems.push(`model discovery last failed on ${name} (${cut(error, ERROR_MAX)}), so ${uses.filter((u) => u.tier).map((u) => u.tier).join(', ')} may be out of date`)
        fix.add(on)
      }
    }
    const out: RunModelLog[] = [{ level: 'info', message: `Models: ${groups.join('; ')}` }]
    if (problems.length > 0) {
      const tierFix = [...fix].map((id) => `orgai connections tier ${id}`).join(' or ')
      out.push({ level: 'warn', message: `Model check: ${problems.join('; ')}. Run orgai models refresh, or map the tier with ${tierFix}.` })
    }
    return out
  } catch {
    return []
  }
}
