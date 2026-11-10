// Smoke for docs/design/orchestration-efficiency.md §2, §4.2, §4.3: per-spawn model and effort, parallel foreground
// spawns, one-shot latency. Spends real tokens (haiku; sonnet only where a check needs effort or a second model).
// About 14 short model sessions: checks 1-6 are one each (plus 5b), check 7 is 5 sequential one-shots, check 8 is two, check 9 is one, check 10 is three (the control makes one sonnet call). Run once, do not loop.
// Check 7 MIRRORS buildCompletionOptions in src/main/runtime/claude.ts (importing the adapter drags in Electron),
// minus the OrgAI env isolation (it inherits this shell's login).
// Usage: node scripts/smoke-staffing.mjs [1 2 3 4 5 6 7 8 9 10 11]   (default: 1-10; 5 also runs 5b)
// Check 11 (nested 'inherit': does a grandchild defined with model 'inherit' run on the main thread's model or on its
// spawning subagent's?) is never in the default set: `11` is one live session (sonnet root, haiku child, the grandchild
// says one word), `11stub` is ZERO SPEND against a local Messages stub that records the model of every request.
// Checks 12-14 (docs/design/split-execution.md 3.3 and 3.6) are never in the default set; each is ONE live haiku session
// in permission mode 'auto' with no PreToolUse rewrite, a streaming input kept open until the report has come back, and
// the CLI's debug log (options.debugFile) searched for auto mode classifier requests:
//   12  background report hand-back: the model writes run_in_background true, then makes one Bash call of its own.
//   13  SubagentStart hookSpecificOutput.additionalContext: does the subagent see the marker; is it a spawn rewrite?
//   14  PostToolUse additionalContext on a BACKGROUND Agent call (async_launched): does the root see the line?
import { query } from '@anthropic-ai/claude-agent-sdk'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, realpathSync, readFileSync, existsSync } from 'node:fs'
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
if ([...want].some((w) => /^(\d|10|11)$/.test(w))) {
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
// ---------- checks 12-14: background reports and hook context (auto mode, no PreToolUse rewrite) ----------
// One session each. The env keeps only the login (like smoke-automode-classifier.mjs --live), so a parent Claude Code
// session's variables do not leak in. Every hook below logs and returns {} unless the check supplies an output.
const liveEnv = () => {
  const keep = ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL', 'HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']
  return { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => keep.includes(k))), CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '2' }
}
const short = (v, n = 200) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s !== undefined && s.length > n ? `${s.slice(0, n)}...` : s }
const AUTO_HOOKS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'PermissionRequest', 'PermissionDenied']
async function runAuto(label, prompt, agents, hookOut = {}) {
  sessions++
  console.log(`--- ${label}`)
  const t0 = Date.now(); const stamp = () => Date.now() - t0
  const log = []; const add = (kind, data) => { const e = { t: stamp(), kind, ...data }; log.push(e); console.log(JSON.stringify(e)) }
  const debugFile = join(dir, `debug-${label.split(' ')[0]}.log`)
  let canUse = 0, reportBack = false, closeInput, error
  const closed = new Promise((r) => { closeInput = r })
  const hooks = Object.fromEntries(AUTO_HOOKS.map((name) => [name, [{ hooks: [async (i) => {
    const rest = Object.fromEntries(Object.entries(i).filter(([k]) => !['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'permission_mode', 'agent_transcript_path'].includes(k)))
    add(`hook:${name}`, Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, short(v, /last_assistant_message|tool_response/.test(k) ? 500 : 200)])))
    const out = hookOut[name]?.(i)
    if (out) add('hook-returned', { name, out })
    return out ?? {}
  }] }]]))
  const input = (async function* () {
    yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' }
    await closed // keep the session open so a background report can come back and resume the root
  })()
  const abortController = new AbortController()
  const timer = setTimeout(() => { add('timeout', {}); abortController.abort() }, 150_000)
  const results = []
  try {
    for await (const msg of query({ prompt: input, options: { cwd: dir, settingSources: [], env: liveEnv(), debugFile, abortController, maxTurns: 12, permissionMode: 'auto', model: 'haiku', agent: 'lead', agents, hooks,
      canUseTool: async (tool, toolInput, o) => { canUse++; add('canUseTool', { tool, agent: o?.agentID }); return { behavior: 'allow', updatedInput: toolInput } } } })) {
      const who = msg.parent_tool_use_id ? 'child' : 'root'
      if (msg.type === 'system' && msg.subtype === 'init') add('init', { model: msg.model, permissionMode: msg.permissionMode })
      else if (msg.type === 'system') {
        add(`system:${msg.subtype}`, { task_id: msg.task_id, tool_use_id: msg.tool_use_id, status: msg.status, summary: short(msg.summary), handback: msg.handback, handback_report: short(msg.handback_report, 300), keys: Object.keys(msg).join(',') })
        if (msg.subtype === 'task_notification') reportBack = true
      } else if (msg.type === 'assistant') add(`assistant:${who}`, { ptu: msg.parent_tool_use_id ?? undefined, blocks: msg.message.content.map((b) => b.type === 'tool_use' ? `tool_use:${b.name}:${b.id}:${short(b.input, 200)}` : b.type === 'text' ? `text:${short(b.text, 400)}` : b.type) })
      else if (msg.type === 'user') {
        const c = msg.message.content
        const extra = Object.keys(msg).filter((k) => !['type', 'message', 'parent_tool_use_id', 'session_id', 'uuid'].includes(k))
        add(`user:${who}`, { extra: extra.length ? extra.map((k) => `${k}=${short(msg[k], k === 'tool_result_meta' ? 400 : 80)}`).join(' ') : undefined, content: Array.isArray(c) ? c.map((b) => b.type === 'tool_result' ? `tool_result:${b.tool_use_id}:${short(b.content, 500)}` : b.type === 'text' ? `text:${short(b.text, 500)}` : b.type) : `string:${short(c, 500)}` })
      } else if (msg.type === 'result') {
        results.push(msg)
        add('result', { subtype: msg.subtype, cost: msg.total_cost_usd, text: short(msg.result, 300) })
        if (reportBack) closeInput()
      } else add(`msg:${msg.type}`, { subtype: msg.subtype })
    }
  } catch (e) { error = String(e.message ?? e); add('error', { error }) }
  clearTimeout(timer); closeInput()
  const lines = existsSync(debugFile) ? readFileSync(debugFile, 'utf8').split('\n') : []
  const classifierLines = lines.filter((l) => /classifier|auto-mode|auto_mode|safeguard|\[Stall\]/i.test(l)).map((l) => l.replace(/(token|key|authorization)[=:]\s*\S+/gi, '$1=<redacted>').slice(0, 300))
  const started = lines.filter((l) => /classifier_request_started/.test(l)).map((l) => l.match(/tool=(\S+)/)?.[1] ?? '?')
  console.log(`debug log: ${lines.length} lines; classifier lines:`); for (const l of classifierLines) console.log('  ', l)
  // total_cost_usd is cumulative per session (each result repeats the running total); the classifier is not in it.
  const cost = Math.max(0, ...results.map((r) => r.total_cost_usd ?? 0))
  return { log, canUse, started, classifierLines, cost, error, debugLines: lines.length }
}
const firstOf = (r, kind, pred = () => true) => r.log.find((e) => e.kind === kind && pred(e))
const allOf = (r, kind, pred = () => true) => r.log.filter((e) => e.kind === kind && pred(e))
const has = (e, s) => !!e && (typeof e === 'string' ? e : JSON.stringify(e)).includes(s)
const classifierSummary = (r) => `classifier_request_started=${r.started.length} ${JSON.stringify(r.started)}; server-classifier rewrite lines=${r.classifierLines.filter((l) => /rewrote/.test(l)).length}; canUseTool calls=${r.canUse}; PermissionRequest hooks=${allOf(r, 'hook:PermissionRequest').length}; debug lines=${r.debugLines}`
if (want.has('12')) {
  const agents = {
    lead: { description: 'Lead', prompt: 'You are the lead. Follow the user\'s steps exactly, in order.', tools: ['Agent', 'Bash'], model: 'haiku' },
    worker: { description: 'Slow worker', prompt: 'Run the Bash command `sleep 12` once. Then report exactly this text and nothing else: REPORT-12 the answer is 42', tools: ['Bash'], model: 'haiku' }
  }
  const p = 'Do these steps in order. (1) Spawn the agent "worker" with the Agent tool: subagent_type "worker", run_in_background true, prompt "Go.". (2) Right after the Agent call returns, without waiting for the worker, run the Bash command `echo root-was-free` yourself. (3) When the worker\'s report reaches you, reply with its text verbatim and stop.'
  const r = await runAuto('12 background report hand-back', p, agents)
  const pre = firstOf(r, 'hook:PreToolUse', (e) => e.tool_name === 'Agent' && !e.agent_id)
  const agentUse = firstOf(r, 'assistant:root', (e) => e.blocks.some((b) => b.startsWith('tool_use:Agent:')))
  const agentId = agentUse?.blocks.find((b) => b.startsWith('tool_use:Agent:'))?.split(':')[2]
  const agentResult = firstOf(r, 'user:root', (e) => e.content.some?.((c) => typeof c === 'string' && c.startsWith(`tool_result:${agentId}`)))
  const rootBash = firstOf(r, 'hook:PreToolUse', (e) => e.tool_name === 'Bash' && !e.agent_id)
  const stop = firstOf(r, 'hook:SubagentStop')
  const hb = firstOf(r, 'hook:PostToolUse', (e) => e.tool_name === 'SubagentHandback')
  const note = firstOf(r, 'system:task_notification', (e) => e.tool_use_id === agentId) // a child's own Bash can be a background task too
  const resumed = allOf(r, 'init', (e) => note && e.t > note.t).map((e) => e.t)
  const arrivals = r.log.filter((e) => e.kind.startsWith('user:root') && e !== agentResult && has(e, 'REPORT-12')).map((e) => `${e.kind}@${e.t}${e.extra ? `(${e.extra})` : ''}`)
  const finalText = r.log.filter((e) => e.kind === 'result').map((e) => e.text).join(' | ')
  verdict('12 background report hand-back', r.error || !agentResult ? 'INCONCLUSIVE' : 'OBSERVED', `model wrote run_in_background=${has(pre?.tool_input, '"run_in_background":true')}; Agent tool_result at ${agentResult?.t}ms: ${short(agentResult?.content, 260)}; SubagentStart at ${firstOf(r, 'hook:SubagentStart')?.t}ms; root's own Bash PreToolUse at ${rootBash?.t}ms (worker SubagentStop at ${stop?.t}ms -> root free while report ran=${rootBash && stop ? rootBash.t < stop.t : 'n/a'}); SubagentHandback PostToolUse at ${hb?.t}ms carries REPORT-12=${has(hb, 'REPORT-12')}; SubagentStop last_assistant_message carries REPORT-12=${has(stop?.last_assistant_message, 'REPORT-12')}; task_notification at ${note?.t}ms handback=${note?.handback} report carries REPORT-12=${has(note, 'REPORT-12')}; root-side SDK messages carrying REPORT-12 after launch=${JSON.stringify(arrivals)}; root re-init (resume) at ${JSON.stringify(resumed)}ms; root PostToolUse for Agent count=${allOf(r, 'hook:PostToolUse', (e) => e.tool_name === 'Agent' && !e.agent_id).length}; results=${allOf(r, 'result').length}; final text(s)=${short(finalText, 200)}; ${classifierSummary(r)}; cost=${r.cost}; error=${r.error ?? 'none'}`)
}
if (want.has('13')) {
  const agents = {
    lead: { description: 'Lead', prompt: 'You are the lead. Use the Agent tool exactly as instructed, then answer.', tools: ['Agent'], model: 'haiku' },
    worker: { description: 'Reports context markers', prompt: 'If anything in your context (system prompt, task, or any added context) contains a line starting with MARKER-, your report is that line quoted verbatim. If there is none, your report is exactly: NO MARKER.', tools: [], model: 'haiku' }
  }
  const p = 'Spawn the agent "worker" with the Agent tool: subagent_type "worker", run_in_background false, prompt "Report as your instructions say.". Then reply with its report verbatim.'
  const r = await runAuto('13 SubagentStart additionalContext', p, agents, { SubagentStart: () => ({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: 'MARKER-13 violet-anchor-7' } }) })
  const seenBy = r.log.filter((e) => has(e, 'violet-anchor-7') && !['hook-returned'].includes(e.kind)).map((e) => `${e.kind}@${e.t}`)
  const childSaw = r.log.some((e) => ['hook:PreToolUse', 'hook:PostToolUse', 'hook:SubagentStop', 'system:task_notification', 'assistant:child'].includes(e.kind) && (e.agent_id || e.kind.startsWith('system') || e.kind === 'assistant:child') && has(e, 'violet-anchor-7'))
  verdict('13 SubagentStart additionalContext', r.error || !firstOf(r, 'hook:SubagentStart') ? 'INCONCLUSIVE' : childSaw ? 'PASS (subagent saw it)' : 'FAIL (subagent did not report it)', `marker 'MARKER-13 violet-anchor-7' returned from SubagentStart; entries carrying the marker after the hook=${JSON.stringify(seenBy)}; worker report: handback=${short(firstOf(r, 'hook:PreToolUse', (e) => e.tool_name === 'SubagentHandback')?.tool_input, 160)} last_assistant_message=${short(firstOf(r, 'hook:SubagentStop')?.last_assistant_message, 160)}; ${classifierSummary(r)}; cost=${r.cost}; error=${r.error ?? 'none'}`)
}
if (want.has('14')) {
  const agents = {
    lead: { description: 'Lead', prompt: 'You are the lead. Follow the user\'s steps exactly, in order.', tools: ['Agent'], model: 'haiku' },
    worker: { description: 'Says ok', prompt: 'Your report is exactly: ok', tools: [], model: 'haiku' }
  }
  const p = 'Do these steps in order. (1) Spawn the agent "worker" with the Agent tool: subagent_type "worker", run_in_background true, prompt "Go.". (2) As soon as the Agent call returns, before the worker reports, write one message that quotes verbatim every line starting with MARKER- that came with that Agent tool result, or says NO MARKER. (3) When the worker\'s report reaches you, reply "done".'
  const r = await runAuto('14 PostToolUse additionalContext on a background Agent call', p, agents, { PostToolUse: (i) => (i.tool_name === 'Agent' && !i.agent_id ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'MARKER-14 teal-kite-3' } } : undefined) })
  const post = firstOf(r, 'hook:PostToolUse', (e) => e.tool_name === 'Agent' && !e.agent_id)
  const said = allOf(r, 'assistant:root', (e) => has(e, 'teal-kite-3')).map((e) => e.t)
  const stop = firstOf(r, 'hook:SubagentStop'); const note = firstOf(r, 'system:task_notification')
  const elsewhere = r.log.filter((e) => has(e, 'teal-kite-3') && !['hook-returned', 'assistant:root', 'result'].includes(e.kind)).map((e) => `${e.kind}@${e.t}`)
  verdict('14 PostToolUse additionalContext on a background Agent call', r.error || !post ? 'INCONCLUSIVE' : said.length ? 'PASS (root saw it)' : 'FAIL', `root Agent PostToolUse at ${post?.t}ms, tool_response=${short(post?.tool_response, 200)}; worker SubagentStop at ${stop?.t}ms, task_notification at ${note?.t}ms; root assistant text with the marker at ${JSON.stringify(said)}ms; marker also seen in ${JSON.stringify(elsewhere)}; ${classifierSummary(r)}; cost=${r.cost}; error=${r.error ?? 'none'}`)
}
console.log(`\n=== SUMMARY (${sessions} model sessions)`)
for (const r of results) console.log(`${r.v.padEnd(12)} ${r.id}`)
