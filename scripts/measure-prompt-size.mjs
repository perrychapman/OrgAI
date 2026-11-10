#!/usr/bin/env node
// Token-free measurement of what an OrgAI agent is given before it does anything: the system prompt (role text plus
// the harness paragraphs) and the harness tool definitions, for the default code project, on the Claude and Codex
// adapters. No network, no Electron, no credentials. Tokens are approximate (chars / 4).
//
//   node scripts/measure-prompt-size.mjs            Markdown report on stdout
//   node scripts/measure-prompt-size.mjs --json     the same numbers as JSON
//
// Claude numbers come from the real exports buildAgents (claude.ts), buildRolePrompt (prompts.ts) and harnessToolsFor
// (harnessTools.ts). Codex numbers come from the real CodexAdapter driven against an in-memory app-server: the
// thread/start request it sends (developerInstructions, dynamicTools) is measured as it left the adapter.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const jiti = require('jiti').createJiti(import.meta.url, { fsCache: false, alias: { '@shared': join(root, 'src/shared') } })
const load = (rel) => jiti.import(join(root, rel))
const asJson = process.argv.includes('--json')

const { newProject, singleRunProject } = await load('src/shared/defaults.ts')
const P = await load('src/main/runtime/prompts.ts')
const { harnessToolsFor } = await load('src/main/runtime/harnessTools.ts')
const { buildAgents } = await load('src/main/runtime/claude.ts')
const { CodexAdapter } = await load('src/main/runtime/codex.ts')
const { jsonSchemaOf } = await load('src/main/runtime/codexProtocol.ts')
const { obligationsFor } = await load('src/main/runtime/delegation.ts')
const { projectKindOf } = await load('src/shared/defaults.ts')

const approxTokens = (chars) => Math.round(chars / 4)
const ARCH = 'docs/ARCHITECTURE.md'
const BRIEF = 'Build a small web app for tracking tasks.'

// ---------- prompt segmentation ----------
// The totals are always the real builder's output. To name the paragraphs we look for the text each exported paragraph
// builder produces inside the finished prompt; whatever is left over is reported as "unattributed" so drift is visible.
function candidates(role, roles, project, flags, extra = []) {
  const kind = projectKindOf(project)
  const isRoot = role.reportsTo === null
  const reports = P.reportsOf(role, roles)
  const out = []
  const add = (label, text) => text && out.push({ label, text })
  add('role prompt', role.prompt.trim())
  if (role.responsibilities.length) add('role responsibilities', `Your responsibilities:\n${role.responsibilities.map((r) => `- ${r}`).join('\n')}`)
  if (reports.length) {
    const req = (obligationsFor(roles, flags.strictDelegation === true)[role.id] ?? []).map((id) => roles.find((r) => r.id === id)?.slug).filter(Boolean)
    add('reports list (delegation)', P.reportsText(reports, flags.bridgedRoles, flags.bridgeVia, req))
    add('orchestratorIsolationText', P.orchestratorIsolationText())
    add('networkLeadText', P.networkLeadText(reports))
  } else add('"no reports" line', 'You have no reports. Do the assigned work yourself and report back concisely when finished.')
  add('networkPeerText', P.networkPeerText())
  add('reportIsolationText', P.reportIsolationText(reports.some(P.canWrite)))
  if (project.setup?.architecturePath) {
    add('architectureText', P.architectureText(project.setup.architecturePath, kind))
    add('architectureDriftText', P.architectureDriftText(project.setup.architecturePath, kind))
  }
  add('unattendedText', P.unattendedText(kind, flags.team !== 'single'))
  add('singleAssistantText', P.singleAssistantText(kind))
  add('orgChangeText', P.orgChangeText())
  add('crossRunText', P.crossRunText())
  add('mcpInstallText(root)', P.mcpInstallText('root'))
  add('mcpInstallText(lead)', P.mcpInstallText('lead'))
  add('skillsConfigText', P.skillsConfigText())
  add('permissionRequestText', P.permissionRequestText())
  add('outputsText', P.outputsText())
  add('toolHygieneText', P.toolHygieneText())
  add('selfKnowledgeWorkText', P.selfKnowledgeWorkText())
  add('brief ("About this project")', P.briefText(project.brief))
  for (const e of extra) add(e.label, e.text)
  void isRoot
  return out
}

function segment(prompt, cands) {
  const hits = []
  for (const c of cands) {
    const at = prompt.indexOf(c.text)
    if (at >= 0 && !hits.some((h) => at < h.end && at + c.text.length > h.start)) hits.push({ ...c, start: at, end: at + c.text.length })
  }
  hits.sort((a, b) => a.start - b.start)
  const parts = []
  let pos = 0
  let glue = 0
  for (const h of hits) {
    const gap = prompt.slice(pos, h.start)
    if (gap.trim()) parts.push({ label: 'unattributed', chars: gap.length })
    else glue += gap.length
    parts.push({ label: h.label, chars: h.text.length })
    pos = h.end
  }
  const tail = prompt.slice(pos)
  if (tail.trim()) parts.push({ label: 'unattributed', chars: tail.length })
  else glue += tail.length
  if (glue) parts.push({ label: 'paragraph separators', chars: glue })
  const merged = new Map()
  for (const p of parts) merged.set(p.label, (merged.get(p.label) ?? 0) + p.chars)
  return [...merged].map(([label, chars]) => ({ label, chars })).sort((a, b) => b.chars - a.chars)
}

// ---------- cases ----------
const BASE_ROLES = ['orchestrator', 'implementer', 'reviewer', 'researcher']
function makeCase(slug, { isolation, arch }) {
  const base = newProject({ name: 'Measure', path: '/measure', brief: BRIEF })
  const stored = { ...base, isolateWriters: isolation, ...(arch ? { setup: { kind: 'existing', state: 'done', architecturePath: ARCH } } : {}) }
  if (slug === 'single') {
    const project = { ...singleRunProject(stored), isolateWriters: false }
    return { project, roleSlug: project.roles[0].slug, team: 'single', isolation: false }
  }
  return { project: stored, roleSlug: slug, team: undefined, isolation }
}
const variants = [
  { id: 'iso+arch', isolation: true, arch: true },
  { id: 'noiso+arch', isolation: false, arch: true },
  { id: 'iso+noarch', isolation: true, arch: false }
]
const caseList = []
for (const slug of BASE_ROLES) for (const v of variants) caseList.push({ slug, variant: v.id, ...v })
caseList.push({ slug: 'single', variant: 'arch', isolation: false, arch: true }, { slug: 'single', variant: 'noarch', isolation: false, arch: false })
const label = (c) => `${c.slug === 'orchestrator' ? 'team root (orchestrator)' : c.slug === 'implementer' ? 'writing report (implementer)' : c.slug === 'single' ? 'single assistant' : c.slug} [${c.variant}]`

// A RuntimeContext with no-op round-trips (the same fixture shape as testHelpers.fakeCtx, without vitest).
function ctxFor(project, team, dir) {
  const p = { ...project, path: dir }
  let plan
  const noop = async () => {}
  return {
    run: { id: 'run-1', projectId: p.id, kind: 'work', prompt: 'Do it', status: 'starting', startedAt: 0, totalCostUsd: 0, ...(team ? { team } : {}) },
    project: p, roles: p.roles, prompt: 'Do it', autoContinue: false,
    emit: () => {},
    requestPermission: async () => ({ behavior: 'allow' }), requestProposal: async () => ({ behavior: 'approve' }),
    requestMergeReview: async () => ({ behavior: 'merge' }), completeSetup: noop, requestQuestion: async () => ({ selected: [] }),
    noteArchitectureUpdated: noop, rateLimited: () => {}, getPlan: () => plan, updatePlan: async (next) => { plan = next },
    pendingInteractions: () => 0, mcpServers: () => [], resolvedMcpServers: async () => [], plugins: () => [],
    searchMcpRegistry: async () => ({ entries: [] }), requestMcpInstall: async () => ({ approved: true, scope: 'run' })
  }
}

// ---------- Claude ----------
function claudeCase(c) {
  const { project, roleSlug, team, isolation } = makeCase(c.slug, c)
  const ctx = ctxFor(project, team, '/measure')
  const harness = harnessToolsFor(ctx, {}, { nativeSkills: true })
  const agents = buildAgents(ctx, harness, isolation)
  const role = ctx.roles.find((r) => r.slug === roleSlug)
  const def = agents[roleSlug]
  const isRoot = role.reportsTo === null
  const flags = { isSetup: false, isolation, ...(team ? { team } : {}) }
  const parts = segment(def.prompt, candidates(role, ctx.roles, project, flags))
  const given = harness.filter((t) => isRoot || t.audience === 'all' || (role.canSpawn && t.audience === 'spawners'))
  const tools = given.map((t) => ({ name: `mcp__orgai__${t.name}`, chars: JSON.stringify({ name: `mcp__orgai__${t.name}`, description: t.description, inputSchema: jsonSchemaOf(t.inputSchema) }).length, descriptionChars: t.description.length }))
  const agentDesc = isRoot ? Object.values(agents).filter((a) => a !== def).reduce((n, a) => n + a.description.length, 0) + ctx.roles.filter((r) => r.reportsTo !== null).reduce((n, r) => n + r.slug.length, 0) : 0
  return finish('claude', c, { promptChars: def.prompt.length, parts, tools, agentDescChars: agentDesc })
}

// ---------- Codex ----------
class FakeServer {
  requests = []
  handlers = { n: [], r: undefined, x: [] }
  options
  threads = 0
  constructor(options) {
    this.options = options
    this.exited = new Promise(() => {})
  }
  async start() { return {} }
  async request(method, params) {
    this.requests.push({ method, params })
    if (method === 'thread/start') return { thread: { id: `th-${++this.threads}` }, model: 'gpt-test', cwd: params?.cwd }
    if (method === 'turn/start') return { turn: { id: `tu-${this.requests.length}` } }
    return {}
  }
  notify() {}
  onNotification(h) { this.handlers.n.push(h); return () => {} }
  onServerRequest(h) { this.handlers.r = h }
  onExit(h) { this.handlers.x.push(h); return () => {} }
  close() {}
  ask(method, params) { return this.handlers.r(method, params) }
  of(method) { return this.requests.filter((r) => r.method === method) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, what) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(25) }
  throw new Error(`timed out waiting for ${what}`)
}

async function codexCase(c, dirs) {
  const { project, roleSlug, team, isolation } = makeCase(c.slug, c)
  const dir = isolation ? dirs.git : dirs.plain
  const ctx = ctxFor(project, team, dir)
  const servers = []
  const adapter = new CodexAdapter({ createServer: (o) => { const s = new FakeServer(o); servers.push(s); return s } })
  const session = await adapter.start(ctx)
  try {
    await until(() => servers[0]?.of('turn/start').length >= 1, 'root turn/start')
    const s = servers[0]
    const role = ctx.roles.find((r) => r.slug === roleSlug)
    let start
    if (role.reportsTo === null) start = s.of('thread/start')[0].params
    else {
      // A report's thread is built when the root spawns it (the adapter's own spawn_report path).
      const res = await s.ask('item/tool/call', { threadId: 'th-1', turnId: 'tu-1', callId: 'c-spawn', namespace: null, tool: 'spawn_report', arguments: { role: roleSlug, brief: 'x' } })
      if (!res?.success) throw new Error(`spawn_report failed: ${JSON.stringify(res)}`)
      await until(() => s.of('thread/start').length >= 2, 'report thread/start')
      start = s.of('thread/start')[1].params
    }
    const instr = start.developerInstructions
    const isRoot = role.reportsTo === null
    const flags = { isSetup: false, isolation, ...(team ? { team } : {}) }
    const notesAt = instr.indexOf('\n\nCodex notes:')
    const extra = notesAt >= 0 ? [{ label: 'Codex notes (tool-name mapping)', text: instr.slice(notesAt + 2) }] : []
    const parts = segment(instr, candidates(role, ctx.roles, project, flags, extra))
    const tools = start.dynamicTools.map((t) => ({ name: t.name, chars: JSON.stringify(t).length, descriptionChars: t.description.length }))
    void isRoot
    return finish('codex', c, { promptChars: instr.length, parts, tools, agentDescChars: 0 })
  } finally {
    await session.stop()
  }
}

function finish(adapter, c, { promptChars, parts, tools, agentDescChars }) {
  const toolsChars = tools.reduce((n, t) => n + t.chars, 0)
  const totalChars = promptChars + toolsChars + agentDescChars
  return {
    case: label(c), slug: c.slug, variant: c.variant, adapter,
    promptChars, toolsChars, agentDescChars, totalChars, approxTokens: approxTokens(totalChars),
    toolCount: tools.length,
    promptParts: parts,
    tools: [...tools].sort((a, b) => b.chars - a.chars)
  }
}

// ---------- run ----------
const plain = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-measure-plain-')))
const git = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-measure-git-')))
const rows = []
try {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'm', GIT_AUTHOR_EMAIL: 'm@example.invalid', GIT_COMMITTER_NAME: 'm', GIT_COMMITTER_EMAIL: 'm@example.invalid' }
  execFileSync('git', ['init', '-q'], { cwd: git, env })
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: git, env })
  for (const c of caseList) {
    rows.push(claudeCase(c))
    rows.push(await codexCase(c, { plain, git }))
  }
} finally {
  rmSync(plain, { recursive: true, force: true })
  rmSync(git, { recursive: true, force: true })
}

if (asJson) {
  process.stdout.write(JSON.stringify({ approximation: 'tokens = chars / 4', project: 'newProject() default code project', rows }, null, 2) + '\n', () => process.exit(0))
  await new Promise(() => {}) // the write callback exits once stdout has drained
}

// ---------- report ----------
const n = (x) => x.toLocaleString('en-US')
const NUMERIC = /chars|tokens|#|%/
const table = (head, body) => [`| ${head.join(' | ')} |`, `| ${head.map((h) => (NUMERIC.test(h) ? '---:' : '---')).join(' | ')} |`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n')
const out = []
out.push('# Prompt size report', '')
out.push(`Default code project (\`newProject\`, brief of ${BRIEF.length} chars). Variants: \`iso\` = writer isolation on, \`arch\` = \`setup.architecturePath\` set. Tokens are approximate (chars / 4); they are not a tokenizer count.`)
out.push('Prompt = the role system prompt exactly as the adapter builds it. Tools = harness tools given to that role (name + description + input schema as JSON; Claude names carry the `mcp__orgai__` prefix). Agent desc = the report descriptions the Claude root sees (Claude only; the Codex root has them in its prompt reports list instead).', '')
out.push('## Summary', '')
out.push(table(['case', 'adapter', 'prompt chars', 'tools chars', 'tools #', 'agent desc chars', 'total chars', '~tokens'], rows.map((r) => [r.case, r.adapter, n(r.promptChars), n(r.toolsChars), String(r.toolCount), n(r.agentDescChars), n(r.totalChars), n(r.approxTokens)])))
out.push('')
out.push('## Per case (baseline variants: contributors by size)', '')
const detail = rows.filter((r) => r.variant === 'iso+arch' || r.slug === 'single' && r.variant === 'arch')
for (const slug of [...BASE_ROLES, 'single']) {
  for (const r of detail.filter((x) => x.slug === slug)) {
    out.push(`### ${r.case}, ${r.adapter}`, '')
    const items = [
      ...r.promptParts.map((p) => ({ kind: 'prompt', name: p.label, chars: p.chars })),
      ...r.tools.map((t) => ({ kind: 'tool', name: t.name, chars: t.chars })),
      ...(r.agentDescChars ? [{ kind: 'agents', name: 'report descriptions the root sees', chars: r.agentDescChars }] : [])
    ].sort((a, b) => b.chars - a.chars)
    out.push(`Total ${n(r.totalChars)} chars (~${n(r.approxTokens)} tokens): prompt ${n(r.promptChars)}, tools ${n(r.toolsChars)}${r.agentDescChars ? `, agent desc ${n(r.agentDescChars)}` : ''}.`, '')
    out.push(table(['kind', 'contributor', 'chars', '~tokens', '% of total'], items.map((i) => [i.kind, `\`${i.name}\``, n(i.chars), n(approxTokens(i.chars)), `${((100 * i.chars) / r.totalChars).toFixed(1)}%`])))
    out.push('')
  }
}
out.push('## Team root: three largest paragraphs and tools per adapter (baseline iso+arch)', '')
for (const adapter of ['claude', 'codex']) {
  const r = rows.find((x) => x.slug === 'orchestrator' && x.variant === 'iso+arch' && x.adapter === adapter)
  const paras = r.promptParts.filter((p) => p.label !== 'paragraph separators').slice(0, 3)
  out.push(`### ${adapter}`, '')
  out.push(table(['rank', 'kind', 'name', 'chars', '~tokens'], [
    ...paras.map((p, i) => [String(i + 1), 'paragraph', `\`${p.label}\``, n(p.chars), n(approxTokens(p.chars))]),
    ...r.tools.slice(0, 3).map((t, i) => [String(i + 1), 'tool', `\`${t.name}\``, n(t.chars), n(approxTokens(t.chars))])
  ]))
  out.push('')
}
out.push('## Not measured', '')
out.push('- The vendor CLI\'s own system prompt and its built-in tool definitions (Claude Code preset prompt, Read/Edit/Bash/Agent schemas; Codex built-in tools): not in this repo, so not counted. Real calls carry them on top of these numbers.')
out.push('- Claude tool schemas use the same `z.toJSONSchema` conversion as the Codex adapter (`jsonSchemaOf`); the Claude SDK converts the zod shape itself, so its exact bytes can differ slightly.')
out.push('- Run-specific text that is absent from a bare default run: allowed/reference folders, skills, engagement document, knowledge brief, bridged roles, MCP servers.')
process.stdout.write(out.join('\n') + '\n', () => process.exit(0))
