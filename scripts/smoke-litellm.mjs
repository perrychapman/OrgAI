// Smoke test for a LiteLLM proxy as the Claude Agent SDK backend.
//   LITELLM_BASE_URL=http://localhost:4000 LITELLM_API_KEY=sk-... node scripts/smoke-litellm.mjs        (free: lists models)
//   ... node scripts/smoke-litellm.mjs --yes                                                             (one tiny query; spends tokens)
// The key is never printed.
import { query } from '@anthropic-ai/claude-agent-sdk'

const base = (process.env.LITELLM_BASE_URL ?? '').replace(/\/+$/, '')
const key = process.env.LITELLM_API_KEY ?? ''
if (!base) {
  console.error('Set LITELLM_BASE_URL (and LITELLM_API_KEY if the proxy needs one).')
  process.exit(2)
}
const headers = key ? { Authorization: `Bearer ${key}` } : {}

async function getJson(path) {
  try {
    const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(15000) })
    if (!res.ok) return { error: `HTTP ${res.status} ${res.statusText}` }
    return { data: await res.json() }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

function family(id) {
  const m = id.toLowerCase()
  if (m.includes('claude') || m.includes('anthropic') || /\b(opus|sonnet|haiku)\b/.test(m)) return 'claude'
  if (/gpt|^o\d|openai|codex/.test(m)) return 'openai'
  if (m.includes('gemini') || m.includes('palm')) return 'google'
  if (m.includes('llama') || m.includes('mistral') || m.includes('qwen') || m.includes('deepseek')) return 'open-weights'
  return 'other'
}

const models = await getJson('/v1/models')
if (models.error) console.log(`GET /v1/models failed: ${models.error}`)
const ids = (models.data?.data ?? []).map((m) => m.id).filter(Boolean)
const info = await getJson('/model/info')
if (info.error) console.log(`GET /model/info failed: ${info.error} (non-LiteLLM or restricted key; not fatal)`)
for (const entry of info.data?.data ?? []) if (entry.model_name && !ids.includes(entry.model_name)) ids.push(entry.model_name)

const groups = {}
for (const id of ids) (groups[family(id)] ??= []).push(id)
console.log(`\n${ids.length} model id(s) at ${base}`)
for (const [fam, list] of Object.entries(groups)) console.log(`  ${fam} (${list.length}): ${list.sort().join(', ')}`)

const claude = (groups.claude ?? []).sort()
const chosen = claude.find((id) => /sonnet/i.test(id)) ?? claude[0]
if (!process.argv.includes('--yes')) {
  console.log(`\nNo tokens spent. Re-run with --yes to send one tiny query${chosen ? ` through "${chosen}"` : ''}.`)
  process.exit(0)
}
if (!chosen) {
  console.error('\nNo claude-family model in the list; cannot run the Agent SDK query.')
  process.exit(1)
}

console.log(`\nQuerying through the proxy with ANTHROPIC_DEFAULT_SONNET_MODEL=${chosen} ...`)
let text = ''
let init
let result
try {
  for await (const msg of query({
    prompt: 'Reply with exactly the word READY and nothing else.',
    options: {
      cwd: process.cwd(),
      model: 'sonnet',
      tools: [],
      maxTurns: 1,
      settingSources: [],
      permissionMode: 'dontAsk',
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: base,
        ANTHROPIC_AUTH_TOKEN: key,
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_DEFAULT_SONNET_MODEL: chosen
      }
    }
  })) {
    if (msg.type === 'system' && msg.subtype === 'init') init = msg
    if (msg.type === 'assistant') for (const b of msg.message.content) if (b.type === 'text') text += b.text
    if (msg.type === 'result') result = msg
  }
} catch (e) {
  console.error('Query failed:', e instanceof Error ? e.message : String(e))
  process.exit(1)
}
console.log('init model:', init?.model)
console.log('result:', result?.subtype, '| cost:', result?.total_cost_usd, '| models used:', Object.keys(result?.modelUsage ?? {}).join(', ') || '(none reported)')
console.log('text:', JSON.stringify(text.slice(0, 200)))
console.log(/ready/i.test(text) ? 'PASS: the proxy model answered.' : 'FAIL: no READY answer.')
