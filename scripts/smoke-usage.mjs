// Smoke test for subscription usage reporting. One haiku turn, no tools. After init it calls the
// experimental usage method and prints the response verbatim, logs every rate_limit_event, and the result.
import { query } from '@anthropic-ai/claude-agent-sdk'

const t0 = Date.now()
let resolveFirst
const usageDone = new Promise((r) => (resolveFirst = r))
async function* prompt() {
  yield { type: 'user', message: { role: 'user', content: 'Reply with exactly the word READY and nothing else.' }, parent_tool_use_id: null }
  // Keep the input open until the usage call has answered, so the session stays live.
  await usageDone
}

const q = query({
  prompt: prompt(),
  options: {
    cwd: process.cwd(),
    model: 'haiku',
    systemPrompt: { type: 'custom', prompt: 'You are a terse assistant.' },
    tools: [],
    maxTurns: 1,
    settingSources: [],
    permissionMode: 'dontAsk'
  }
})

let usageAsked = false
for await (const msg of q) {
  if (msg.type === 'system' && msg.subtype === 'init' && !usageAsked) {
    usageAsked = true
    console.log('init model:', msg.model, '| apiKeySource:', msg.apiKeySource)
    try {
      const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
      if (typeof fn !== 'function') console.log('usage method: missing')
      else {
        const resp = await fn.call(q, { skipBehaviors: true })
        console.log('usage response:', JSON.stringify(resp, null, 2))
      }
    } catch (e) {
      console.log('usage method threw:', e?.message ?? String(e))
    }
    resolveFirst()
  }
  if (msg.type === 'rate_limit_event') console.log('rate_limit_event:', JSON.stringify(msg))
  if (msg.type === 'assistant' && msg.error) console.log('assistant error:', msg.error)
  if (msg.type === 'result') {
    console.log('result:', msg.subtype, '| cost:', msg.total_cost_usd, `| ${Date.now() - t0} ms`)
    resolveFirst()
  }
}
