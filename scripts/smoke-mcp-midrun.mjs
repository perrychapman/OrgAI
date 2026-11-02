// Verifies how MCP servers attached mid-run with Query.setMcpServers reach a main-thread agent (Options.agent) and
// subagents whose AgentDefinition.tools is a whitelist. Facts the Claude adapter's mid-run install depends on:
//  a. Does a main-thread AgentDefinition.tools entry 'mcp__alpha', 'mcp__alpha__*' or 'mcp__*' admit alpha's tools?
//  b. After setMcpServers adds beta mid-session, is mcp__beta__ping callable by the main-thread agent when its
//     whitelist holds (i) nothing for beta ('mcp__alpha' only), (ii) 'mcp__*', (iii) tools omitted? Does PreToolUse /
//     canUseTool fire for a tool outside the whitelist, and what text does the model see?
//  c. A subagent spawned AFTER setMcpServers: is the new server (gamma) callable, and does def.mcpServers: ['alpha']
//     restrict it to alpha?
//  d. (reloadSkills) skipped.
// SPENDS TOKENS (fractions of a cent on haiku). Run only with the user's consent, once: node scripts/smoke-mcp-midrun.mjs
// Uses the Claude login or API key from the environment, settingSources [], a temp cwd (removed at the end).
//
// RESULTS: see the block at the end of this header once the script has been run.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'

const trunc = (s, n = 300) => (typeof s === 'string' ? s : JSON.stringify(s) ?? '').replace(/\s+/g, ' ').slice(0, n)
const log = (label, kind, data) => console.log(`[${label}] ${kind}`, trunc(typeof data === 'string' ? data : JSON.stringify(data), 600))

/** A fresh in-process server per session: <name>.ping returns PONG-<NAME>. */
const server = (name) =>
  createSdkMcpServer({
    name,
    version: '1.0.0',
    tools: [tool('ping', `Ping the ${name} server. Returns a fixed word.`, {}, async () => ({ content: [{ type: 'text', text: `PONG-${name.toUpperCase()}` }] }))]
  })

class PushStream {
  queue = []
  waiters = []
  closed = false
  push(v) {
    if (this.closed) return
    const w = this.waiters.shift()
    if (w) w({ value: v, done: false })
    else this.queue.push(v)
  }
  end() {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true })
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift(), done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((r) => this.waiters.push(r))
      }
    }
  }
}
const userMsg = (text) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })

const cwd = mkdtempSync(join(tmpdir(), 'orgai-smoke-mcp-midrun-'))
const summary = []

/**
 * One session. steps: [{ before?(q, label), prompt }]. A step runs once the previous turn's result arrived and no
 * subagent task is still open. agentTools undefined = the main-thread definition omits `tools`.
 */
async function session(label, { agentTools, start, steps, agents = {}, maxTurns = 6, timeoutMs = 150_000 }) {
  const row = { label, agentTools: agentTools ?? '(omitted)', inits: [], calls: [], hooks: [], canUseTool: [], results: [], setMcp: null, status: null }
  summary.push(row)
  const input = new PushStream()
  const abort = new AbortController()
  const timer = setTimeout(() => {
    log(label, 'TIMEOUT', 'aborting')
    row.timedOut = true
    abort.abort()
  }, timeoutMs)
  const main = { description: 'Smoke main agent', prompt: 'You follow the user instructions exactly and briefly.', model: 'haiku' }
  if (agentTools) main.tools = agentTools
  const mcpServers = Object.fromEntries(start.map((n) => [n, server(n)]))
  row.servers = mcpServers
  const q = query({
    prompt: input,
    options: {
      cwd,
      model: 'haiku',
      permissionMode: 'default',
      settingSources: [],
      strictMcpConfig: true,
      mcpServers,
      agents: { main, ...agents },
      agent: 'main',
      maxTurns,
      abortController: abort,
      env: { ...process.env, CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1' },
      canUseTool: async (name, inp, o) => {
        const e = { name, agentID: o.agentID ?? 'root', mcpServer: o.mcpServer?.name }
        row.canUseTool.push(e)
        log(label, 'canUseTool', e)
        return { behavior: 'allow', updatedInput: inp }
      },
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (i) => {
                const e = { tool: i.tool_name, agent_type: i.agent_type ?? 'root', agent_id: i.agent_id ?? 'root' }
                row.hooks.push(e)
                log(label, 'PreToolUse', e)
                return {}
              }
            ]
          }
        ]
      }
    }
  })
  let step = 0
  const openTasks = new Set()
  const next = async () => {
    if (step >= steps.length) {
      input.end()
      return
    }
    const s = steps[step++]
    if (s.before) await s.before(q, row)
    log(label, 'push', s.prompt)
    input.push(userMsg(s.prompt))
  }
  await next()
  try {
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        const mcpTools = msg.tools.filter((t) => t.startsWith('mcp__') || t === 'Agent' || t === 'Task')
        row.inits.push(mcpTools.join(' '))
        log(label, 'init', { tools: mcpTools, mcp_servers: msg.mcp_servers, agents: msg.agents })
      } else if (msg.type === 'system' && msg.subtype === 'task_started') {
        if (!msg.task_type || msg.task_type === 'local_agent') openTasks.add(msg.task_id)
        log(label, 'task_started', { task_id: msg.task_id, subagent_type: msg.subagent_type })
      } else if (msg.type === 'system' && msg.subtype === 'task_notification') {
        openTasks.delete(msg.task_id)
        log(label, 'task_notification', { task_id: msg.task_id, status: msg.status })
      } else if (msg.type === 'assistant') {
        const who = msg.agent_id ?? (msg.parent_tool_use_id ? `sub(${msg.parent_tool_use_id.slice(-6)})` : 'root')
        for (const b of msg.message.content) {
          if (b.type === 'text' && b.text.trim()) log(label, `text ${who}`, b.text)
          if (b.type === 'tool_use') {
            row.calls.push(`${who}:${b.name}`)
            log(label, `tool_use ${who}`, { name: b.name, input: b.input })
          }
        }
      } else if (msg.type === 'user' && Array.isArray(msg.message.content)) {
        const who = msg.agent_id ?? (msg.parent_tool_use_id ? `sub(${msg.parent_tool_use_id.slice(-6)})` : 'root')
        for (const b of msg.message.content) {
          if (b.type !== 'tool_result') continue
          const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => c.text ?? '').join(' ')
          row.results.push(`${who}: ${trunc(text, 160)}${b.is_error ? ' [is_error]' : ''}`)
          log(label, `tool_result ${who}`, `${b.is_error ? '[is_error] ' : ''}${text}`)
        }
      } else if (msg.type === 'result') {
        row.status = msg.subtype
        row.totalCost = msg.total_cost_usd
        log(label, 'result', { subtype: msg.subtype, cost: msg.total_cost_usd, openTasks: openTasks.size, result: trunc(msg.result ?? '', 200) })
        // Reports still running: the SDK resumes the main agent when they land; wait for that result.
        if (openTasks.size) continue
        await next()
      }
    }
  } catch (e) {
    row.error = String(e?.message ?? e)
    log(label, 'ERROR', row.error)
  } finally {
    clearTimeout(timer)
  }
}

/** A `before` hook: attach more servers with setMcpServers, then log the result and mcpServerStatus tools. */
const attach = (names) => async (q, row) => {
  // Existing instances are sent again (setMcpServers replaces the dynamic set); only new names get a fresh server.
  for (const n of names) row.servers[n] ??= server(n)
  const res = await q.setMcpServers(Object.fromEntries(names.map((n) => [n, row.servers[n]])))
  let status = []
  try {
    status = (await q.mcpServerStatus()).map((s) => ({ name: s.name, status: s.status, tools: (s.tools ?? []).map((t) => t.name) }))
  } catch (e) {
    status = String(e?.message ?? e)
  }
  row.setMcp = { res, status }
  console.log(`[${row.label}] setMcpServers`, JSON.stringify(res), 'status', JSON.stringify(status))
}

const callPrompt = (srv) =>
  `Call the tool mcp__${srv}__ping exactly once and reply with exactly the text it returned. If you have no tool with that exact name, do not call anything else: reply NO-TOOL and list the names of every mcp__ tool you have.`

try {
  // a: suffix wildcard on the main thread.
  await session('A1 tools=[mcp__alpha__*]', { agentTools: ['mcp__alpha__*'], start: ['alpha'], steps: [{ prompt: callPrompt('alpha') }] })
  // a + b(i): server-level form; beta added later is outside the whitelist.
  await session('B1 tools=[mcp__alpha]', {
    agentTools: ['mcp__alpha'],
    start: ['alpha'],
    steps: [{ prompt: callPrompt('alpha') }, { before: attach(['alpha', 'beta']), prompt: callPrompt('beta') }]
  })
  // a + b(ii): mcp__* wildcard.
  await session('B2 tools=[mcp__*]', {
    agentTools: ['mcp__*'],
    start: ['alpha'],
    steps: [{ prompt: callPrompt('alpha') }, { before: attach(['alpha', 'beta']), prompt: callPrompt('beta') }]
  })
  // b(iii): tools omitted.
  await session('B3 tools omitted', {
    agentTools: undefined,
    start: ['alpha'],
    steps: [{ prompt: 'Reply READY.' }, { before: attach(['alpha', 'beta']), prompt: callPrompt('beta') }]
  })
  // c: subagents spawned after gamma was attached.
  const sub = (desc) => ({ description: desc, prompt: 'You follow the brief exactly and report briefly.', model: 'haiku' })
  await session('C subagents', {
    agentTools: ['Agent', 'mcp__*'],
    start: ['alpha'],
    maxTurns: 12,
    timeoutMs: 240_000,
    agents: {
      'helper-all': sub('Helper with tools omitted and no mcpServers.'),
      'helper-alpha': { ...sub('Helper whose mcpServers is [alpha].'), mcpServers: ['alpha'] },
      'helper-star': { ...sub('Helper whose tools is [mcp__*].'), tools: ['mcp__*'] }
    },
    steps: [
      { prompt: 'Reply READY.' },
      {
        before: attach(['alpha', 'gamma']),
        prompt:
          'Spawn three subagents with the Agent tool, one call each, subagent_type exactly "helper-all", "helper-alpha" and "helper-star". ' +
          'Give each this brief: "Call mcp__gamma__ping once and mcp__alpha__ping once. Report each output verbatim, or NO-TOOL for a tool you do not have, and list every mcp__ tool name you have." ' +
          'Do not call any mcp tool yourself. When all three have reported, list their reports and say DONE.'
      }
    ]
  })
} finally {
  rmSync(cwd, { recursive: true, force: true })
}

console.log('\n=== SUMMARY ===')
for (const r of summary) {
  console.log(`\n## ${r.label}  (main tools: ${JSON.stringify(r.agentTools)})  status=${r.status}${r.timedOut ? ' TIMEOUT' : ''}${r.error ? ` error=${r.error}` : ''} cost=${r.totalCost}`)
  r.inits.forEach((t, i) => console.log(`  init#${i + 1} mcp/agent tools: ${t || '(none)'}`))
  if (r.setMcp) console.log(`  setMcpServers: ${JSON.stringify(r.setMcp.res)} status: ${JSON.stringify(r.setMcp.status)}`)
  console.log(`  tool_use: ${r.calls.join(', ') || '(none)'}`)
  console.log(`  PreToolUse: ${r.hooks.map((h) => `${h.agent_type}:${h.tool}`).join(', ') || '(none)'}`)
  console.log(`  canUseTool: ${r.canUseTool.map((h) => `${h.agentID}:${h.name}`).join(', ') || '(none)'}`)
  r.results.forEach((t) => console.log(`  tool_result ${t}`))
}
