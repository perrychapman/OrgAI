import { CAPABILITY_DESCRIPTION_MAX, CAPABILITY_GITHUB_SKILLS_REPO, type CapabilityFlag, type CapabilitySourceId, type CapabilityWarning, type McpRegistryEntry, type McpServerSpec } from '@shared/types'
import { REGISTRY_URL, parseRegistryResponse } from '../mcp/registry'
import { isPrivateHost } from '../mcp/oauth'
import { isExactSemver, nameFromRegistry, specFromRegistry, validateSpec, type RegistryChoice } from '../mcp/validate'
import { buildScannedSkill } from '../skills/scan'
import { capabilityId, clampText, isKeyLikeValue, isSecretName, scrubUrl, validKeyName } from './sanitize'
import type { DiscoveredCandidate, OutsideContext, SourceResult } from './types'

/**
 * Outside sources of the Team assistant: the official MCP Registry and the allowlisted GitHub skills repo. Fixed
 * https hosts only, no auth, no redirects, bounded bodies, and nothing found in an answer is ever fetched. Both
 * functions never throw. Everything returned is untrusted and flagged 'unverified'.
 */

export const OUTSIDE_TIMEOUT_MS = 10_000
export const REGISTRY_BODY_CAP = 2 * 1024 * 1024
export const GITHUB_LIST_CAP = 512 * 1024
export const SKILL_MD_CAP = 256 * 1024
export const REGISTRY_MAX_QUERIES = 5
export const REGISTRY_MAX_CANDIDATES = 30
export const GITHUB_MAX_SKILLS = 20

const REGISTRY_HOST = 'registry.modelcontextprotocol.io'
const GITHUB_HOST = 'api.github.com'
const REGISTRY_LABEL = 'MCP Registry'
const GITHUB_LABEL = 'anthropics/skills'
const SAFE_DIR = /^[A-Za-z0-9._-]{1,64}$/

class TooLarge extends Error {}

/** https, an allowlisted host, no private-IP literal. */
function assertAllowed(url: string, host: string): void {
  const u = new URL(url)
  if (u.protocol !== 'https:' || u.hostname !== host || isPrivateHost(u.hostname)) throw new Error('Refused a URL outside the allowed host.')
}

async function request(ctx: OutsideContext, url: string, host: string, extra: Record<string, string> = {}): Promise<Response> {
  assertAllowed(url, host)
  const timeout = AbortSignal.timeout(OUTSIDE_TIMEOUT_MS)
  const signal = ctx.signal ? AbortSignal.any([timeout, ctx.signal]) : timeout
  return ctx.fetch(url, { method: 'GET', headers: { Accept: 'application/json', ...extra }, redirect: 'error', signal })
}

async function readCapped(res: Response, cap: number): Promise<string> {
  const len = Number(res.headers.get('content-length'))
  if (Number.isFinite(len) && len > cap) {
    await res.body?.cancel().catch(() => undefined)
    throw new TooLarge()
  }
  if (!res.body) {
    const t = await res.text()
    if (t.length > cap) throw new TooLarge()
    return t
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel().catch(() => undefined)
      throw new TooLarge()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true
  if (res.status !== 403) return false
  return res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after') !== null
}

function retryAfterSec(res: Response): number | undefined {
  const ra = res.headers.get('retry-after')
  if (ra) {
    const n = Number(ra)
    if (Number.isFinite(n) && n >= 0) return Math.max(1, Math.ceil(n))
    const t = Date.parse(ra)
    if (Number.isFinite(t)) return Math.max(1, Math.ceil((t - Date.now()) / 1000))
  }
  const resetRaw = res.headers.get('x-ratelimit-reset')
  const reset = Number(resetRaw)
  if (resetRaw && Number.isFinite(reset)) return Math.max(1, Math.ceil(reset - Date.now() / 1000))
  return undefined
}

function failText(e: unknown, who: string): string {
  if (e instanceof TooLarge) return `${who} sent more data than OrgAI accepts.`
  const err = e as Error
  if (err?.name === 'TimeoutError') return `${who} did not answer in time.`
  return `${who} could not be reached.`
}

interface Outcome {
  source: CapabilitySourceId
  label: string
  locations: string[]
  candidates: DiscoveredCandidate[]
  warnings: CapabilityWarning[]
  aborted: boolean
  rate?: { sec?: number; message: string }
  error?: string
}

function finish(o: Outcome): SourceResult {
  const base = { source: o.source, label: o.label, locations: o.locations, count: o.candidates.length }
  let status: SourceResult['sources'][number]
  if (o.aborted) status = { ...base, state: 'skipped', message: 'Stopped.' }
  else if (o.rate) status = { ...base, state: 'rateLimited', message: o.rate.message, ...(o.rate.sec !== undefined ? { retryAfterSec: o.rate.sec } : {}) }
  else if (o.error) status = { ...base, state: 'error', message: o.error }
  else status = { ...base, state: o.candidates.length ? 'found' : 'empty' }
  if (o.error && !o.aborted && !o.rate) console.warn(`[capabilities] ${o.source}: ${o.error}`)
  return { candidates: o.candidates, sources: [status], warnings: o.warnings }
}

function rateMessage(who: string, phrase: string, sec: number | undefined): string {
  return sec !== undefined ? `${who} ${phrase}. Try again in about ${sec} s.` : `${who} ${phrase}. Try again later.`
}

// ---------- registry ----------

function pickChoice(entry: McpRegistryEntry): RegistryChoice | null {
  const pi = entry.packages.findIndex((p) => ['npm', 'pypi', 'oci'].includes(p.registryType) && p.transport.type === 'stdio')
  if (pi >= 0) return { type: 'package', index: pi }
  if (entry.remotes.length) return { type: 'remote', index: 0 }
  return null
}

function sanitizeSpec(spec: McpServerSpec, entry: McpRegistryEntry): void {
  const keep = (rec: Record<string, string> | undefined): Record<string, string> | undefined => {
    if (!rec) return undefined
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(rec)) {
      if (!validKeyName(k) || isSecretName(k) || isKeyLikeValue(v)) continue
      out[k] = clampText(v, 200)
    }
    return Object.keys(out).length ? out : undefined
  }
  const env = keep(spec.env)
  const headers = keep(spec.headers)
  if (env) spec.env = env
  else delete spec.env
  if (headers) spec.headers = headers
  else delete spec.headers
  if (spec.secretEnv) spec.secretEnv = spec.secretEnv.filter(validKeyName)
  if (spec.secretHeaders) spec.secretHeaders = spec.secretHeaders.filter(validKeyName)
  const description = clampText(entry.title || entry.description, 200)
  if (description) spec.description = description
  else delete spec.description
}

function buildRegistryCandidate(entry: McpRegistryEntry): DiscoveredCandidate | null {
  const choice = pickChoice(entry)
  if (!choice) return null
  let spec: McpServerSpec
  let blockedReason: string | undefined
  try {
    spec = specFromRegistry(entry, choice)
    sanitizeSpec(spec, entry)
    const errors = validateSpec(spec)
    if (errors.length) blockedReason = clampText(errors[0], 200)
  } catch (e) {
    blockedReason = clampText((e as Error).message, 200)
    spec = { id: '', name: nameFromRegistry(entry.name), transport: 'stdio', enabled: false, source: 'registry', addedAt: '' }
  }
  if (entry.status === 'deprecated') blockedReason = 'Deprecated in the MCP Registry.'
  const stdio = spec.transport === 'stdio'
  const target = stdio ? clampText([spec.command ?? '', ...(spec.args ?? [])].join(' '), 200) : clampText(scrubUrl(spec.url) ?? '', 200)
  const flags: CapabilityFlag[] = ['unverified', stdio ? 'runsCode' : 'remote']
  const location = scrubUrl(entry.repositoryUrl) ?? `MCP Registry: ${clampText(entry.name, 120)}`
  const item: DiscoveredCandidate['item'] = {
    id: capabilityId('registry', 'mcp', entry.name, spec.name),
    kind: 'mcp',
    origin: 'registry',
    source: 'registry',
    sourceLabel: REGISTRY_LABEL,
    location,
    name: spec.name,
    description: clampText(entry.title || entry.description),
    ...(isExactSemver(entry.version) ? { version: entry.version } : {}),
    transport: spec.transport,
    target,
    flags,
    needsSecrets: [...(spec.secretEnv ?? []), ...(spec.secretHeaders ?? [])],
    ...(blockedReason ? { blockedReason } : {}),
    notes: ['From the MCP Registry. Unverified: check it before use.']
  }
  return { item, payload: { type: 'mcpSpec', spec } }
}

const MOCK_REGISTRY: McpRegistryEntry[] = [
  {
    name: 'io.github.mock/github-tools',
    title: 'GitHub Tools',
    description: 'Read issues and pull requests from GitHub repositories.',
    version: '1.2.0',
    repositoryUrl: 'https://github.com/mock/github-tools',
    packages: [{ registryType: 'npm', identifier: '@mock/github-tools', version: '1.2.0', transport: { type: 'stdio' }, environmentVariables: [{ name: 'GITHUB_TOKEN', isSecret: true, isRequired: true }] }],
    remotes: [],
    status: 'active'
  },
  {
    name: 'io.github.mock/test-runner',
    description: 'Run a project test suite and report failures.',
    version: '0.4.1',
    repositoryUrl: 'https://github.com/mock/test-runner',
    packages: [{ registryType: 'pypi', identifier: 'mock-test-runner', version: '0.4.1', transport: { type: 'stdio' }, environmentVariables: [] }],
    remotes: [],
    status: 'active'
  },
  {
    name: 'io.github.mock/docs-search',
    description: 'Search hosted documentation.',
    version: '2.0.0',
    packages: [],
    remotes: [{ type: 'streamable-http', url: 'https://docs-search.mock.example/mcp' }],
    status: 'active'
  },
  {
    name: 'io.github.mock/unpinned-tool',
    description: 'A tool published without a pinned version.',
    version: 'latest',
    packages: [{ registryType: 'npm', identifier: '@mock/unpinned-tool', version: 'latest', transport: { type: 'stdio' }, environmentVariables: [] }],
    remotes: [],
    status: 'active'
  }
]

export async function discoverRegistry(ctx: OutsideContext): Promise<SourceResult> {
  const o: Outcome = { source: 'registry', label: REGISTRY_LABEL, locations: [REGISTRY_URL], candidates: [], warnings: [], aborted: false }
  const seen = new Set<string>()
  const add = (entry: McpRegistryEntry): void => {
    if (seen.has(entry.name) || o.candidates.length >= REGISTRY_MAX_CANDIDATES) return
    seen.add(entry.name)
    const c = buildRegistryCandidate(entry)
    if (c) o.candidates.push(c)
  }
  try {
    if (ctx.mock) {
      if (ctx.signal?.aborted) o.aborted = true
      else MOCK_REGISTRY.forEach(add)
      return finish(o)
    }
    for (const q of ctx.queries.slice(0, REGISTRY_MAX_QUERIES)) {
      if (ctx.signal?.aborted) {
        o.aborted = true
        break
      }
      try {
        const url = `${REGISTRY_URL}?search=${encodeURIComponent(q)}&limit=10&version=latest`
        const res = await request(ctx, url, REGISTRY_HOST)
        if (isRateLimited(res)) {
          await res.body?.cancel().catch(() => undefined)
          const sec = retryAfterSec(res)
          o.rate = { sec, message: rateMessage(REGISTRY_LABEL, 'is busy', sec) }
          break
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined)
          o.error = `${REGISTRY_LABEL} answered with an error (HTTP ${res.status}).`
          break
        }
        const text = await readCapped(res, REGISTRY_BODY_CAP)
        let json: unknown
        try {
          json = JSON.parse(text)
        } catch {
          o.error = `${REGISTRY_LABEL} sent an answer OrgAI could not read.`
          break
        }
        for (const entry of parseRegistryResponse(json).entries) add(entry)
      } catch (e) {
        if (ctx.signal?.aborted) o.aborted = true
        else o.error = failText(e, REGISTRY_LABEL)
        break
      }
    }
  } catch (e) {
    o.error = failText(e, REGISTRY_LABEL)
  }
  if (o.error && !o.aborted) o.warnings.push({ source: 'registry', location: REGISTRY_URL, message: o.error })
  return finish(o)
}

// ---------- GitHub skills ----------

const MOCK_SKILLS: Record<string, string> = {
  'webapp-testing': '---\nname: webapp-testing\ndescription: Use when testing a local web application with a browser.\n---\n\n# Web app testing\n\nStart the app, drive it with a browser and report what failed.\n',
  pdf: '---\nname: pdf\ndescription: Use when reading, filling or creating PDF documents.\n---\n\n# PDF\n\nExtract text and form fields, then write the result back out.\n'
}

function buildSkillCandidate(dir: string, md: Buffer): DiscoveredCandidate | string {
  const scanned = buildScannedSkill([{ path: 'SKILL.md', data: md }], dir, dir, null)
  if (typeof scanned === 'string') return scanned
  const location = `https://github.com/${CAPABILITY_GITHUB_SKILLS_REPO}/tree/main/skills/${dir}`
  return {
    item: {
      id: capabilityId('github', 'skill', `${CAPABILITY_GITHUB_SKILLS_REPO}/skills/${dir}`, scanned.name),
      kind: 'skill',
      origin: 'github',
      source: 'github',
      sourceLabel: GITHUB_LABEL,
      location,
      name: clampText(scanned.name, 100),
      description: clampText(scanned.description, CAPABILITY_DESCRIPTION_MAX),
      digest: scanned.digest,
      flags: ['partial', 'unverified'],
      needsSecrets: [],
      notes: ['SKILL.md only: resource files were not fetched.', 'From GitHub. Unverified: check it before use.']
    },
    payload: { type: 'skillMd', text: scanned.data[0]!.data.toString('utf8'), url: location }
  }
}

export async function discoverGithubSkills(ctx: OutsideContext): Promise<SourceResult> {
  const base = `https://${GITHUB_HOST}/repos/${CAPABILITY_GITHUB_SKILLS_REPO}/contents/skills`
  const o: Outcome = { source: 'github', label: GITHUB_LABEL, locations: [base], candidates: [], warnings: [], aborted: false }
  const warn = (message: string, location?: string): void => {
    o.warnings.push({ source: 'github', ...(location ? { location } : {}), message: clampText(message, 300) })
  }
  try {
    if (ctx.mock) {
      if (ctx.signal?.aborted) o.aborted = true
      else {
        for (const [dir, text] of Object.entries(MOCK_SKILLS)) {
          const c = buildSkillCandidate(dir, Buffer.from(text, 'utf8'))
          if (typeof c !== 'string') o.candidates.push(c)
        }
      }
      return finish(o)
    }
    if (ctx.signal?.aborted) {
      o.aborted = true
      return finish(o)
    }
    const gh = { 'User-Agent': 'OrgAI', 'X-GitHub-Api-Version': '2022-11-28' }
    const res = await request(ctx, base, GITHUB_HOST, gh)
    if (isRateLimited(res)) {
      await res.body?.cancel().catch(() => undefined)
      const sec = retryAfterSec(res)
      o.rate = { sec, message: rateMessage('GitHub', 'rate limit reached', sec) }
      return finish(o)
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      o.error = `GitHub answered with an error (HTTP ${res.status}).`
      warn(o.error, base)
      return finish(o)
    }
    let listing: unknown
    try {
      listing = JSON.parse(await readCapped(res, GITHUB_LIST_CAP))
    } catch (e) {
      if (e instanceof TooLarge) throw e
      o.error = 'GitHub sent an answer OrgAI could not read.'
      warn(o.error, base)
      return finish(o)
    }
    const dirs = (Array.isArray(listing) ? listing : [])
      .filter((e): e is { type: string; name: string } => !!e && typeof e === 'object' && (e as { type?: unknown }).type === 'dir' && typeof (e as { name?: unknown }).name === 'string')
      .map((e) => e.name)
      .filter((n) => SAFE_DIR.test(n))
      .slice(0, GITHUB_MAX_SKILLS)
    for (const dir of dirs) {
      if (ctx.signal?.aborted) {
        o.aborted = true
        break
      }
      const url = `${base}/${dir}/SKILL.md`
      const r = await request(ctx, url, GITHUB_HOST, gh)
      if (isRateLimited(r)) {
        await r.body?.cancel().catch(() => undefined)
        const sec = retryAfterSec(r)
        o.rate = { sec, message: rateMessage('GitHub', 'rate limit reached', sec) }
        break
      }
      if (!r.ok) {
        await r.body?.cancel().catch(() => undefined)
        warn(`Skipped ${dir}: GitHub answered HTTP ${r.status}.`, url)
        continue
      }
      let meta: unknown
      try {
        meta = JSON.parse(await readCapped(r, Math.ceil((SKILL_MD_CAP * 4) / 3) + 4096))
      } catch (e) {
        warn(e instanceof TooLarge ? `Skipped ${dir}: SKILL.md is larger than OrgAI accepts.` : `Skipped ${dir}: the answer could not be read.`, url)
        continue
      }
      const m = meta as { type?: unknown; encoding?: unknown; content?: unknown } | null
      if (!m || m.type !== 'file' || m.encoding !== 'base64' || typeof m.content !== 'string') {
        warn(`Skipped ${dir}: SKILL.md is not a plain file.`, url)
        continue
      }
      const data = Buffer.from(m.content, 'base64')
      if (data.length > SKILL_MD_CAP) {
        warn(`Skipped ${dir}: SKILL.md is larger than OrgAI accepts.`, url)
        continue
      }
      const c = buildSkillCandidate(dir, data)
      if (typeof c === 'string') warn(`Skipped ${dir}: ${c}`, url)
      else o.candidates.push(c)
    }
  } catch (e) {
    if (ctx.signal?.aborted) o.aborted = true
    else {
      o.error = failText(e, 'GitHub')
      warn(o.error, base)
    }
  }
  return finish(o)
}
