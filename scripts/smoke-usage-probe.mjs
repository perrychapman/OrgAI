// Can we read plan usage without sending a prompt? Open a query whose input stream never yields,
// call the usage control request as soon as init arrives, then abort. No model call should happen.
import { query } from '@anthropic-ai/claude-agent-sdk'

const abort = new AbortController()
let resolveNever
const never = { [Symbol.asyncIterator]() { return { next: () => new Promise((r) => { resolveNever = r }) } } }
const t0 = Date.now()
const q = query({ prompt: never, options: { cwd: process.cwd(), model: 'haiku', settingSources: [], abortController: abort, tools: [] } })

let sawInit = false
const reader = (async () => {
  for await (const msg of q) {
    if (msg.type === 'system' && msg.subtype === 'init') { sawInit = true; console.log('init after', Date.now() - t0, 'ms') }
    else if (msg.type === 'rate_limit_event') console.log('rate_limit_event', JSON.stringify(msg.rate_limit_info).slice(0, 200))
    else if (msg.type === 'result') console.log('result', msg.subtype, 'cost', msg.total_cost_usd)
    else console.log('msg', msg.type)
  }
})().catch((e) => console.log('reader ended:', e.message))

// Try the usage request immediately (before init) and again after init.
try {
  const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
  console.log('usage at', Date.now() - t0, 'ms | sawInit', sawInit, '| plan', u.subscription_type, '| available', u.rate_limits_available,
    '| five_hour', JSON.stringify(u.rate_limits?.five_hour), '| seven_day', JSON.stringify(u.rate_limits?.seven_day),
    '| session cost', u.session?.total_cost_usd)
} catch (e) { console.log('usage failed:', e.message) }
abort.abort()
resolveNever?.({ value: undefined, done: true })
await reader
console.log('done in', Date.now() - t0, 'ms')
