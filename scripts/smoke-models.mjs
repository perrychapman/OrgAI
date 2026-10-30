// Which models does the bundled Claude CLI offer? Open a query whose input stream never yields, ask
// supportedModels() (the initialize response, so no model call), print the list as JSON, then abort.
// Token-free: no prompt is ever sent. It does spawn the bundled CLI, so run it only with the user's consent.
// Mirrors ClaudeAdapter.listModels in src/main/runtime/claude.ts.
import { query } from '@anthropic-ai/claude-agent-sdk'

const abort = new AbortController()
let resolveNever
const never = { [Symbol.asyncIterator]() { return { next: () => new Promise((r) => { resolveNever = r }) } } }
const t0 = Date.now()
const q = query({ prompt: never, options: { cwd: process.cwd(), settingSources: [], abortController: abort, tools: [] } })
const reader = (async () => { for await (const _ of q) void _ })().catch(() => {})

try {
  const models = await Promise.race([
    q.supportedModels(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 10 s')), 10_000))
  ])
  console.log('supportedModels after', Date.now() - t0, 'ms')
  console.log(JSON.stringify(models, null, 2))
} catch (e) { console.log('supportedModels failed:', e.message) }
abort.abort()
resolveNever?.({ value: undefined, done: true })
await reader
console.log('done in', Date.now() - t0, 'ms')
