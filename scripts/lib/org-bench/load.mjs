// Loads the REAL setup code from the TypeScript source (jiti, the '@shared' alias; no Electron, no build) and assembles, for
// one scenario, everything a benchmark session needs: the Architect's system prompt, the setup tools bound to a fake
// RuntimeContext, and the first user message. A prompt, schema or composer edit therefore changes what the benchmark measures.
//
// Real (imported): architectPrompt / architectRole (src/shared/setup.ts), buildRolePrompt and composeFirstMessage
// (src/main/runtime/prompts.ts), harnessToolsFor and with it every setup tool's name, description, zod schema and handler,
// including propose_org_chart's validation through the unexported rolesFromDrafts (src/main/runtime/harnessTools.ts),
// SetupService.hiddenContext / displayPrompt / retroPrompt / retroContext (src/main/setup/service.ts), profileRepo and
// renderProfile (src/main/setup/profile.ts), newProject (src/shared/defaults.ts) and toRoles (src/main/ai/draft.ts).
//
// MIRRORS (restated here, because the source keeps them private or inside an Electron-bound class):
//  - the Architect agent definition that ClaudeSession's buildOptions passes (`agents` plus `agent`, tools = the role's tools
//    plus the mcp__orgai__ names, model 'inherit'): src/main/runtime/claude.ts buildAgents / buildOptions. claude.ts itself
//    is not imported (it loads the whole adapter).
//  - the in-process MCP server: claude.ts buildHarnessServer is restated in session.mjs (name 'orgai', tool names
//    mcp__orgai__<name>), without its caller tracking.
//  - the run record the retro scenarios expand into (RunRecord) is built here from a compact spec; the condenser that reads
//    it (SetupService.retroContext) is the real one.
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const require = createRequire(import.meta.url)

/** Imports every real module the benchmark uses. Throws with the failing path when one cannot be loaded. */
export async function loadSource(root = REPO_ROOT) {
  const jiti = require('jiti').createJiti(import.meta.url, { fsCache: false, alias: { '@shared': join(root, 'src/shared') } })
  const load = async (rel) => {
    try {
      return await jiti.import(join(root, rel))
    } catch (e) {
      throw new Error(`could not import ${rel}: ${e?.message ?? e}`)
    }
  }
  const [setup, defaults, types, prompts, harness, service, profile, draft] = await Promise.all([
    load('src/shared/setup.ts'),
    load('src/shared/defaults.ts'),
    load('src/shared/types.ts'),
    load('src/main/runtime/prompts.ts'),
    load('src/main/runtime/harnessTools.ts'),
    load('src/main/setup/service.ts'),
    load('src/main/setup/profile.ts'),
    load('src/main/ai/draft.ts')
  ])
  return { setup, defaults, types, prompts, harness, service, profile, draft }
}

/** Writes a scenario's fixture files (relative paths, forward slashes) into dir. */
export function writeFixture(dir, files = {}) {
  for (const [rel, text] of Object.entries(files)) {
    const file = join(dir, ...rel.split('/'))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
}

/**
 * Removes a session folder without ever throwing (Windows: a child process can still hold it, EBUSY). Retries a few times
 * with a short delay, then leaves the folder. Returns null on success or a note for the session record.
 * `remove` and `sleep` are injectable for tests.
 */
export function cleanupDir(dir, { remove = (d) => rmSync(d, { recursive: true, force: true }), tries = 5, delayMs = 400, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      remove(dir)
      return null
    } catch (e) {
      last = e
      if (i < tries - 1) sleep(delayMs)
    }
  }
  return `could not remove ${dir} after ${tries} tries (${String(last?.message ?? last).slice(0, 120)}); folder left in place`
}

/**
 * Makes dir a git repository with one commit of everything in it (fixed author, committer and dates so runs are reproducible).
 * Returns { ok, note }; when git is unavailable or a step fails, ok is false and the note says why (the session still runs).
 */
export function initGitRepo(dir) {
  const stamp = '2024-01-01T00:00:00Z'
  const env = {
    ...process.env, GIT_AUTHOR_NAME: 'Bench', GIT_AUTHOR_EMAIL: 'bench@example.invalid', GIT_COMMITTER_NAME: 'Bench',
    GIT_COMMITTER_EMAIL: 'bench@example.invalid', GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null'
  }
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Initial commit']]) {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' })
    if (r.error || r.status !== 0) return { ok: false, note: `git ${args[0]} failed: ${r.error?.message ?? (r.stderr || '').trim()}` }
  }
  return { ok: true, note: 'git repository with one commit' }
}

/** The compact `run` spec of a retro scenario as a RunRecord (only the fields SetupService.retroContext reads). */
export function buildRunRecord(spec, project, now = 1_700_000_000_000) {
  const bySlug = new Map(project.roles.map((r) => [r.slug, r]))
  const byId = new Map(project.roles.map((r) => [r.id, r]))
  const agents = {}
  const idOf = (slug) => `agent-${slug}`
  for (const a of spec.agents) {
    const role = bySlug.get(a.slug)
    if (!role) throw new Error(`run spec names an agent for unknown role ${a.slug}`)
    const parent = role.reportsTo ? byId.get(role.reportsTo) : null
    agents[idOf(a.slug)] = {
      id: idOf(a.slug), name: role.name, roleSlug: role.slug, model: role.model,
      parentId: parent ? idOf(parent.slug) : null,
      state: a.state ?? 'done', inputTokens: a.inputTokens ?? 0, outputTokens: a.outputTokens ?? 0, costUsd: a.costUsd ?? 0,
      ...(a.result ? { result: a.result } : {}),
      ...(a.worktree ? { worktree: { status: a.worktree.status, changedFiles: Array.from({ length: a.worktree.files ?? 0 }, (_, i) => `file-${i + 1}`) } } : {})
    }
  }
  const root = project.roles.find((r) => r.reportsTo === null)
  const transcript = [{ agentId: idOf(root.slug), block: { kind: 'user', text: spec.task } }]
  for (const text of spec.userTurns ?? []) transcript.push({ agentId: idOf(root.slug), block: { kind: 'user', text } })
  for (let i = 0; i < (spec.deniedToolResults ?? 0); i++) transcript.push({ agentId: idOf('tester'), block: { kind: 'tool_result', isError: true } })
  if (spec.finalReport) transcript.push({ agentId: idOf(root.slug), block: { kind: 'text', text: spec.finalReport } })
  const minutes = spec.minutes ?? 10
  return {
    summary: { id: 'run-retro-1', kind: 'work', status: spec.status ?? 'done', startedAt: now, endedAt: now + minutes * 60_000, totalCostUsd: spec.costUsd ?? 0, prompt: spec.task, ...(spec.error ? { error: spec.error } : {}) },
    agents, transcript, logs: (spec.logs ?? []).map((l, i) => ({ at: now + i, level: l.level, message: l.message }))
  }
}

export const RETRO_NUDGE = 'Go ahead: propose the changes the run record calls for with propose_org_chart (only the roles that change), or if nothing needs to change say so in one line and call complete_setup. Use your judgment for anything else.'

/**
 * Everything one session needs. `dir` is the (already created) temp working directory; fixture files are written into it.
 * Returns { project, architect, system, firstMessage, tools (real bound HarnessTools), ctx, probe } where `probe` is the
 * object the fake context writes proposals and completions into.
 */
export async function buildCase(src, scenario, dir) {
  const { setup: S, defaults: D, prompts: P, harness: H, service: SV, profile: PR, draft: DR } = src
  writeFixture(dir, scenario.files)
  const git = scenario.git ? initGitRepo(dir) : null
  const kind = scenario.kind
  const retro = scenario.family === 'retro'
  // A neutral project name: the scenario title would name the planted defect.
  const base = D.newProject({ name: `bench-${scenario.id}`, path: dir, brief: scenario.brief, setupKind: scenario.setupKind, kind })
  const profile = await PR.profileRepo(dir, kind)
  let project
  if (retro) {
    // The chart as it stands after setup: real toRoles on the drafts (ids, slugs, tiers on the anthropic builtins, layout).
    const roles = DR.toRoles({ rationale: 'benchmark chart', roles: scenario.chart })
    project = {
      ...base,
      roles,
      setup: {
        kind: scenario.setupKind, state: 'complete', profile, architecturePath: '.orgai/ARCHITECTURE.md',
        architecture: { summary: scenario.architectureSummary ?? scenario.brief, stack: [], modules: [], conventions: [], commands: [], risks: [] }
      }
    }
  } else {
    project = { ...base, setup: { kind: scenario.setupKind, state: 'in_progress', profile } }
  }
  const service = new SV.SetupService(undefined, {})
  let prompt, hidden
  if (retro) {
    const record = buildRunRecord(scenario.run, project)
    prompt = service.retroPrompt(record)
    hidden = `${service.hiddenContext(project)}\n\n${service.retroContext(record, project)}`
  } else {
    prompt = service.displayPrompt(project)
    hidden = service.hiddenContext(project)
  }
  const firstMessage = P.composeFirstMessage(prompt, hidden)

  const architect = S.architectRole(undefined, { kind })
  const system = P.buildRolePrompt(architect, [architect], project, { isSetup: true, isolation: false })

  const probe = { proposals: [], completions: [] }
  const ctx = {
    run: { id: 'run-bench', projectId: project.id, kind: 'setup', prompt, status: 'running', startedAt: 0, totalCostUsd: 0 },
    project, roles: [architect], prompt,
    // A proposal is "approved" at once; the session driver decides what that means (it captures the first valid chart).
    requestProposal: async (req) => { probe.proposals.push(req); return { behavior: 'approve' } },
    requestQuestion: async () => ({ selected: [], text: 'No preference, use your judgment.' }),
    completeSetup: async (summary) => { probe.completions.push(summary) },
    emit: () => {}
  }
  const tools = H.harnessToolsFor(ctx, { onDecided: () => {} })
  return { git, project, architect, system, firstMessage, tools, ctx, probe, prompt, hidden, instructions: H.SETUP_TOOLS_INSTRUCTIONS, decisionText: H.decisionText }
}
