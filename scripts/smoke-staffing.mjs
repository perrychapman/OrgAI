// Smoke for docs/design/orchestration-efficiency.md §2, §4.2, §4.3: per-spawn model and effort, parallel foreground
// spawns, one-shot latency. Spends real tokens (haiku; sonnet only where a check needs effort or a second model).
// About 12 short model sessions: checks 1-6 are one each, check 7 is 5 sequential one-shots. Run once, do not loop.
// Check 7 MIRRORS buildCompletionOptions in src/main/runtime/claude.ts (importing the adapter drags in Electron),
// minus the OrgAI env isolation (it inherits this shell's login).
// Usage: node scripts/smoke-staffing.mjs [1 2 3 4 5 6 7]   (default: all)
import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-smoke-staffing-')))
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
const want = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ['1', '2', '3', '4', '5', '6', '7'])
const results = []
let sessions = 0
const verdict = (id, v, evidence) => { results.push({ id, v, evidence }); console.log(`\n[${id}] ${v}: ${evidence}\n`) }
const env = { ...process.env, CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '2' }

// One session. `pre(input)` may return updatedInput for the Agent tool. Returns everything observed.
async function run(label, prompt, options, pre) {
  sessions++
  const t0 = Date.now()
  const ev = { label, pre: [], assistants: [], starts: [], stops: [], init: null, result: null, tasks: [], toolResults: [] }
  const stamp = () => Date.now() - t0
  const hooks = {
    PreToolUse: [{ hooks: [async (input) => {
      ev.pre.push({ t: stamp(), tool: input.tool_name, agent: input.agent_id ? input.agent_type : 'root', effort: input.effort?.level ?? null, input: input.tool_input })
      if (input.tool_name === 'Agent' && pre) return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, ...pre(input) } } }
      return {}
    }] }],
    SubagentStart: [{ hooks: [async (i) => (ev.starts.push({ t: stamp(), id: i.agent_id, type: i.agent_type }), {})] }],
    SubagentStop: [{ hooks: [async (i) => (ev.stops.push({ t: stamp(), id: i.agent_id }), {})] }]
  }
  console.log(`--- ${label}`)
  const abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort(), 90_000) // a hung session must not hang the script
  try {
    for await (const msg of query({ prompt, options: { cwd: dir, settingSources: [], env, maxTurns: 12, hooks, abortController, ...options } })) {
      if (msg.type === 'system' && msg.subtype === 'init') ev.init = { t: stamp(), model: msg.model }
      else if (msg.type === 'system' && msg.subtype.startsWith('task_')) ev.tasks.push({ t: stamp(), sub: msg.subtype, id: msg.task_id })
      else if (msg.type === 'assistant') ev.assistants.push({ t: stamp(), who: msg.parent_tool_use_id ? 'child' : 'root', model: msg.message.model, mid: msg.message.id, tools: msg.message.content.filter((b) => b.type === 'tool_use').map((b) => b.name) })
      else if (msg.type === 'user' && Array.isArray(msg.message.content)) { for (const b of msg.message.content) if (b.type === 'tool_result' && !msg.parent_tool_use_id) ev.toolResults.push({ t: stamp(), err: !!b.is_error, text: JSON.stringify(b.content).slice(0, 300) }) }
      else if (msg.type === 'result') ev.result = { t: stamp(), subtype: msg.subtype, cost: msg.total_cost_usd, models: Object.keys(msg.modelUsage ?? {}), text: (msg.result ?? '').slice(0, 120) }
    }
  } catch (e) { ev.error = String(e.message ?? e) }
  clearTimeout(timer)
  ev.wall = stamp()
  console.log(JSON.stringify({ init: ev.init, assistants: ev.assistants, pre: ev.pre.map((p) => ({ ...p, input: JSON.stringify(p.input).slice(0, 140) })), starts: ev.starts, stops: ev.stops, toolResults: ev.toolResults, result: ev.result, error: ev.error }))
  return ev
}

const childModels = (ev) => { const c = ev.assistants.filter((a) => a.who === 'child').map((a) => a.model); return [...new Set(c.length ? c : (ev.result?.models ?? []).filter((m) => m !== ev.init?.model))] }
const childEffort = (ev) => ev.pre.filter((p) => p.agent !== 'root' && p.tool !== 'Agent').map((p) => p.effort)
const agentCalls = (ev) => ev.pre.filter((p) => p.tool === 'Agent' && p.agent === 'root')
const authFail = (ev) => ev.error || ev.result?.subtype !== 'success'
const rootDef = (extra = {}) => ({
  description: 'Lead', prompt: 'You are the lead. Use the Agent tool as instructed, then answer in one short sentence.', tools: ['Agent'], model: 'haiku', ...extra
})
const base = { agent: 'lead', allowedTools: ['Agent', 'Bash'], permissionMode: 'dontAsk' }
const spawnPrompt = 'Spawn the agent "worker" with the Agent tool (subagent_type "worker", prompt "Run the Bash command `echo hi` and reply with the word done."), foreground, then reply with its answer.'
const workerDef = (extra = {}) => ({ description: 'Runs one command', prompt: 'You run the command you are given with Bash and reply "done".', tools: ['Bash'], model: 'haiku', ...extra })

// Discover model ids (token-free: supportedModels is the initialize response).
let models = []
{
  const abort = new AbortController(); let resolveNever
  const never = { [Symbol.asyncIterator]() { return { next: () => new Promise((r) => { resolveNever = r }) } } }
  const q = query({ prompt: never, options: { cwd: dir, settingSources: [], abortController: abort, tools: [] } })
  const reader = (async () => { for await (const _ of q) void _ })().catch(() => {})
  try { models = await Promise.race([q.supportedModels(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 15000))]) } catch (e) { console.log('supportedModels failed', e.message) }
  abort.abort(); resolveNever?.({ value: undefined, done: true }); await reader
  console.log('models:', JSON.stringify(models.map((m) => ({ value: m.value, resolved: m.resolvedModel, effort: m.supportedEffortLevels }))))
}
const sonnet = models.find((m) => m.value === 'sonnet' || /sonnet/i.test(m.value))
const sonnetFull = sonnet?.resolvedModel ?? (/^claude-/.test(sonnet?.value ?? '') ? sonnet.value : undefined)
console.log('sonnet full id:', sonnetFull, '| supports effort:', sonnet?.supportsEffort, sonnet?.supportedEffortLevels)

if (want.has('1')) {
  const ev = await run('1 model full id via hook', spawnPrompt, { ...base, model: 'haiku', agents: { lead: rootDef(), worker: workerDef({ tools: [] }) } }, () => ({ model: sonnetFull, run_in_background: false }))
  const m = childModels(ev)
  verdict('1 model via hook, full id', authFail(ev) || !sonnetFull ? 'INCONCLUSIVE' : m.length && m.every((x) => /sonnet/i.test(x ?? '')) ? 'PASS' : 'FAIL', `hook set model=${sonnetFull}; child assistant model(s)=${JSON.stringify(m)}; modelUsage=${JSON.stringify(ev.result?.models)}; error=${ev.error ?? 'none'}; Agent tool_results=${JSON.stringify(ev.toolResults.slice(0, 2))}`)
}
if (want.has('2')) {
  const ev = await run('2 model alias via hook', spawnPrompt, { ...base, model: 'haiku', agents: { lead: rootDef(), worker: workerDef({ tools: [] }) } }, () => ({ model: 'sonnet', run_in_background: false }))
  const m = childModels(ev)
  verdict('2 model via hook, alias', authFail(ev) ? 'INCONCLUSIVE' : m.length && m.every((x) => /sonnet/i.test(x ?? '')) ? 'PASS' : 'FAIL', `hook set model='sonnet'; child assistant model(s)=${JSON.stringify(m)}; modelUsage=${JSON.stringify(ev.result?.models)}; error=${ev.error ?? 'none'}`)
}
if (want.has('3')) {
  const ev = await run('3 effort via hook (def high -> hook low)', spawnPrompt, { ...base, model: 'haiku', agents: { lead: rootDef(), worker: workerDef({ model: 'sonnet', effort: 'high' }) } }, () => ({ effort: 'low', run_in_background: false }))
  const e = childEffort(ev)
  verdict('3 effort via hook', authFail(ev) || !e.length ? 'INCONCLUSIVE' : e.every((x) => x === 'low') ? 'PASS' : 'FAIL', `child def effort=high, hook set effort=low; child Bash PreToolUse effort.level=${JSON.stringify(e)}; child models=${JSON.stringify(childModels(ev))}; error=${ev.error ?? 'none'}`)
}
if (want.has('4')) {
  const p = 'Spawn the agent "worker" with the Agent tool. Your Agent call MUST include these parameters: subagent_type "worker", model "sonnet", effort "low", run_in_background false, prompt "Run the Bash command `echo hi` and reply with the word done." Then reply with its answer.'
  const ev = await run('4 model+effort set by the model', p, { ...base, model: 'haiku', agents: { lead: rootDef(), worker: workerDef({ effort: 'high' }) } }, () => ({ run_in_background: false }))
  const call = agentCalls(ev)[0]?.input ?? {}
  const e = childEffort(ev); const m = childModels(ev)
  const ok = call.model === 'sonnet' && call.effort === 'low'
  verdict('4 model and effort set by the model', authFail(ev) || !e.length ? 'INCONCLUSIVE' : ok && m.every((x) => /sonnet/i.test(x ?? '')) && e.every((x) => x === 'low') ? 'PASS' : 'FAIL', `tool_input model=${call.model} effort=${call.effort}; child models=${JSON.stringify(m)}; child effort.level=${JSON.stringify(e)}; error=${ev.error ?? 'none'}`)
}
if (want.has('5')) {
  const ev = await run('5 root effort from agent definition', 'Run the Bash command `echo hi` and reply with the word done.', { ...base, agent: 'lead', agents: { lead: { description: 'Lead', prompt: 'You run commands with Bash and reply "done".', tools: ['Bash'], model: 'sonnet', effort: 'low' } } })
  const e = ev.pre.filter((p) => p.agent === 'root').map((p) => p.effort)
  verdict('5 root effort from definition', authFail(ev) || !e.length ? 'INCONCLUSIVE' : e.every((x) => x === 'low') ? 'PASS' : 'FAIL', `lead def effort=low (sonnet); root Bash PreToolUse effort.level=${JSON.stringify(e)}; error=${ev.error ?? 'none'}`)
}
if (want.has('5')) {
  const ev = await run('5b subagent effort from its definition (no hook override)', spawnPrompt, { ...base, model: 'haiku', agents: { lead: rootDef(), worker: workerDef({ model: 'sonnet', effort: 'low' }) } }, () => ({ run_in_background: false }))
  const e = childEffort(ev)
  verdict('5b subagent effort from definition', authFail(ev) || !e.length ? 'INCONCLUSIVE' : e.every((x) => x === 'low') ? 'PASS' : 'FAIL', `worker def effort=low (sonnet), no hook override; child Bash effort.level=${JSON.stringify(e)}; root effort=${JSON.stringify(ev.pre.filter((p) => p.agent === 'root').map((p) => p.effort))}`)
}
if (want.has('6')) {
  const p = 'Start TWO agents at the same time: make both Agent tool calls (subagent_type "sleeper", prompts "A" and "B") in ONE single assistant message, not one after the other. Then reply "both done".'
  const ev = await run('6 parallel foreground spawns', p, { ...base, model: 'haiku', agents: { lead: rootDef(), sleeper: { description: 'Sleeps', prompt: 'Run the Bash command `sleep 5` once, then reply "slept".', tools: ['Bash'], model: 'haiku' } } }, () => ({ run_in_background: false }))
  const calls = agentCalls(ev)
  // The SDK emits one assistant message per content block; blocks of one API response share message.id.
  const ids = ev.assistants.filter((a) => a.who === 'root' && a.tools.includes('Agent')).map((a) => a.mid)
  const oneMsg = ids.length >= 2 && new Set(ids).size === 1
  const span = ev.starts.length >= 2 && ev.stops.length >= 2 ? { starts: ev.starts.map((s) => s.t), stops: ev.stops.map((s) => s.t) } : null
  const overlap = span && Math.max(...span.starts) < Math.min(...span.stops)
  const durs = span ? ev.starts.map((s) => (ev.stops.find((x) => x.id === s.id)?.t ?? 0) - s.t) : []
  verdict('6 parallel foreground spawns', authFail(ev) || !span ? 'INCONCLUSIVE' : overlap ? 'PASS' : 'FAIL', `agent calls=${calls.length} bg=${JSON.stringify(calls.map((c) => c.input.run_in_background))}; both in one assistant message=${oneMsg}; starts(ms)=${JSON.stringify(span?.starts)} stops(ms)=${JSON.stringify(span?.stops)}; per-child durations=${JSON.stringify(durs)} sum=${durs.reduce((a, b) => a + b, 0)}ms; total wall=${ev.wall}ms; overlap=${overlap}; error=${ev.error ?? 'none'}`)
}
if (want.has('7')) {
  const system = 'You are a triage classifier for a software team tool. Given a one-sentence task, decide whether a single assistant can do it alone or whether it needs a team of specialist agents (designer, implementer, reviewer). Small, contained, well-specified changes are "solo". Large, risky or multi-area work is "team". Answer with exactly one lowercase word, either solo or team, and nothing else. No punctuation.'
  const task = 'Task: rename the variable `cnt` to `count` in src/util/format.ts.'
  const rows = []
  for (let i = 0; i < 5; i++) {
    sessions++
    const t0 = Date.now(); let tInit = null, tFirst = null, text = ''
    try {
      for await (const msg of query({ prompt: task, options: { cwd: dir, systemPrompt: { type: 'custom', prompt: system }, tools: [], maxTurns: 1, settingSources: [], permissionMode: 'dontAsk', strictMcpConfig: true, mcpServers: {}, model: 'haiku', env: process.env } })) {
        if (msg.type === 'system' && msg.subtype === 'init') tInit = Date.now() - t0
        if (msg.type === 'assistant') { tFirst ??= Date.now() - t0; for (const b of msg.message.content) if (b.type === 'text') text += b.text }
      }
    } catch (e) { text = `ERR ${e.message}` }
    rows.push({ total: Date.now() - t0, init: tInit, firstAssistant: tFirst, text: text.trim() })
    console.log(`one-shot ${i + 1}:`, JSON.stringify(rows.at(-1)))
  }
  const sorted = rows.map((r) => r.total).sort((a, b) => a - b)
  const med = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
  const bad = rows.some((r) => r.text.startsWith('ERR'))
  verdict('7 one-shot latency (haiku)', bad ? 'INCONCLUSIVE' : 'PASS', `total ms min/median/max=${sorted[0]}/${med(sorted)}/${sorted.at(-1)} (all=${JSON.stringify(sorted)}); median ms to init message=${med(rows.map((r) => r.init))} (process start + handshake); median ms to first assistant message=${med(rows.map((r) => r.firstAssistant))}; answers=${JSON.stringify(rows.map((r) => r.text))}`)
}
console.log(`\n=== SUMMARY (${sessions} model sessions)`)
for (const r of results) console.log(`${r.v.padEnd(12)} ${r.id}`)
