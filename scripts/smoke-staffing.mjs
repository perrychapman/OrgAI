// Smoke for docs/design/orchestration-efficiency.md §2, §4.2, §4.3: per-spawn model and effort, parallel foreground
// spawns, one-shot latency. Spends real tokens (haiku; sonnet only where a check needs effort or a second model).
// About 14 short model sessions: checks 1-6 are one each (plus 5b), check 7 is 5 sequential one-shots, check 8 is two, check 9 is one, check 10 is three (the control makes one sonnet call). Run once, do not loop.
// Check 7 MIRRORS buildCompletionOptions in src/main/runtime/claude.ts (importing the adapter drags in Electron),
// minus the OrgAI env isolation (it inherits this shell's login).
// Usage: node scripts/smoke-staffing.mjs [1 2 3 4 5 6 7 8 9 10 11]   (default: 1-10; 5 also runs 5b)
// Check 11 (nested 'inherit': does a grandchild defined with model 'inherit' run on the main thread's model or on its
// spawning subagent's?) is never in the default set: `11` is one live session (sonnet root, haiku child, the grandchild
// says one word), `11stub` is ZERO SPEND against a local Messages stub that records the model of every request.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-smoke-staffing-')))
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
const want = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
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
      else if (msg.type === 'assistant') ev.assistants.push({ t: stamp(), who: msg.parent_tool_use_id ? 'child' : 'root', ptu: msg.parent_tool_use_id ?? null, agentUses: msg.message.content.filter((b) => b.type === 'tool_use' && b.name === 'Agent').map((b) => ({ id: b.id, type: b.input?.subagent_type })), model: msg.message.model, mid: msg.message.id, tools: msg.message.content.filter((b) => b.type === 'tool_use').map((b) => b.name) })
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

// Discover model ids (token-free: supportedModels is the initialize response). Not needed by the stub check alone.
let models = []
if ([...want].some((w) => w !== '11stub')) {
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
if (want.has('8')) {
  const echo = 'Run the Bash command `echo hi` and reply with the word done.'
  const a = await run('8a Options.effort low, no Options.agent', echo, { allowedTools: ['Bash'], permissionMode: 'dontAsk', model: 'sonnet', effort: 'low' })
  const ea = a.pre.filter((p) => p.tool === 'Bash').map((p) => p.effort)
  verdict('8a Options.effort on the main thread', authFail(a) || !ea.length ? 'INCONCLUSIVE' : ea.every((x) => x === 'low') ? 'PASS' : 'FAIL', `Options.effort=low, model=sonnet, no agent; root Bash effort.level=${JSON.stringify(ea)}; error=${a.error ?? 'none'}`)
  const p8 = 'First run the Bash command `echo root` yourself. Then spawn the agent "worker" with the Agent tool (subagent_type "worker", prompt "Run the Bash command `echo hi` and reply with the word done."), foreground, and reply with its answer.'
  const b = await run('8b Options.effort low + Options.agent lead (no effort fields)', p8, { ...base, model: 'sonnet', effort: 'low', agents: { lead: rootDef({ model: 'sonnet', tools: ['Agent', 'Bash'] }), worker: workerDef({ model: 'sonnet' }) } }, () => ({ run_in_background: false }))
  const rb = b.pre.filter((p) => p.agent === 'root' && p.tool === 'Bash').map((p) => p.effort)
  const cb = childEffort(b)
  verdict('8b Options.effort reaches a root chosen by Options.agent', authFail(b) || !rb.length ? 'INCONCLUSIVE' : rb.every((x) => x === 'low') ? 'PASS' : 'FAIL', `Options.effort=low, agent=lead (no effort field); (i) root Bash effort.level=${JSON.stringify(rb)}; (ii) child with no effort of its own, Bash effort.level=${JSON.stringify(cb)} (observed fact: ${cb.length ? (cb.every((x) => x === 'low') ? 'inherits the session effort' : 'does not inherit') : 'child Bash not observed'}); error=${b.error ?? 'none'}`)
}
if (want.has('9')) {
  // A definition effort on a model whose supportedModels() row lists no effort levels: does the spawn work, and what
  // effort.level does the child's hook input report? (Decides whether OrgAI may write an explicit default effort there.)
  const id = 'claude-haiku-4-5-20251001'
  const row = models.find((m) => m.value === id || m.resolvedModel === id)
  const ev = await run('9 definition effort medium on a model without listed effort levels', spawnPrompt, { ...base, model: 'haiku', agents: { lead: rootDef(), worker: workerDef({ model: id, effort: 'medium' }) } }, () => ({ run_in_background: false }))
  const e = childEffort(ev); const m = childModels(ev)
  const spawned = ev.starts.length > 0 && e.length > 0
  verdict('9 definition effort on a model without effort levels', authFail(ev) ? 'INCONCLUSIVE' : spawned ? 'PASS' : 'FAIL', `worker def model=${id} effort=medium; supportedModels row=${JSON.stringify(row ? { value: row.value, supportsEffort: row.supportsEffort, levels: row.supportedEffortLevels } : null)}; subagent started=${ev.starts.length > 0}; child Bash effort.level=${JSON.stringify(e)} (null = no effort reported); child models=${JSON.stringify(m)}; Agent tool_results=${JSON.stringify(ev.toolResults.slice(0, 2))}; error=${ev.error ?? 'none'}`)
}
if (want.has('10')) {
  // Does ANTHROPIC_DEFAULT_SONNET_MODEL redirect the alias `sonnet` on a subscription login with no ANTHROPIC_BASE_URL?
  // (OrgAI sets it only on proxy connections.) Mapped target: the haiku id check 9 uses. The SDK stream carries no child
  // assistant messages here, so each spawn gets its own session and the child model is read from modelUsage (childModels).
  const mapped = 'claude-haiku-4-5-20251001'
  const one = (t) => `Spawn the agent "${t}" with the Agent tool (subagent_type "${t}", prompt "Reply with the word ok."), foreground, then reply "done".`
  const defs = { lead: rootDef(), wa: { description: 'Replies ok', prompt: 'Reply with the single word ok.', tools: [] }, wb: { description: 'Replies ok', prompt: 'Reply with the single word ok.', tools: [], model: 'sonnet' } }
  const hookSonnet = () => ({ model: 'sonnet', run_in_background: false })
  const noHook = () => ({ run_in_background: false })
  const withVar = { ...base, model: 'haiku', env: { ...env, ANTHROPIC_DEFAULT_SONNET_MODEL: mapped }, agents: defs }
  const a = await run('10a variable set; hook writes sonnet; definition has no model', one('wa'), withVar, hookSonnet)
  const b = await run('10b variable set; definition model sonnet; no hook change', one('wb'), withVar, noHook)
  const c = await run('10c control, no variable; hook writes sonnet', one('wa'), { ...base, model: 'haiku', agents: defs }, hookSonnet)
  const kind = (ev) => { const m = childModels(ev); return m.length ? `${JSON.stringify(m)} -> ${m.every((x) => x === mapped) ? 'mapped id (variable applies)' : m.some((x) => /sonnet/i.test(x ?? '')) ? 'SDK sonnet (variable does not apply)' : 'other'}` : 'none observed' }
  verdict('10 ANTHROPIC_DEFAULT_SONNET_MODEL on a subscription login', [a, b, c].some(authFail) || !childModels(c).length ? 'INCONCLUSIVE' : 'PASS', `variable=${mapped}; (a) hook alias sonnet, definition without model: spawned=${a.starts.length > 0}, child model(s)=${kind(a)}, modelUsage=${JSON.stringify(a.result?.models)}; (b) definition model sonnet, no hook change: spawned=${b.starts.length > 0}, child model(s)=${kind(b)}, modelUsage=${JSON.stringify(b.result?.models)}; (c) control without variable, hook sonnet: spawned=${c.starts.length > 0}, child model(s)=${kind(c)}, modelUsage=${JSON.stringify(c.result?.models)}; errors=${a.error ?? 'none'}/${b.error ?? 'none'}/${c.error ?? 'none'}`)
}
// ---------- check 11: nested 'inherit' ----------
// lead (root, sonnet) spawns `mid` (pinned haiku), which spawns `grand` (model 'inherit'). Main-thread reading: grand
// runs on sonnet. Parent reading: grand runs on haiku. The agents are told apart by their system prompts (stub) or by
// parent_tool_use_id chains (live, forwardSubagentText), never by the model itself.
const MARK = { lead: 'You are the lead of check eleven.', mid: 'You are the middle agent of check eleven.', grand: 'You are the grandchild of check eleven.' }
const nestedAgents = (root, mid) => ({
  lead: { description: 'Lead', prompt: `${MARK.lead} Spawn the agent "mid" with the Agent tool (subagent_type "mid", run_in_background false, prompt "Spawn grand."), then reply with its answer in one word.`, tools: ['Agent'], model: root },
  mid: { description: 'Middle agent that spawns grand', prompt: `${MARK.mid} Spawn the agent "grand" with the Agent tool (subagent_type "grand", run_in_background false, prompt "Say ok."), then reply with its answer in one word.`, tools: ['Agent'], model: mid },
  grand: { description: 'Says ok', prompt: `${MARK.grand} Reply with the single word ok. Use no tools.`, tools: [], model: 'inherit' }
})
const nestedPrompt = 'Spawn the agent "mid" with the Agent tool (subagent_type "mid", run_in_background false, prompt "Spawn grand."), then reply with its answer in one word.'
if (want.has('11stub')) {
  const STUB = { root: 'claude-sonnet-5-5', mid: 'claude-haiku-5-5' }
  const seen = []
  const spawned = new Set()
  const sse = (model, block, stop) => {
    const ev = [['message_start', { type: 'message_start', message: { id: `msg_${Date.now()}_${seen.length}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }]]
    if (block.type === 'text') {
      ev.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text } }])
    } else {
      ev.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }], ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }])
    }
    ev.push(['content_block_stop', { type: 'content_block_stop', index: 0 }], ['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }], ['message_stop', { type: 'message_stop' }])
    return ev.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":100}'); return }
      const body = raw ? JSON.parse(raw) : {}
      const sys = (Array.isArray(body.system) ? body.system.map((b) => b.text ?? '').join('\n') : String(body.system ?? ''))
      const who = Object.keys(MARK).find((k) => sys.includes(MARK[k])) ?? 'other'
      seen.push({ who, model: body.model })
      let block = { type: 'text', text: who === 'grand' ? 'ok' : 'done' }, stop = 'end_turn'
      const child = { lead: 'mid', mid: 'grand' }[who]
      if (child && !spawned.has(who)) {
        spawned.add(who); stop = 'tool_use'
        block = { type: 'tool_use', id: `toolu_${who}`, name: 'Agent', input: { subagent_type: child, description: `Run ${child}`, prompt: child === 'mid' ? 'Spawn grand.' : 'Say ok.', run_in_background: false } }
      }
      res.writeHead(200, { 'content-type': body.stream ? 'text/event-stream' : 'application/json' })
      res.end(body.stream ? sse(body.model, block, stop) : JSON.stringify({ id: `msg_${seen.length}`, type: 'message', role: 'assistant', model: body.model, content: [block], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const keep = ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL']
  const stubEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => keep.includes(k)))
  Object.assign(stubEnv, { HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'config'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_AUTH_TOKEN: 'stub-token', CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '2' })
  const ev = await run('11stub nested inherit (local stub, no spend)', nestedPrompt, { agent: 'lead', allowedTools: ['Agent'], permissionMode: 'dontAsk', model: STUB.root, env: stubEnv, agents: nestedAgents(STUB.root, STUB.mid) })
  server.close()
  const of = (w) => [...new Set(seen.filter((x) => x.who === w).map((x) => x.model))]
  const g = of('grand')
  verdict('11stub nested inherit', !g.length ? 'INCONCLUSIVE' : g.every((m) => m === STUB.root) ? 'PASS (main thread)' : g.every((m) => m === STUB.mid) ? 'PASS (parent)' : 'MIXED', `root requests on ${JSON.stringify(of('lead'))}, mid on ${JSON.stringify(of('mid'))}, grandchild (model 'inherit') on ${JSON.stringify(g)}; other requests ${JSON.stringify(of('other'))}; error=${ev.error ?? 'none'}`)
}
if (want.has('11')) {
  // Live: one session, sonnet root, haiku child, the grandchild says one word. Child messages come through
  // forwardSubagentText; each is attributed by its parent_tool_use_id (the Agent call that started it).
  const ev = await run('11 nested inherit (live)', nestedPrompt, { agent: 'lead', allowedTools: ['Agent'], permissionMode: 'dontAsk', model: 'sonnet', forwardSubagentText: true, agents: nestedAgents('sonnet', 'haiku') })
  const rootCall = ev.assistants.find((a) => a.who === 'root' && a.agentUses.some((u) => u.type === 'mid'))?.agentUses.find((u) => u.type === 'mid')?.id
  const midMsgs = ev.assistants.filter((a) => a.ptu && a.ptu === rootCall)
  const midCall = midMsgs.flatMap((a) => a.agentUses).find((u) => u.type === 'grand')?.id
  const grandMsgs = ev.assistants.filter((a) => a.ptu && a.ptu === midCall)
  const models = (xs) => [...new Set(xs.map((a) => a.model))]
  const g = models(grandMsgs)
  verdict('11 nested inherit (live)', authFail(ev) || !g.length ? 'INCONCLUSIVE' : g.every((m) => /sonnet/i.test(m ?? '')) ? 'PASS (main thread)' : g.every((m) => /haiku/i.test(m ?? '')) ? 'PASS (parent)' : 'MIXED', `root=${ev.init?.model}; mid (pinned haiku) messages on ${JSON.stringify(models(midMsgs))}; grandchild (model 'inherit') messages on ${JSON.stringify(g)}; modelUsage=${JSON.stringify(ev.result?.models)}; cost=${ev.result?.cost}; error=${ev.error ?? 'none'}`)
}
console.log(`\n=== SUMMARY (${sessions} model sessions)`)
for (const r of results) console.log(`${r.v.padEnd(12)} ${r.id}`)
