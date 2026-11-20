// One benchmark session: the stub harness tools, the streaming conversation with the Architect, and the record it leaves.
// The model call is injected (`queryImpl`), so everything here except the real SDK `query` can run without a token (the
// runner's --self-check drives it with a scripted fake). Treat every string the model produced as data: it is only
// stored, clipped, never executed or used as a path.
import { viewsOf } from './score.mjs'
import { RETRO_NUDGE } from './load.mjs'

/** Built-in tools the Architect keeps in the benchmark: read-only exploration. Everything else is withheld. */
export const BUILTIN_TOOLS = ['Read', 'Glob', 'Grep']
export const WITHHELD_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebSearch', 'WebFetch', 'TodoWrite', 'Agent', 'Task']
export const MCP_PREFIX = 'mcp__orgai__'
export const ASK_REPLY = 'No preference, use your judgment.'
export const DONE_TEXT = 'The benchmark has what it needs. Stop now; do not call any more tools.'
export const notAvailable = (name) => `The tool ${name} is not available in this benchmark. Continue with what you have and do not call it again.`

const clip = (s, n = 600) => {
  const t = String(s ?? '')
  return t.length > n ? `${t.slice(0, n)}...` : t
}

export function newState() {
  return {
    done: null, // 'chart' | 'propose' | 'noChange' once the answer is captured
    chart: null, revision: null,
    reviseRounds: 0, toolErrors: 0, askUserCalls: 0, architectureCalls: 0, otherToolCalls: 0, otherTools: {}, builtinCalls: {},
    questionTurns: 0, followUps: 0, turns: 0, afterDone: 0, questions: [], errors: [], lastText: '', finalText: '',
    costUsd: 0, costExact: false, usage: null, sessionModel: null, results: 0
  }
}

/**
 * The stub handlers, one per real setup tool (same names). propose_architecture and propose_org_chart run the REAL handler
 * (so their validation and APPROVED / REVISE texts are the real ones); ask_user answers "no preference"; in the retro family
 * complete_setup also runs the real handler and counts as a valid ending; every other tool says it is not available.
 * @returns {Map<string, (args: unknown) => Promise<string>>}
 */
export function makeHandlers(built, scenario, state, onDone = () => {}) {
  const retro = scenario.family === 'retro'
  const real = new Map(built.tools.map((t) => [t.name, t]))
  const before = viewsOf(built.project.roles)
  const callReal = async (name, args) => {
    try {
      return await real.get(name).call(args)
    } catch (e) {
      state.toolErrors += 1
      return `REVISE. The call was not valid: ${clip(e?.message ?? e, 400)}`
    }
  }
  const handlers = new Map()
  for (const name of real.keys()) {
    handlers.set(name, async (args) => {
      if (state.done) return DONE_TEXT
      if (name === 'ask_user') {
        state.askUserCalls += 1
        return ASK_REPLY
      }
      if (name === 'propose_architecture') {
        state.architectureCalls += 1
        return callReal(name, args)
      }
      if (name === 'propose_org_chart') {
        built.probe.proposals.length = 0
        const text = await callReal(name, args)
        if (/^REVISE/.test(text)) {
          state.reviseRounds += 1
          return text
        }
        const req = built.probe.proposals.at(-1)
        if (!req || req.kind !== 'orgChart') return text
        const roles = req.payload.roles
        if (retro) {
          const drafts = Array.isArray(args?.roles) ? args.roles : []
          state.revision = { ending: 'propose', args: { title: args?.title, rationale: args?.rationale, roles: drafts, remove: Array.isArray(args?.remove) ? args.remove : [] }, listed: drafts.length, before, after: viewsOf(roles) }
          state.done = 'propose'
        } else {
          state.chart = { title: args?.title, rationale: args?.rationale, drafts: Array.isArray(args?.roles) ? args.roles : [], roles: viewsOf(roles) }
          state.done = 'chart'
        }
        onDone()
        return text
      }
      if (name === 'complete_setup' && retro) {
        const text = await callReal(name, args)
        if (/^REVISE/.test(text)) return text
        state.revision = { ending: 'noChange', summary: clip(args?.summary, 500), listed: 0, before, after: null }
        state.done = 'noChange'
        onDone()
        return text
      }
      state.otherToolCalls += 1
      state.otherTools[name] = (state.otherTools[name] ?? 0) + 1
      return notAvailable(name)
    })
  }
  return handlers
}

/** The streaming user input: the first message now, later ones pushed; the generator ends when closed. */
export function makeInput(first) {
  const queue = [first]
  const waiters = []
  let closed = false
  const wake = () => waiters.splice(0).forEach((w) => w())
  const userMessage = (text) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' })
  const iterable = (async function* () {
    for (;;) {
      if (queue.length) {
        yield userMessage(queue.shift())
        continue
      }
      if (closed) return
      await new Promise((r) => waiters.push(r))
    }
  })()
  return { iterable, push: (t) => { queue.push(t); wake() }, close: () => { closed = true; wake() } }
}

function usageOf(modelUsage) {
  const u = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
  for (const m of Object.values(modelUsage ?? {})) for (const k of Object.keys(u)) u[k] += Number(m?.[k] ?? 0) || 0
  return u
}

/** The in-process MCP server with the real tool names, descriptions and schemas (claude.ts buildHarnessServer, minus caller tracking). */
export function buildServer(sdk, built, handlers) {
  return sdk.createSdkMcpServer({
    name: 'orgai',
    version: '1.0.0',
    instructions: built.instructions,
    tools: built.tools.map((t) => sdk.tool(t.name, t.description, t.inputSchema.shape, async (args) => ({ content: [{ type: 'text', text: await handlers.get(t.name)(args) }] })))
  })
}

/**
 * Runs one session and returns its record (no score; the runner scores it).
 * deps: { built, scenario, repeat, model, sdk ({ query, tool, createSdkMcpServer }), queryImpl?, maxTurns, timeoutMs, maxBudgetUsd, maxFollowUps }
 * `queryImpl({ prompt, options }, { callTool })` defaults to sdk.query; the self-check passes a scripted fake.
 */
export async function runSession(deps) {
  const { built, scenario, repeat, model, sdk, maxTurns = 30, timeoutMs = 300_000, maxBudgetUsd, maxFollowUps = 2 } = deps
  const queryImpl = deps.queryImpl ?? ((args) => sdk.query(args))
  const state = newState()
  const abort = new AbortController()
  let q
  let doneTimer
  const onDone = () => {
    // End the session as soon as the answer is captured: stop the turn (the CLI then emits its result with the cost so far),
    // and abort after a grace period if it does not.
    setTimeout(() => { Promise.resolve(q?.interrupt?.()).catch(() => {}) }, 0)
    doneTimer = setTimeout(() => abort.abort(), deps.graceMs ?? 15_000)
  }
  const handlers = makeHandlers(built, scenario, state, onDone)
  const server = buildServer(sdk, built, handlers)
  const mcpNames = built.tools.map((t) => `${MCP_PREFIX}${t.name}`)
  const options = {
    cwd: deps.dir,
    model,
    settingSources: [],
    maxTurns,
    abortController: abort,
    persistSession: false,
    // The Architect agent as ClaudeSession builds it (claude.ts buildAgents / buildOptions): the role prompt, the role's tools
    // (here only the read-only ones) plus the harness tools, model 'inherit' (the --model flag picks the session model).
    agents: { architect: { description: built.architect.description, prompt: built.system, tools: [...BUILTIN_TOOLS, ...mcpNames], model: 'inherit' } },
    agent: 'architect',
    tools: [...BUILTIN_TOOLS],
    allowedTools: [...BUILTIN_TOOLS, ...mcpNames],
    disallowedTools: [...WITHHELD_TOOLS],
    permissionMode: 'dontAsk',
    mcpServers: { orgai: server },
    strictMcpConfig: true,
    env: { ...process.env, CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1' },
    ...(typeof maxBudgetUsd === 'number' && maxBudgetUsd > 0 ? { maxBudgetUsd } : {})
  }
  const input = makeInput(built.firstMessage)
  const timer = setTimeout(() => { state.errors.push('timeout'); abort.abort() }, timeoutMs)
  const t0 = Date.now()
  let lastWasResult = false
  try {
    q = queryImpl({ prompt: input.iterable, options }, { callTool: (name, args) => handlers.get(name)(args) })
    for await (const msg of q) {
      lastWasResult = msg.type === 'result'
      if (msg.type === 'system' && msg.subtype === 'init') state.sessionModel = clip(msg.model, 80)
      else if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
        const blocks = Array.isArray(msg.message?.content) ? msg.message.content : []
        const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
        if (text) {
          state.lastText = text
          state.finalText = text
        }
        for (const b of blocks) if (b?.type === 'tool_use' && BUILTIN_TOOLS.includes(b.name)) state.builtinCalls[b.name] = (state.builtinCalls[b.name] ?? 0) + 1
        if (state.done && ++state.afterDone > 8) break
      } else if (msg.type === 'result') {
        state.results += 1
        state.turns += Number(msg.num_turns ?? 0) || 0
        if (typeof msg.total_cost_usd === 'number') {
          state.costUsd = msg.total_cost_usd
          state.costExact = true
        }
        state.usage = usageOf(msg.modelUsage)
        if (state.done) break
        if (msg.is_error || (typeof msg.subtype === 'string' && msg.subtype.startsWith('error'))) {
          state.errors.push(clip(`result ${msg.subtype}${msg.errors?.length ? `: ${msg.errors.join('; ')}` : ''}`, 300))
          break
        }
        // The turn ended without an answer: the Architect asked in prose. Answer once per turn, at most maxFollowUps times.
        state.questionTurns += 1
        state.questions.push(clip(state.lastText, 600))
        state.lastText = ''
        if (state.followUps >= maxFollowUps) break
        state.followUps += 1
        input.push(scenario.answers ?? RETRO_NUDGE)
      }
    }
  } catch (e) {
    if (!state.errors.includes('timeout')) state.errors.push(clip(e?.message ?? e, 300))
  } finally {
    clearTimeout(timer)
    clearTimeout(doneTimer)
    input.close()
    try { q?.close?.() } catch { /* already closed */ }
  }
  const durationMs = Date.now() - t0
  if (state.done && !lastWasResult) state.costExact = false // the tail after the capture may have cost more than the last result reported
  const retro = scenario.family === 'retro'
  const answered = state.done !== null
  return {
    family: scenario.family, scenarioId: scenario.id, repeat, model, kind: scenario.kind, complexity: scenario.complexity,
    status: answered ? 'ok' : state.errors.length && !state.questionTurns ? 'error' : retro ? 'noEnding' : 'noChart',
    chart: retro ? null : state.chart, revision: retro ? state.revision : null,
    reviseRounds: state.reviseRounds, toolErrors: state.toolErrors, askUserCalls: state.askUserCalls, architectureCalls: state.architectureCalls,
    otherToolCalls: state.otherToolCalls, otherTools: state.otherTools, builtinCalls: state.builtinCalls,
    questionTurns: state.questionTurns, followUps: state.followUps, questions: state.questions, turns: state.turns,
    durationMs, costUsd: state.costUsd, costExact: state.costExact, usage: state.usage,
    systemPromptWords: built.system.trim().split(/\s+/).length, firstMessageWords: built.firstMessage.trim().split(/\s+/).length,
    sessionModel: state.sessionModel, finalText: clip(state.finalText, 1200), errors: state.errors
  }
}
