// Which model runs the auto-mode classifier's spawn-time check (permissionMode 'auto'), what it is sent, and whether
// CLAUDE_CODE_AUTO_MODE_MODEL moves it. Root spawns one custom agent once (OrgAI's spawn hook shape: updatedInput, no
// permissionDecision); the CLI's debug log (options.debugFile) is filtered for the classifier lines.
//
// Two modes:
//   --stub <scenario>   ZERO SPEND. A local Anthropic Messages stub on 127.0.0.1 plays the connection the way OrgAI
//                       builds a proxy connection (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN + ANTHROPIC_DEFAULT_*_MODEL)
//                       and, like the performance lab's relay, answers 400 for any model outside its allow list. It
//                       logs every request (model, tools, system size, message sizes, cache_control). No credential.
//                       Scenarios: lab (allow opus/sonnet/haiku 5.5), lab-env-sonnet (+ CLAUDE_CODE_AUTO_MODE_MODEL=
//                       claude-sonnet-5-5), lab-env-haiku (+ =claude-haiku-5-5), serves-sonnet5 (allow list also has
//                       claude-sonnet-5), handback (lab, the worker ends with SubagentHandback instead of plain text),
//                       text-acted / handback-acted (the worker first runs one Bash command, then ends either way).
//   --no-rewrite        (either mode) the spawn hook returns {} instead of updatedInput.
//   --live [model]      SPENDS TOKENS (one short session, haiku root and worker; the classifier itself runs on the
//                       CLI's choice, Sonnet 5 by default). Uses this shell's Claude login. [model] sets
//                       CLAUDE_CODE_AUTO_MODE_MODEL. Run at most once per question, never in a loop.
// Usage: node scripts/smoke-automode-classifier.mjs --stub lab | --live [claude-haiku-4-5] [--no-rewrite]
import { query } from '@anthropic-ai/claude-agent-sdk'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
// --no-rewrite: the spawn hook returns {} instead of OrgAI's updatedInput (does a rewrite void the server's verdict?)
const noRewrite = args.includes('--no-rewrite')
const [modeArg, scenarioArg] = args.filter((a) => a !== '--no-rewrite')
const live = modeArg === '--live'
if (!live && modeArg !== '--stub') { console.log('usage: --stub <lab|lab-env-sonnet|lab-env-haiku|serves-sonnet5|handback|text-acted|handback-acted> | --live [classifier model]'); process.exit(2) }
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-smoke-automode-')))
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
const debugFile = join(dir, 'debug.log')

const TIERS = { deep: 'claude-opus-5-5', everyday: 'claude-sonnet-5-5', fast: 'claude-haiku-5-5' }
const scenario = live ? 'live' : scenarioArg ?? 'lab'
const stubAllowed = new Set([...Object.values(TIERS), ...(scenario === 'serves-sonnet5' ? ['claude-sonnet-5'] : [])])
const envModel = live ? scenarioArg : { 'lab-env-sonnet': 'claude-sonnet-5-5', 'lab-env-haiku': 'claude-haiku-5-5' }[scenario]
const rootModel = live ? 'claude-haiku-5-5' : TIERS.deep
const workerModel = live ? 'claude-haiku-5-5' : TIERS.everyday

// ---------- stub ----------
const stubLog = []
let rootSpawned = false, workerHandedBack = false, workerActed = false
const acted = scenario.endsWith('-acted') // the worker runs one Bash command before it ends
const handsBack = scenario.startsWith('handback') // the worker ends with SubagentHandback, not plain text
const sse = (model, blocks, stop) => {
  const ev = [['message_start', { type: 'message_start', message: { id: `msg_stub_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }]]
  blocks.forEach((b, i) => {
    if (b.type === 'text') {
      ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }])
      ev.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } }])
    } else {
      ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }])
      ev.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }])
    }
    ev.push(['content_block_stop', { type: 'content_block_stop', index: i }])
  })
  ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }])
  ev.push(['message_stop', { type: 'message_stop' }])
  return ev.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
}
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text ?? (typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? b.input ?? ''))).join('') : '')
async function startStub() {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}
      const path = req.url.split('?')[0]
      if (path.endsWith('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":100}'); return }
      const model = body.model
      const tools = (body.tools ?? []).map((t) => t.name)
      const sys = Array.isArray(body.system) ? body.system : body.system ? [{ type: 'text', text: body.system }] : []
      const sysText = sys.map((s) => s.text ?? '').join('\n')
      const classifier = tools.length === 0 && /<block>no<\/block>/.test(sysText)
      const row = {
        n: stubLog.length + 1, model, kind: classifier ? 'classifier' : tools.includes('Agent') ? 'root' : tools.length ? 'worker' : 'other',
        tools: tools.length, toolNames: tools.filter((t) => ['Agent', 'SubagentHandback'].includes(t)), nMessages: (body.messages ?? []).length, stopSequences: body.stop_sequences ?? null, maxTokens: body.max_tokens,
        systemBlocks: sys.map((s) => ({ chars: (s.text ?? '').length, cache: s.cache_control ?? null, head: (s.text ?? '').slice(0, 120).replace(/\n/g, ' ') })),
        messages: (body.messages ?? []).map((m) => ({ role: m.role, blocks: Array.isArray(m.content) ? m.content.map((b) => ({ type: b.type, chars: textOf([b]).length, cache: b.cache_control ?? null, head: textOf([b]).slice(0, 70).replace(/\n/g, ' ') })) : [{ type: 'string', chars: m.content.length }] }))
      }
      if (!stubAllowed.has(model)) {
        row.reply = '400 model not allowed'
        stubLog.push(row)
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `model ${model} is not allowed on this connection` } }))
        return
      }
      let blocks, stop = 'end_turn'
      if (classifier) blocks = [{ type: 'text', text: '<block>no</block>' }]
      else if (row.kind === 'root' && !rootSpawned) {
        rootSpawned = true; stop = 'tool_use'
        blocks = [{ type: 'tool_use', id: 'toolu_stub_agent', name: 'Agent', input: { subagent_type: 'worker', description: 'Say done', prompt: 'Reply with the word done.' } }]
      } else if (row.kind === 'worker' && acted && !workerActed) {
        workerActed = true; stop = 'tool_use'
        blocks = [{ type: 'tool_use', id: 'toolu_stub_bash', name: 'Bash', input: { command: 'touch acted.txt', description: 'Create a marker file' } }]
      } else if (row.kind === 'worker' && handsBack && tools.includes('SubagentHandback') && !workerHandedBack) {
        workerHandedBack = true; stop = 'tool_use'
        blocks = [{ type: 'tool_use', id: 'toolu_stub_handback', name: 'SubagentHandback', input: { message: 'done' } }]
      } else blocks = [{ type: 'text', text: 'done' }]
      row.reply = blocks.map((b) => b.name ?? b.text).join(',')
      stubLog.push(row)
      if (body.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse(model, blocks, stop)) }
      else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: `msg_stub_${Date.now()}`, type: 'message', role: 'assistant', model, content: blocks.map((b) => (b.type === 'text' ? b : { type: 'tool_use', id: b.id, name: b.name, input: b.input })), stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }))
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

// ---------- environment ----------
// Live: this shell's login (CLAUDE_CONFIG_DIR / keychain), nothing else that routes or picks models, plus the variable
// OrgAI's anthropicTierEnv sets for the everyday tier in staffing mode 'auto'. Stub: exactly what buildRunConnection
// builds for a proxy on the Claude adapter, an isolated HOME and config dir (no login can apply).
const keep = ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL', ...(live ? ['HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] : [])]
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => keep.includes(k)))
Object.assign(env, { CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1', ANTHROPIC_DEFAULT_SONNET_MODEL: TIERS.everyday })
let stub
if (!live) {
  stub = await startStub()
  Object.assign(env, { HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'config'), ANTHROPIC_BASE_URL: stub.base, ANTHROPIC_AUTH_TOKEN: 'stub-token', ANTHROPIC_DEFAULT_OPUS_MODEL: TIERS.deep, ANTHROPIC_DEFAULT_HAIKU_MODEL: TIERS.fast })
}
if (envModel) env.CLAUDE_CODE_AUTO_MODE_MODEL = envModel
console.log('scenario:', scenario, '| spawn hook:', noRewrite ? '{} (no rewrite)' : 'updatedInput (OrgAI shape)', '| root:', rootModel, '| worker:', workerModel, '| CLAUDE_CODE_AUTO_MODE_MODEL:', envModel ?? '(unset)', '| env names:', Object.keys(env).filter((k) => /^(ANTHROPIC_DEFAULT|CLAUDE_CODE_AUTO|ANTHROPIC_BASE)/.test(k)).join(','))

// ---------- the session ----------
const t0 = Date.now()
const marks = []
const stamp = (what) => marks.push({ t: Date.now() - t0, what })
let result = null, error = null
const abortController = new AbortController()
const timer = setTimeout(() => abortController.abort(), live ? 150_000 : 60_000)
try {
  for await (const msg of query({
    prompt: 'Spawn the agent "worker" with the Agent tool (subagent_type "worker", run_in_background false, prompt "Reply with the word done."), then reply with its answer in one word.',
    options: {
      cwd: dir, settingSources: [], env, debugFile, abortController, maxTurns: 6, permissionMode: 'auto', model: rootModel, agent: 'lead',
      agents: {
        lead: { description: 'Lead', prompt: 'You are the lead. Use the Agent tool exactly as instructed, then answer in one word.', tools: ['Agent'], model: rootModel },
        worker: { description: 'Says done', prompt: 'You reply with the single word done. Use no tools.', tools: live ? [] : ['Bash'], model: workerModel }
      },
      hooks: {
        // OrgAI's spawn hook shape (claude.ts PreToolUse for SPAWN_TOOL): updatedInput only, the permission mode decides.
        PreToolUse: [{ hooks: [async (i) => {
          stamp(`PreToolUse ${i.tool_name}${i.agent_id ? ' (child)' : ''}`)
          // OrgAI almost always changes the call: at least `name` (spawnHandle), often model, effort, isolation, prompt.
          if (i.tool_name === 'Agent' && !noRewrite) return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...i.tool_input, name: 'worker-1', run_in_background: false } } }
          return {}
        }] }],
        SubagentStart: [{ hooks: [async () => (stamp('SubagentStart'), {})] }],
        SubagentStop: [{ hooks: [async () => (stamp('SubagentStop'), {})] }]
      }
    }
  })) {
    if (msg.type === 'system' && msg.subtype === 'init') stamp(`init model=${msg.model} mode=${msg.permissionMode}`)
    else if (msg.type === 'assistant') stamp(`assistant ${msg.parent_tool_use_id ? 'child' : 'root'} model=${msg.message.model} tools=${msg.message.content.filter((b) => b.type === 'tool_use').map((b) => b.name).join(',')}`)
    else if (msg.type === 'user' && Array.isArray(msg.message.content)) for (const b of msg.message.content) if (b.type === 'tool_result') stamp(`tool_result${b.is_error ? ' ERROR' : ''} ${JSON.stringify(b.content).slice(0, 160)}`)
    if (msg.type === 'result') result = msg
  }
} catch (e) { error = String(e.message ?? e) }
clearTimeout(timer)
stub?.server.close()

console.log('\n=== timeline'); for (const m of marks) console.log(String(m.t).padStart(6), m.what)
if (result) {
  console.log('\n=== result', JSON.stringify({ subtype: result.subtype, cost: result.total_cost_usd, text: (result.result ?? '').slice(0, 80) }))
  console.log('=== modelUsage (per model)')
  for (const [m, u] of Object.entries(result.modelUsage ?? {})) console.log(' ', m, JSON.stringify({ in: u.inputTokens, out: u.outputTokens, cacheRead: u.cacheReadInputTokens, cacheWrite: u.cacheCreationInputTokens, costUSD: u.costUSD }))
}
if (error) console.log('session error:', error)
if (!live) {
  console.log('\n=== stub requests')
  for (const r of stubLog) {
    console.log(JSON.stringify({ n: r.n, model: r.model, kind: r.kind, tools: r.tools, toolNames: r.toolNames, nMessages: r.nMessages, maxTokens: r.maxTokens, stop: r.stopSequences, reply: r.reply }))
    if (r.kind === 'classifier') {
      console.log('   system:', JSON.stringify(r.systemBlocks))
      console.log('   messages:', JSON.stringify(r.messages))
    }
  }
}
console.log('\n=== debug log: classifier lines')
if (existsSync(debugFile)) {
  const lines = readFileSync(debugFile, 'utf8').split('\n')
  const want = /classifier|auto-mode|Auto mode|auto_mode|Sonnet 5|server-classifier|AUTO_MODE/i
  for (const l of lines) if (want.test(l)) console.log(' ', l.replace(/(token|key|authorization)[=:]\s*\S+/gi, '$1=<redacted>').slice(0, 400))
} else console.log('  (no debug file written)')
