#!/usr/bin/env node
// Org chart benchmark: how well does OrgAI's setup Architect recommend an org chart (family "recommend"), and how well does
// it revise one after a run (family "retro", self-healing)? Design, rubric and limits: docs/design/org-chart-benchmark.md.
//
//   node scripts/bench-org-chart.mjs                       prints the plan and exits (no model, no network); same as --dry-run
//   node scripts/bench-org-chart.mjs --dry-run             the plan, plus the real prompt and tool sizes loaded through jiti
//   node scripts/bench-org-chart.mjs --model <id> ...      LIVE RUN: spends real tokens (one model session per scenario per repeat)
//   node scripts/bench-org-chart.mjs --score <results.json>            re-score a saved file with the current scorer (token-free)
//   node scripts/bench-org-chart.mjs --compare <a.json> <b.json>       score and family deltas between two saved files (token-free)
//
// Flags: --model <id> (required for a live run, no default), --repeat <n> (1), --scenario <id> (repeatable), --family
// recommend|retro|all (all), --max-usd <n> (5: no new session starts once the reported cost reaches it), --out <dir>
// (bench-results/org-chart/<UTC timestamp>), --label <text>, --timeout-sec <n> (300 per session), --max-turns <n> (30).
// Hidden: --self-check (imports the real source, validates canned charts, drives a scripted fake session; no network).
//
// Like scripts/smoke-staffing.mjs it calls the SDK `query` directly and inherits this shell's login. Like
// scripts/measure-prompt-size.mjs it loads the REAL TypeScript source through jiti with the '@shared' alias (no Electron).
// What is imported and what is mirrored: scripts/lib/org-bench/load.mjs.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SCENARIOS, scenarioById, scenariosOf } from './lib/org-bench/scenarios.mjs'
import { SCORER_VERSION, compareSummaries, rescore, scoreSession, summarize } from './lib/org-bench/score.mjs'
import { renderCompare, renderReport } from './lib/org-bench/report.mjs'
import { REPO_ROOT, buildCase, loadSource } from './lib/org-bench/load.mjs'
import { runSession } from './lib/org-bench/session.mjs'

export const DEFAULTS = { repeat: 1, maxUsd: 5, family: 'all', timeoutSec: 300, maxTurns: 30 }

export function parseArgs(argv) {
  const o = { dryRun: false, model: undefined, repeat: DEFAULTS.repeat, scenarios: [], family: DEFAULTS.family, maxUsd: DEFAULTS.maxUsd, out: undefined, label: undefined, score: undefined, compare: undefined, selfCheck: false, timeoutSec: DEFAULTS.timeoutSec, maxTurns: DEFAULTS.maxTurns }
  const need = (i, flag) => {
    if (i >= argv.length || argv[i].startsWith('--')) throw new Error(`${flag} needs a value`)
    return argv[i]
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--self-check') o.selfCheck = true
    else if (a === '--model') o.model = need(++i, a)
    else if (a === '--repeat') o.repeat = Number(need(++i, a))
    else if (a === '--scenario') o.scenarios.push(need(++i, a))
    else if (a === '--family') o.family = need(++i, a)
    else if (a === '--max-usd') o.maxUsd = Number(need(++i, a))
    else if (a === '--out') o.out = need(++i, a)
    else if (a === '--label') o.label = need(++i, a)
    else if (a === '--timeout-sec') o.timeoutSec = Number(need(++i, a))
    else if (a === '--max-turns') o.maxTurns = Number(need(++i, a))
    else if (a === '--score') o.score = need(++i, a)
    else if (a === '--compare') {
      o.compare = [need(++i, a), need(++i, a)]
    } else throw new Error(`unknown argument: ${JSON.stringify(a)}`)
  }
  if (!Number.isInteger(o.repeat) || o.repeat < 1 || o.repeat > 20) throw new Error('--repeat takes an integer from 1 to 20')
  if (!Number.isFinite(o.maxUsd) || o.maxUsd <= 0) throw new Error('--max-usd takes a positive number')
  if (!Number.isFinite(o.timeoutSec) || o.timeoutSec < 10) throw new Error('--timeout-sec takes a number of at least 10')
  if (!Number.isInteger(o.maxTurns) || o.maxTurns < 1) throw new Error('--max-turns takes a positive integer')
  if (!['recommend', 'retro', 'all'].includes(o.family)) throw new Error('--family takes recommend, retro or all')
  for (const id of o.scenarios) if (!scenarioById(id)) throw new Error(`unknown scenario ${JSON.stringify(id)}; known: ${SCENARIOS.map((s) => s.id).join(', ')}`)
  return o
}

/** The scenarios a run covers: --scenario ids (any family) or every scenario of --family. */
export function selectScenarios(o) {
  return o.scenarios.length ? o.scenarios.map((id) => scenarioById(id)) : scenariosOf(o.family)
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')

function gitShortSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'unknown'
  }
}

function readJson(file) {
  const p = resolve(file)
  if (!existsSync(p)) throw new Error(`no such file: ${file}`)
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`)
  }
}

function writeResults(outDir, results) {
  mkdirSync(outDir, { recursive: true })
  const scored = rescore(results, SCENARIOS)
  const summary = summarize(scored)
  writeFileSync(join(outDir, 'results.json'), JSON.stringify({ ...scored, summary }, null, 2))
  writeFileSync(join(outDir, 'report.md'), renderReport(scored, summary))
  return { scored, summary }
}

// ---------------------------------------------------------------- plan and dry run

function printPlan(o, scenarios) {
  const sessions = scenarios.length * o.repeat
  const live = !!o.model && !o.dryRun
  console.log('Org chart benchmark plan')
  console.log(`  mode:      ${live ? 'LIVE (spends real tokens)' : 'dry run (no model call, no network, no spend)'}`)
  console.log(`  model:     ${o.model ?? '(none: a live run requires --model <id>)'}`)
  console.log(`  scenarios: ${scenarios.length} (${scenarios.map((s) => s.id).join(', ')}) x repeat ${o.repeat} = ${sessions} sessions`)
  console.log(`  caps:      --max-usd ${o.maxUsd} (no new session starts once the reported cost reaches it), ${o.timeoutSec}s and ${o.maxTurns} turns per session`)
  console.log(`  output:    ${o.out ?? `bench-results/org-chart/<UTC timestamp>/`} (results.json, report.md); scorer version ${SCORER_VERSION}`)
  for (const s of scenarios) console.log(`    ${s.id.padEnd(3)} ${s.family.padEnd(9)} ${s.kind.padEnd(10)} ${s.setupKind.padEnd(8)} complexity ${s.complexity}  ${s.title}`)
  console.log(live ? '  Each session is a real model conversation; the cost is not known until it ends.' : '  A live run needs --model <id>; it spends real tokens (see docs/design/org-chart-benchmark.md "Spend").')
}

async function describeSource(scenarios) {
  const t0 = Date.now()
  const src = await loadSource()
  const { z } = await import('zod')
  console.log(`\nReal source loaded through jiti in ${Date.now() - t0} ms (no Electron):`)
  console.log(`  src/shared/setup.ts          architectPrompt('code') ${src.setup.architectPrompt('code').length} chars, architectPrompt('engagement') ${src.setup.architectPrompt('engagement').length} chars`)
  const rows = []
  for (const s of scenarios) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-bench-plan-')))
    try {
      const built = await buildCase(src, s, dir)
      rows.push({ s, built })
      const toolChars = built.tools.reduce((n, t) => n + JSON.stringify({ name: t.name, description: t.description, schema: z.toJSONSchema(t.inputSchema) }).length, 0)
      console.log(`  ${s.id.padEnd(3)} system prompt ${String(built.system.length).padStart(6)} chars (${built.system.trim().split(/\s+/).length} words), first message ${String(built.firstMessage.length).padStart(6)} chars, ${built.tools.length} tools ${toolChars} chars${s.family === 'retro' ? `, chart ${built.project.roles.length} roles` : ''}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const names = rows[0]?.built.tools.map((t) => `mcp__orgai__${t.name}`)
  if (names) console.log(`  tools given to the Architect: ${names.join(', ')}`)
}

// ---------------------------------------------------------------- live run

async function liveRun(o, scenarios) {
  const src = await loadSource()
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  const outDir = resolve(o.out ?? join('bench-results', 'org-chart', stamp()))
  const results = { tool: 'org-chart-benchmark', scorerVersion: SCORER_VERSION, label: o.label ?? null, model: o.model, repeat: o.repeat, maxUsd: o.maxUsd, family: o.family, gitSha: gitShortSha(), date: new Date().toISOString(), sessions: [] }
  let spent = 0
  console.log(`\nLive run: ${scenarios.length * o.repeat} sessions on ${o.model}; writing to ${outDir}`)
  for (const scenario of scenarios) {
    for (let repeat = 1; repeat <= o.repeat; repeat++) {
      if (spent >= o.maxUsd) {
        results.sessions.push({ family: scenario.family, scenarioId: scenario.id, repeat, model: o.model, kind: scenario.kind, complexity: scenario.complexity, status: 'skipped', errors: [`--max-usd ${o.maxUsd} reached`] })
        console.log(`  ${scenario.id} #${repeat}: skipped (reported cost $${spent.toFixed(2)} reached --max-usd ${o.maxUsd})`)
        continue
      }
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-bench-')))
      try {
        const built = await buildCase(src, scenario, dir)
        const rec = await runSession({ built, scenario, repeat, model: o.model, sdk, dir, maxTurns: o.maxTurns, timeoutMs: o.timeoutSec * 1000, maxBudgetUsd: Math.max(0.05, o.maxUsd - spent) })
        spent += rec.costUsd ?? 0
        results.sessions.push({ ...rec, score: scoreSession(rec, scenario) })
        const sc = results.sessions.at(-1).score
        console.log(`  ${scenario.id} #${repeat}: ${rec.status}, score ${sc.total.toFixed(1)}, ${rec.turns} turns, ${(rec.durationMs / 1000).toFixed(0)}s, $${(rec.costUsd ?? 0).toFixed(3)}${rec.errors.length ? `, errors: ${rec.errors.join('; ').slice(0, 120)}` : ''}`)
      } catch (e) {
        results.sessions.push({ family: scenario.family, scenarioId: scenario.id, repeat, model: o.model, kind: scenario.kind, complexity: scenario.complexity, status: 'error', errors: [String(e?.message ?? e).slice(0, 300)], costUsd: 0 })
        console.log(`  ${scenario.id} #${repeat}: error: ${String(e?.message ?? e).slice(0, 200)}`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      writeResults(outDir, results) // after every session, so an interrupted run keeps what it has
    }
  }
  const { summary } = writeResults(outDir, results)
  console.log(`\nDone. Reported spend $${summary.costUsd.toFixed(2)}. ${join(outDir, 'report.md')}`)
}

// ---------------------------------------------------------------- re-score and compare

function rescoreFile(file, o) {
  const saved = readJson(file)
  if (!Array.isArray(saved.sessions)) throw new Error(`${file} has no sessions array`)
  const outDir = resolve(o.out ?? join('bench-results', 'org-chart', `${stamp()}-rescore`))
  const { summary } = writeResults(outDir, { ...saved, label: o.label ?? saved.label ?? null })
  console.log(`Re-scored ${file} with scorer ${SCORER_VERSION} (it was ${saved.scorerVersion ?? 'unknown'}): ${summary.scored} scored, ${summary.skipped} skipped.`)
  for (const [family, f] of Object.entries(summary.families)) console.log(`  ${family}: mean ${f.meanTotal.toFixed(1)} / 100 over ${f.scenarios.length} scenarios`)
  console.log(`Report: ${join(outDir, 'report.md')}`)
}

function compareFiles([a, b]) {
  const sa = summarize(rescore(readJson(a), SCENARIOS))
  const sb = summarize(rescore(readJson(b), SCENARIOS))
  const name = (f) => readJson(f).label ?? f
  console.log(renderCompare(compareSummaries(sa, sb), [String(name(a)), String(name(b))]))
}

// ---------------------------------------------------------------- entry

async function main(argv) {
  const o = parseArgs(argv)
  if (o.selfCheck) {
    const { runSelfCheck } = await import('./lib/org-bench/selfcheck.mjs')
    return runSelfCheck()
  }
  if (o.score) return rescoreFile(o.score, o), 0
  if (o.compare) return compareFiles(o.compare), 0
  const scenarios = selectScenarios(o)
  const live = !!o.model && !o.dryRun
  printPlan(o, scenarios)
  if (!live) {
    await describeSource(scenarios)
    return 0
  }
  await liveRun(o, scenarios)
  return 0
}

function isEntry() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href
  }
}

if (isEntry()) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 2
  }
}
