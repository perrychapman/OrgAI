import { createHash } from 'node:crypto'
import type { McpRegistryRef } from '@shared/types'
import { cleanRoleStaffing } from '@shared/defaults'
import type { TeamDoc, TeamMcpDoc, TeamRoleDoc, TeamSettingsDoc, TeamSkillDoc, TeamSkillFileDoc } from './doc'

/**
 * Normal form and digest of a TeamDoc. Pure. Two documents with the same meaning normalize to the same value whatever
 * the order of their lists and keys, so a digest is stable across computers and git line-ending settings.
 */

/** CRLF and CR to LF, one leading BOM removed. */
export function normalizeText(s: string): string {
  const noBom = s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
  return noBom.replace(/\r\n?/g, '\n')
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const sortedUnique = (list: readonly string[] | undefined): string[] => [...new Set(list ?? [])].sort(cmp)

function sortedRecord(r: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!r) return undefined
  const out: Record<string, string> = {}
  for (const k of Object.keys(r).sort(cmp)) out[k] = r[k]
  return Object.keys(out).length ? out : undefined
}

function normalizeSettings(s: TeamSettingsDoc): TeamSettingsDoc {
  const out: TeamSettingsDoc = { brief: s.brief, permissionMode: s.permissionMode }
  const copy = <K extends keyof TeamSettingsDoc>(k: K): void => {
    if (s[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = s[k]
  }
  copy('maxBudgetUsd')
  copy('maxSubagentDepth')
  copy('maxConcurrentSubagents')
  copy('maxWindowShare')
  copy('preferEverydayNearLimit')
  copy('isolateWriters')
  copy('reviewMerges')
  copy('autoContinue')
  copy('maxAutoContinues')
  copy('runMessaging')
  // Defaults are never held: absent and the default value are the same team.
  if (s.staffing === 'fixed') out.staffing = 'fixed'
  if (s.staffingGoal === 'speed' || s.staffingGoal === 'cost') out.staffingGoal = s.staffingGoal
  if (s.reviewPolicy === 'always' || s.reviewPolicy === 'never') out.reviewPolicy = s.reviewPolicy
  if (s.teamReview) out.teamReview = { auto: s.teamReview.auto, tokenBudget: s.teamReview.tokenBudget, everyRuns: s.teamReview.everyRuns }
  if (s.skillEvaluation) {
    out.skillEvaluation = {
      ...(s.skillEvaluation.enabled !== undefined ? { enabled: s.skillEvaluation.enabled } : {}),
      tokenBudget: s.skillEvaluation.tokenBudget
    }
  }
  return out
}

export function normalizeRole(r: TeamRoleDoc): TeamRoleDoc {
  const out: TeamRoleDoc = {
    slug: r.slug,
    name: r.name,
    description: r.description,
    responsibilities: [...r.responsibilities],
    // A file's body is trimmed and LF when read back, so the document holds it that way.
    prompt: normalizeText(r.prompt).trim(),
    tools: sortedUnique(r.tools),
    canSpawn: r.canSpawn,
    spawnable: sortedUnique(r.spawnable),
    reportsTo: r.reportsTo ?? null,
    color: r.color,
    skills: sortedUnique(r.skills),
    mcpServers: sortedUnique(r.mcpServers)
  }
  const required = sortedUnique(r.requiredReports ?? [])
  if (required.length > 0) out.requiredReports = required
  if (r.tier !== undefined) out.tier = r.tier
  else if (r.model !== undefined) out.model = r.model
  if (r.effort !== undefined) out.effort = r.effort
  const staffing = cleanRoleStaffing(r.staffing)
  if (staffing) out.staffing = staffing
  return out
}

function normalizeSkillFile(f: TeamSkillFileDoc): TeamSkillFileDoc {
  return f.base64 !== undefined ? { path: f.path, base64: f.base64 } : { path: f.path, text: normalizeText(f.text ?? '') }
}

function normalizeSkill(s: TeamSkillDoc): TeamSkillDoc {
  return {
    name: s.name,
    description: s.description,
    body: normalizeText(s.body).trim(),
    files: s.files.map(normalizeSkillFile).sort((a, b) => cmp(a.path, b.path)),
    enabled: s.enabled
  }
}

function normalizeRegistry(r: McpRegistryRef): McpRegistryRef {
  return { name: r.name, version: r.version, registryType: r.registryType, identifier: r.identifier }
}

function normalizeMcp(m: TeamMcpDoc): TeamMcpDoc {
  const out: TeamMcpDoc = { name: m.name, transport: m.transport, enabled: m.enabled }
  if (m.command !== undefined) out.command = m.command
  if (m.args?.length) out.args = [...m.args]
  const env = sortedRecord(m.env)
  if (env) out.env = env
  const secretEnv = sortedUnique(m.secretEnv)
  if (secretEnv.length) out.secretEnv = secretEnv
  if (m.url !== undefined) out.url = m.url
  const headers = sortedRecord(m.headers)
  if (headers) out.headers = headers
  const secretHeaders = sortedUnique(m.secretHeaders)
  if (secretHeaders.length) out.secretHeaders = secretHeaders
  if (m.description) out.description = m.description
  if (m.roles !== undefined) out.roles = sortedUnique(m.roles)
  if (m.connectorId !== undefined) out.connectorId = m.connectorId
  if (m.connectorVariant !== undefined) out.connectorVariant = m.connectorVariant
  if (m.fromLibrary) out.fromLibrary = true
  if (m.registry) out.registry = normalizeRegistry(m.registry)
  return out
}

/** Sorts everything whose order has no meaning, drops undefined and empty optional lists, keeps responsibilities in order. Never mutates. */
export function normalizeDoc(doc: TeamDoc): TeamDoc {
  return {
    settings: normalizeSettings(doc.settings),
    roles: doc.roles.map(normalizeRole).sort((a, b) => cmp(a.slug, b.slug)),
    skills: doc.skills.map(normalizeSkill).sort((a, b) => cmp(a.name, b.name)),
    mcp: doc.mcp.map(normalizeMcp).sort((a, b) => cmp(a.name, b.name))
  }
}

/** JSON with every object's keys sorted; undefined members are dropped like JSON.stringify does. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort(cmp)) out[k] = walk((v as Record<string, unknown>)[k])
      return out
    }
    return v
  }
  return JSON.stringify(walk(value))
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * sha256 hex over the canonical JSON of the normalized document: parsed content only, never bytes. `problemFiles` mixes
 * in the identity of files that could not be read, so a changed broken file changes the digest too. With none, the
 * digest is the document's alone.
 */
export function teamDigest(doc: TeamDoc, problemFiles?: { file: string; contentDigest: string }[]): string {
  const normalized = normalizeDoc(doc)
  if (!problemFiles || problemFiles.length === 0) return sha256Hex(canonicalJson(normalized))
  const problems = [...problemFiles].sort((a, b) => cmp(a.file, b.file) || cmp(a.contentDigest, b.contentDigest))
  return sha256Hex(canonicalJson({ doc: normalized, problems }))
}
