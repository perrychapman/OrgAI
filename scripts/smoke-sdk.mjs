// Smoke test for the Claude Agent SDK path OrgAI relies on. Two one-turn haiku calls, no tools.
import { query } from '@anthropic-ai/claude-agent-sdk'

async function run(label, params) {
  const t0 = Date.now()
  let text = ''
  let init
  let result
  for await (const msg of query(params)) {
    if (msg.type === 'system' && msg.subtype === 'init') init = msg
    if (msg.type === 'assistant') for (const b of msg.message.content) if (b.type === 'text') text += b.text
    if (msg.type === 'result') result = msg
  }
  console.log(`\n== ${label} (${Date.now() - t0} ms)`)
  console.log('model:', init?.model, '| agents:', init?.agents, '| tools:', init?.tools?.length)
  console.log('result:', result?.subtype, '| cost:', result?.total_cost_usd)
  console.log('text:', JSON.stringify(text.slice(0, 200)))
}

// 1. The drafter path: custom system prompt, no tools, one turn.
await run('complete()', {
  prompt: 'Reply with exactly the word READY and nothing else.',
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

// 2. The org-chart path: main thread runs as a programmatic agent definition.
await run('agent option', {
  prompt: 'What is your role name? Answer in five words or fewer.',
  options: {
    cwd: process.cwd(),
    model: 'haiku',
    agents: {
      orchestrator: {
        description: 'Lead agent',
        prompt: 'Your role name is Orchestrator Prime. You lead a team of specialists.',
        tools: [],
        model: 'haiku'
      }
    },
    agent: 'orchestrator',
    maxTurns: 1,
    settingSources: [],
    permissionMode: 'dontAsk'
  }
})
