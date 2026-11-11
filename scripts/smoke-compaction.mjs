// Smoke for compaction on the Claude Agent SDK (docs/agent-notes/sdk-facts.md "Compaction"). Spends real tokens: haiku,
// two sessions of a few requests each, the context filled by reading generated files. Run once, do not loop.
// The window is lowered to its documented minimum (CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000, the env twin of the
// `autoCompactWindow` setting, 100k to 1M) so a compaction happens after about 90k tokens instead of the default.
// Credentials: the shell's login, or ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY from the environment (never printed).
//
//   node scripts/smoke-compaction.mjs [root] [sub]
//
// root: the main thread reads five ~18k-token files and compacts. Observed: the SDK messages around it (system
//   status / compact_boundary), the PreCompact, PostCompact and SessionStart hooks (inputs), whether a SessionStart
//   hook's additionalContext (source 'compact') reaches the model after the compaction (MARKER-C1), and whether the
//   first user message survives (it carries SECRET-WORD; the model is asked for both after the compaction).
// sub: a subagent reads the files and compacts. Observed: which hooks fire with which agent_id, whether the SDK stream
//   carries a compact_boundary for it, and whether the root sees anything.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-smoke-compaction-')))
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
const want = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ['root', 'sub'])
const MODEL = process.env.SMOKE_MODEL || 'haiku'

// Five files of distinct, poorly compressible lines (~72k characters each, about 18k tokens).
let seed = 7
const rnd = () => (seed = (seed * 48271) % 2147483647)
const words = ['amber', 'basalt', 'cobalt', 'delta', 'ember', 'fjord', 'garnet', 'harbor', 'indigo', 'juniper', 'kestrel', 'lagoon', 'mesa', 'nickel', 'onyx', 'prairie', 'quartz', 'rivet', 'sierra', 'tundra']
for (const f of ['a', 'b', 'c', 'd', 'e']) {
  const lines = []
  for (let i = 0; i < 1100; i++) lines.push(`${f}-${i} ${Array.from({ length: 9 }, () => words[rnd() % words.length] + (rnd() % 997)).join(' ')}`)
  writeFileSync(join(dir, `${f}.txt`), lines.join('\n') + '\n')
}

const env = { ...process.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1' }

function stream(first) {
  const queue = [first]; let wake = null; let closed = false
  return {
    push(m) { queue.push(m); wake?.() },
    close() { closed = true; wake?.() },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift()
        if (closed) return
        await new Promise((r) => (wake = r)); wake = null
      }
    }
  }
}
const user = (text) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })

async function session(label, firstText, followUp, extra = {}) {
  const t0 = Date.now(); const stamp = () => Date.now() - t0
  const ev = { label, sys: [], hooks: [], results: [], texts: [], requests: 0 }
  const log = (kind) => async (input) => {
    const copy = { t: stamp(), kind, agent_id: input.agent_id ?? null, agent_type: input.agent_type ?? null }
    for (const k of ['trigger', 'source', 'custom_instructions', 'transcript_path', 'session_id', 'prompt_id']) if (k in input) copy[k] = input[k]
    if (input.compact_summary) copy.summaryChars = input.compact_summary.length
    ev.hooks.push(copy); console.log('hook', JSON.stringify(copy))
    if (kind === 'SessionStart' && input.source === 'compact') return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'MARKER-C1 slate-heron-4: the plan has 3 steps, step 2 is in progress.' } }
    return {}
  }
  const hooks = Object.fromEntries(['PreCompact', 'PostCompact', 'SessionStart', 'SubagentStart', 'SubagentStop'].map((k) => [k, [{ hooks: [log(k)] }]]))
  const input = stream(user(firstText))
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 300_000)
  let sentFollowUp = false
  try {
    for await (const msg of query({ prompt: input, options: { cwd: dir, model: MODEL, settingSources: [], env, hooks, abortController: ac, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, maxTurns: 30, ...extra } })) {
      if (msg.type === 'system' && msg.subtype !== 'init') {
        const s = { t: stamp(), subtype: msg.subtype, status: msg.status, compact_result: msg.compact_result, meta: msg.compact_metadata ? { trigger: msg.compact_metadata.trigger, pre: msg.compact_metadata.pre_tokens, post: msg.compact_metadata.post_tokens } : undefined, parent_tool_use_id: msg.parent_tool_use_id, task: msg.task_id }
        ev.sys.push(s); if (/compact|status/.test(msg.subtype)) console.log('sys', JSON.stringify(s))
      } else if (msg.type === 'assistant') {
        ev.requests++
        for (const b of msg.message.content) if (b.type === 'text' && b.text.trim()) ev.texts.push({ t: stamp(), child: !!msg.parent_tool_use_id, text: b.text.slice(0, 400) })
      } else if (msg.type === 'user' && msg.isCompactSummary !== undefined) {
        console.log('compact-summary user message', msg.isCompactSummary)
      } else if (msg.type === 'result') {
        ev.results.push({ t: stamp(), subtype: msg.subtype, cost: msg.total_cost_usd, text: (msg.result ?? '').slice(0, 400) })
        console.log('result', JSON.stringify(ev.results.at(-1)))
        if (!sentFollowUp && followUp) { sentFollowUp = true; input.push(user(followUp)) } else input.close()
      }
    }
  } finally { clearTimeout(timer) }
  return ev
}

const out = {}
if (want.has('root')) {
  out.root = await session('root',
    'SECRET-WORD: plum-anchor-9 (remember it). Read a.txt, b.txt, c.txt, d.txt and e.txt with the Read tool, one call per message, in that order. After the last one, reply with just the last line of e.txt.',
    'Two questions, answer from what you can see in your context right now, do not read any file: (1) quote every line in your context that starts with "MARKER-", or say NONE; (2) what was the SECRET-WORD in my first message? Say UNKNOWN if you cannot see it.')
}
if (want.has('sub')) {
  out.sub = await session('sub',
    'Use the Agent tool once with subagent_type "reader" and run_in_background false, prompt: "Read a.txt, b.txt, c.txt, d.txt and e.txt with the Read tool, one call per message, then report the last line of e.txt." Then reply with what it reported.',
    null,
    { agents: { reader: { description: 'Reads files', prompt: 'You read files and report.', tools: ['Read'], model: MODEL } } })
}
console.log('\n=== SUMMARY')
console.log(JSON.stringify(out, null, 1))
