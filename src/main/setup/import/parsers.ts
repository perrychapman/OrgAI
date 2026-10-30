import type { AgentImportSource, Effort, ModelTier } from '@shared/types'
import { parseFrontmatter, parseYamlDoc, type FmValue } from './frontmatter'
import { parseJsonc } from './jsonc'
import { parseToml } from './toml'
import { rooGroupTools } from './tools'
import { IMPORT_LIMITS, type ImportedAgent, type ParseResult } from './types'

/**
 * One small parser per agent definition format. They read untrusted text, never throw and never evaluate
 * anything: a bad file becomes a warning "<file>: <reason>".
 */

const MAX_NAME = 80
const MAX_DESCRIPTION = 500
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']
const TIERS: readonly string[] = ['top', 'deep', 'everyday', 'fast']

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}
/** A comma string or a list as a string list. */
function strList(v: unknown): string[] | undefined {
  if (typeof v === 'string') {
    const l = v.split(',').map((s) => s.trim()).filter(Boolean)
    return l
  }
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean)
  return undefined
}
function baseName(file: string, ...suffixes: string[]): string {
  const b = file.split('/').pop() ?? file
  for (const s of suffixes) if (b.toLowerCase().endsWith(s)) return b.slice(0, b.length - s.length)
  const dot = b.lastIndexOf('.')
  return dot > 0 ? b.slice(0, dot) : b
}
function isEffort(v: unknown): v is Effort {
  return typeof v === 'string' && EFFORTS.includes(v)
}
function firstSentence(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ')
  const m = /^.*?[.!?](\s|$)/.exec(t)
  return (m ? m[0] : t).trim()
}

interface Draft {
  source: AgentImportSource
  file: string
  name: string
  slug?: string
  description?: string
  prompt?: string
  model?: string
  effort?: Effort
  tools?: string[]
  deniedTools?: string[]
  canSpawn?: boolean
  color?: string
  responsibilities?: string[]
  reportsTo?: string | null
  spawnable?: string[]
  tier?: ModelTier
  primary?: boolean
  notes?: string[]
}

/** Trims, caps and fills defaults. */
function finish(d: Draft): ImportedAgent {
  const notes = [...(d.notes ?? [])]
  let prompt = (d.prompt ?? '').trim()
  if (prompt.length > IMPORT_LIMITS.maxPromptChars) {
    prompt = prompt.slice(0, IMPORT_LIMITS.maxPromptChars)
    notes.push(`Prompt cut to ${IMPORT_LIMITS.maxPromptChars.toLocaleString('en-US')} characters`)
  }
  const a: ImportedAgent = {
    source: d.source,
    file: d.file,
    name: d.name.trim().slice(0, MAX_NAME),
    description: (d.description ?? '').trim().slice(0, MAX_DESCRIPTION),
    prompt,
    notes
  }
  if (d.slug) a.slug = d.slug.trim().slice(0, MAX_NAME)
  if (d.model) a.model = d.model.trim()
  if (d.effort) a.effort = d.effort
  if (d.tools) a.tools = d.tools
  if (d.deniedTools && d.deniedTools.length) a.deniedTools = d.deniedTools
  if (d.canSpawn !== undefined) a.canSpawn = d.canSpawn
  if (d.color) a.color = d.color.trim()
  if (d.responsibilities) a.responsibilities = d.responsibilities
  if (d.reportsTo !== undefined) a.reportsTo = d.reportsTo
  if (d.spawnable) a.spawnable = d.spawnable
  if (d.tier) a.tier = d.tier
  if (d.primary) a.primary = true
  return a
}

function one(a: Draft, warnings: string[] = []): ParseResult {
  return { agents: [finish(a)], warnings }
}
function none(file: string, reason: string): ParseResult {
  return { agents: [], warnings: [`${file}: ${reason}`] }
}
function guard(file: string, fn: () => ParseResult): ParseResult {
  try {
    return fn()
  } catch (err) {
    return none(file, err instanceof Error ? err.message : 'could not be parsed')
  }
}

// ---------- OrgAI export ----------

export function parseOrgExport(text: string, file: string): ParseResult {
  return guard(file, () => {
    const j = parseJsonc(text)
    if (j.error !== undefined) return none(file, `invalid JSON (${j.error})`)
    if (!isObj(j.value)) return none(file, 'not an OrgAI export')
    if (j.value.format !== 'orgai.org/1') return none(file, `unsupported export format "${String(j.value.format).slice(0, 40)}"`)
    const roles = j.value.roles
    if (!Array.isArray(roles)) return none(file, 'export has no roles list')
    const agents: ImportedAgent[] = []
    const warnings: string[] = []
    roles.forEach((r, i) => {
      if (!isObj(r)) { warnings.push(`${file}: role ${i + 1} is not an object, skipped`); return }
      const notes: string[] = []
      const slug = str(r.slug)
      const name = str(r.name) ?? slug
      if (!name) { warnings.push(`${file}: role ${i + 1} has no name, skipped`); return }
      const d: Draft = { source: 'orgai', file, name, slug, notes }
      const field = <T>(key: string, ok: (v: unknown) => T | undefined): T | undefined => {
        const v = r[key]
        if (v === undefined || v === null) return undefined
        const res = ok(v)
        if (res === undefined) notes.push(`Ignored "${key}": wrong type`)
        return res
      }
      d.description = field('description', (v) => (typeof v === 'string' ? v : undefined))
      d.prompt = field('prompt', (v) => (typeof v === 'string' ? v : undefined))
      d.model = field('model', (v) => (typeof v === 'string' ? v : undefined))
      d.color = field('color', (v) => (typeof v === 'string' ? v : undefined))
      d.canSpawn = field('canSpawn', (v) => (typeof v === 'boolean' ? v : undefined))
      d.tools = field('tools', (v) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined))
      d.responsibilities = field('responsibilities', (v) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined))
      d.spawnable = field('spawnable', (v) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined))
      const tier = field('tier', (v) => (typeof v === 'string' && TIERS.includes(v) ? (v as ModelTier) : undefined))
      if (tier) d.tier = tier
      const effort = field('effort', (v) => (isEffort(v) ? v : undefined))
      if (effort) d.effort = effort
      if (r.reportsTo === null) d.reportsTo = null
      else {
        const rt = field('reportsTo', (v) => (typeof v === 'string' ? v : undefined))
        if (rt !== undefined) d.reportsTo = rt
      }
      agents.push(finish(d))
    })
    return { agents, warnings }
  })
}

// ---------- Claude Code ----------

function fmNotes(data: Record<string, FmValue>, keys: string[]): string[] {
  return keys.filter((k) => data[k] !== undefined && data[k] !== null).map((k) => `Ignored "${k}" (not imported)`)
}

export function parseClaudeAgent(text: string, file: string): ParseResult {
  return guard(file, () => {
    const fm = parseFrontmatter(text)
    const warnings = fm.error ? [`${file}: frontmatter problem (${fm.error})`] : []
    const name = str(fm.data.name)
    if (!name) return { agents: [], warnings: [...warnings, `${file}: no name in the frontmatter, skipped`] }
    const d: Draft = { source: 'claude', file, name, description: str(fm.data.description), prompt: fm.body, notes: [] }
    d.tools = strList(fm.data.tools)
    d.deniedTools = strList(fm.data.disallowedTools)
    d.model = str(fm.data.model)
    d.color = str(fm.data.color)
    if (isEffort(fm.data.effort)) d.effort = fm.data.effort
    d.notes = fmNotes(fm.data, ['permissionMode', 'mcpServers', 'skills', 'hooks'])
    return one(d, warnings)
  })
}

// ---------- opencode ----------

function opencodeDenied(tools: unknown, permission: unknown): string[] {
  const denied: string[] = []
  if (isObj(tools)) for (const [k, v] of Object.entries(tools)) if (v === false || v === 'false') denied.push(k)
  if (isObj(permission)) {
    for (const [k, v] of Object.entries(permission)) {
      if (v === 'deny') denied.push(k)
      else if (isObj(v) && v['*'] === 'deny') denied.push(k)
    }
  }
  return denied
}

function opencodeDraft(file: string, name: string, o: Record<string, unknown>, prompt: string): Draft {
  const mode = str(o.mode)
  return {
    source: 'opencode',
    file,
    name,
    description: str(o.description),
    prompt,
    model: str(o.model),
    deniedTools: opencodeDenied(o.tools, o.permission),
    primary: mode === 'primary' || mode === 'all',
    notes: []
  }
}

export function parseOpencodeAgentMd(text: string, file: string): ParseResult {
  return guard(file, () => {
    const fm = parseFrontmatter(text)
    const warnings = fm.error ? [`${file}: frontmatter problem (${fm.error})`] : []
    const name = baseName(file, '.md')
    if (!name) return { agents: [], warnings: [...warnings, `${file}: no agent name`] }
    if (fm.data.disable === true) return { agents: [], warnings: [...warnings, `${file}: agent "${name}" is disabled, skipped`] }
    return one(opencodeDraft(file, name, fm.data, fm.body), warnings)
  })
}

export function parseOpencodeConfig(text: string, file: string, readRelative: (relPath: string) => string | null): ParseResult {
  return guard(file, () => {
    const j = parseJsonc(text)
    if (j.error !== undefined) return none(file, `invalid JSON (${j.error})`)
    if (!isObj(j.value)) return none(file, 'not a config object')
    const agentMap = j.value.agent
    if (agentMap === undefined) return { agents: [], warnings: [] }
    if (!isObj(agentMap)) return none(file, '"agent" is not an object')
    const agents: ImportedAgent[] = []
    const warnings: string[] = []
    for (const [key, v] of Object.entries(agentMap)) {
      if (!isObj(v)) { warnings.push(`${file}: agent "${key}" is not an object, skipped`); continue }
      if (v.disable === true) { warnings.push(`${file}: agent "${key}" is disabled, skipped`); continue }
      let prompt = ''
      const p = typeof v.prompt === 'string' ? v.prompt : ''
      const ref = /^\s*\{file:([^}]+)\}\s*$/.exec(p)
      if (ref) {
        const body = readRelative(ref[1].trim())
        if (body === null) warnings.push(`${file}: agent "${key}": prompt file ${ref[1].trim()} could not be read, prompt left empty`)
        else prompt = body
      } else prompt = p
      agents.push(finish(opencodeDraft(file, key, v, prompt)))
    }
    return { agents, warnings }
  })
}

// ---------- Codex ----------

const CODEX_EFFORT: Record<string, Effort> = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' }

export function parseCodexAgent(text: string, file: string): ParseResult {
  return guard(file, () => {
    const t = parseToml(text)
    const warnings = t.error ? [`${file}: TOML problem (${t.error})`] : []
    const d = t.data
    const name = str(d.name) ?? baseName(file, '.toml')
    const draft: Draft = { source: 'codex', file, name, description: str(d.description), prompt: str(d.developer_instructions), model: str(d.model), notes: [] }
    const eff = str(d.model_reasoning_effort)
    if (eff) {
      const mapped = CODEX_EFFORT[eff.toLowerCase()]
      if (mapped) draft.effort = mapped
      else draft.notes!.push(`Ignored reasoning effort "${eff.slice(0, 20)}"`)
    }
    if (isObj(d.features) && d.features.shell_tool === false) draft.deniedTools = ['bash']
    if (!draft.prompt && t.error && !d.name) return { agents: [], warnings }
    return one(draft, warnings)
  })
}

// ---------- Copilot, Gemini, Kiro (markdown) ----------

function mdAgent(source: AgentImportSource, text: string, file: string, fallbackName: string, ignored: string[]): ParseResult {
  const fm = parseFrontmatter(text)
  const warnings = fm.error ? [`${file}: frontmatter problem (${fm.error})`] : []
  const d: Draft = {
    source,
    file,
    name: str(fm.data.name) ?? fallbackName,
    description: str(fm.data.description),
    prompt: fm.body,
    model: str(fm.data.model),
    tools: strList(fm.data.tools),
    notes: fmNotes(fm.data, ignored)
  }
  return one(d, warnings)
}

export function parseCopilotAgent(text: string, file: string): ParseResult {
  return guard(file, () => mdAgent('copilot', text, file, baseName(file, '.agent.md', '.md'), ['mcp-servers', 'handoffs', 'target']))
}

export function parseGeminiAgent(text: string, file: string): ParseResult {
  return guard(file, () => mdAgent('gemini', text, file, baseName(file, '.md'), ['mcpServers', 'temperature', 'max_turns', 'timeout_mins']))
}

const KIRO_ALL = new Set(['*', '@builtin'])

export function parseKiroAgent(text: string, file: string, readRelative?: (relPath: string) => string | null): ParseResult {
  return guard(file, () => {
    if (file.toLowerCase().endsWith('.md')) return mdAgent('kiro', text, file, baseName(file, '.md'), ['mcpServers', 'hooks'])
    const j = parseJsonc(text)
    if (j.error !== undefined) return none(file, `invalid JSON (${j.error})`)
    if (!isObj(j.value)) return none(file, 'not an agent object')
    const o = j.value
    const warnings: string[] = []
    let prompt = str(o.prompt) ?? ''
    const ref = /^file:\/\/(.+)$/.exec(prompt)
    if (ref) {
      const body = readRelative ? readRelative(ref[1]) : null
      if (body === null) warnings.push(`${file}: prompt file ${ref[1].slice(0, 100)} could not be read, prompt left empty`)
      prompt = body ?? ''
    }
    let tools = strList(o.tools)
    if (tools && tools.some((x) => KIRO_ALL.has(x))) tools = undefined
    const d: Draft = {
      source: 'kiro',
      file,
      name: str(o.name) ?? baseName(file, '.json'),
      description: str(o.description),
      prompt,
      model: str(o.model),
      tools,
      notes: Object.keys(o).filter((k) => ['mcpServers', 'hooks', 'toolsSettings', 'resources'].includes(k)).map((k) => `Ignored "${k}" (not imported)`)
    }
    return one(d, warnings)
  })
}

// ---------- Roo Code ----------

export function parseRooModes(text: string, file: string): ParseResult {
  return guard(file, () => {
    const trimmed = text.replace(/^﻿/, '').trim()
    let doc: unknown
    if (trimmed.startsWith('{')) {
      const j = parseJsonc(trimmed)
      if (j.error !== undefined) return none(file, `invalid JSON (${j.error})`)
      doc = j.value
    } else {
      const y = parseYamlDoc(trimmed)
      if (y.error) return none(file, `invalid YAML (${y.error})`)
      doc = y.data
    }
    if (!isObj(doc) || !Array.isArray(doc.customModes)) return none(file, 'no customModes list')
    const agents: ImportedAgent[] = []
    const warnings: string[] = []
    doc.customModes.forEach((m, i) => {
      if (!isObj(m)) { warnings.push(`${file}: mode ${i + 1} is not an object, skipped`); return }
      const slug = str(m.slug)
      const name = str(m.name) ?? slug
      if (!name) { warnings.push(`${file}: mode ${i + 1} has no name, skipped`); return }
      const roleDef = str(m.roleDefinition) ?? ''
      const prompt = [roleDef, str(m.customInstructions) ?? ''].filter(Boolean).join('\n\n')
      const notes: string[] = []
      const d: Draft = {
        source: 'roo',
        file,
        name,
        slug,
        description: str(m.whenToUse) ?? str(m.description) ?? (roleDef ? firstSentence(roleDef) : ''),
        prompt,
        notes
      }
      if (Array.isArray(m.groups)) {
        d.tools = rooGroupTools(m.groups)
        for (const g of m.groups) {
          const gn = Array.isArray(g) ? g[0] : g
          if (gn === 'mcp') notes.push('MCP access is not imported; add servers in project settings')
          if (Array.isArray(g) && isObj(g[1]) && g[1].fileRegex) notes.push(`Edits were limited to files matching ${String(g[1].fileRegex).slice(0, 60)} in Roo`)
        }
      }
      agents.push(finish(d))
    })
    return { agents, warnings }
  })
}
