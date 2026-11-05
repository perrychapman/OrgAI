import { TEAM_FILES_AGENTS_DIR, TEAM_FILES_FORMAT, TEAM_FILES_JSON, TEAM_FILES_MCP_JSON, TEAM_FILES_SKILLS_DIR } from '@shared/types'
import { composeSkillMd } from '../skills/skillMd'
import type { TeamDoc, TeamFile, TeamMcpDoc, TeamRoleDoc, TeamSettingsDoc, TeamSkillDoc } from './doc'
import { normalizeDoc, normalizeRole, normalizeText } from './digest'

/**
 * TeamDoc to files. Deterministic: the same document always gives the same bytes (fixed key order, sorted lists, LF).
 * Every string in a role's frontmatter is double-quoted with the escaper below, which the frontmatter parser
 * (setup/import/frontmatter.ts unquoteDouble) reads back exactly. JSON.stringify is NOT used for that: its \b and \f
 * escapes are not understood by that parser.
 */

/** The characters a double-quoted frontmatter string must not hold raw. */
function needsUnicodeEscape(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
}

/** `"..."` with backslash, quote, \n, \t, \r and every other control, 0x7f-0x9f, U+2028/9 and lone surrogate as \uXXXX. */
export function yamlQuote(s: string): string {
  let out = '"'
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0x5c) out += '\\\\'
    else if (c === 0x22) out += '\\"'
    else if (c === 0x0a) out += '\\n'
    else if (c === 0x09) out += '\\t'
    else if (c === 0x0d) out += '\\r'
    else if (needsUnicodeEscape(c)) out += `\\u${c.toString(16).padStart(4, '0')}`
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1]
        i++
      } else out += `\\u${c.toString(16).padStart(4, '0')}`
    } else if (c >= 0xdc00 && c <= 0xdfff) out += `\\u${c.toString(16).padStart(4, '0')}`
    else out += s[i]
  }
  return `${out}"`
}

function listLines(key: string, items: readonly string[]): string[] {
  if (items.length === 0) return [`${key}: []`]
  return [`${key}:`, ...items.map((x) => `  - ${yamlQuote(x)}`)]
}

/** `.orgai/agents/<slug>.md`: frontmatter in a fixed key order, a blank line, the prompt and a trailing newline. */
export function serializeRole(role: TeamRoleDoc): string {
  const r = normalizeRole(role)
  const lines = ['---', `name: ${yamlQuote(r.name)}`, `description: ${yamlQuote(r.description)}`, ...listLines('responsibilities', r.responsibilities), ...listLines('tools', r.tools)]
  if (r.tier !== undefined) lines.push(`tier: ${yamlQuote(r.tier)}`)
  else lines.push(`model: ${yamlQuote(r.model ?? 'inherit')}`)
  if (r.effort !== undefined) lines.push(`effort: ${yamlQuote(r.effort)}`)
  lines.push(`canSpawn: ${r.canSpawn ? 'true' : 'false'}`)
  lines.push(...listLines('spawnable', r.spawnable))
  lines.push(`reportsTo: ${r.reportsTo === null ? 'null' : yamlQuote(r.reportsTo)}`)
  lines.push(`color: ${yamlQuote(r.color)}`)
  lines.push(...listLines('skills', r.skills))
  lines.push(...listLines('mcpServers', r.mcpServers))
  lines.push('---')
  return r.prompt === '' ? `${lines.join('\n')}\n` : `${lines.join('\n')}\n\n${r.prompt}\n`
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** `.orgai/team.json`: format, the settings in a fixed order, then disabledSkills (sorted names) when any skill is off. */
export function serializeTeamJson(doc: TeamDoc): string {
  const n = normalizeDoc(doc)
  const s: TeamSettingsDoc = n.settings
  const out: Record<string, unknown> = { format: TEAM_FILES_FORMAT, brief: s.brief, permissionMode: s.permissionMode }
  const set = (k: keyof TeamSettingsDoc): void => {
    if (s[k] !== undefined) out[k] = s[k]
  }
  set('maxBudgetUsd')
  set('maxSubagentDepth')
  set('maxConcurrentSubagents')
  set('maxWindowShare')
  set('preferEverydayNearLimit')
  set('isolateWriters')
  set('reviewMerges')
  set('autoContinue')
  set('maxAutoContinues')
  set('runMessaging')
  if (s.teamReview) out.teamReview = { auto: s.teamReview.auto, everyRuns: s.teamReview.everyRuns, tokenBudget: s.teamReview.tokenBudget }
  if (s.skillEvaluation) out.skillEvaluation = { ...(s.skillEvaluation.enabled !== undefined ? { enabled: s.skillEvaluation.enabled } : {}), tokenBudget: s.skillEvaluation.tokenBudget }
  const disabled = n.skills.filter((k) => !k.enabled).map((k) => k.name)
  if (disabled.length) out.disabledSkills = disabled
  return json(out)
}

function mcpEntry(m: TeamMcpDoc): Record<string, unknown> {
  return {
    name: m.name,
    transport: m.transport,
    command: m.command,
    args: m.args,
    env: m.env,
    secretEnv: m.secretEnv,
    url: m.url,
    headers: m.headers,
    secretHeaders: m.secretHeaders,
    description: m.description,
    enabled: m.enabled,
    roles: m.roles,
    connectorId: m.connectorId,
    connectorVariant: m.connectorVariant,
    fromLibrary: m.fromLibrary,
    registry: m.registry ? { name: m.registry.name, version: m.registry.version, registryType: m.registry.registryType, identifier: m.registry.identifier } : undefined
  }
}

/** `.orgai/mcp.json`, or null when there are no servers (the file is then absent). */
export function serializeMcpJson(mcp: TeamMcpDoc[]): string | null {
  if (mcp.length === 0) return null
  const sorted = normalizeDoc({ settings: { brief: '', permissionMode: 'default' }, roles: [], skills: [], mcp }).mcp
  return json({ format: TEAM_FILES_FORMAT, servers: sorted.map(mcpEntry) })
}

/** The files of one skill: SKILL.md (name, description, body) and the other files, text with LF or base64. */
export function serializeSkill(skill: TeamSkillDoc): TeamFile[] {
  const base = `${TEAM_FILES_SKILLS_DIR}/${skill.name}`
  const files: TeamFile[] = [{ path: `${base}/SKILL.md`, data: Buffer.from(composeSkillMd({ name: skill.name, description: skill.description, body: normalizeText(skill.body).trim() }), 'utf8') }]
  for (const f of [...skill.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    files.push({ path: `${base}/${f.path}`, data: f.base64 !== undefined ? Buffer.from(f.base64, 'base64') : Buffer.from(normalizeText(f.text ?? ''), 'utf8') })
  }
  return files
}

/** Every file of the team, folder-relative paths. */
export function serializeTeam(doc: TeamDoc): TeamFile[] {
  const n = normalizeDoc(doc)
  const files: TeamFile[] = [{ path: TEAM_FILES_JSON, data: Buffer.from(serializeTeamJson(n), 'utf8') }]
  for (const r of n.roles) files.push({ path: `${TEAM_FILES_AGENTS_DIR}/${r.slug}.md`, data: Buffer.from(serializeRole(r), 'utf8') })
  const mcp = serializeMcpJson(n.mcp)
  if (mcp !== null) files.push({ path: TEAM_FILES_MCP_JSON, data: Buffer.from(mcp, 'utf8') })
  for (const s of n.skills) files.push(...serializeSkill(s))
  return files
}
