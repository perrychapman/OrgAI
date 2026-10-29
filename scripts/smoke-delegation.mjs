// Verifies the subagent event mapping OrgAI's live chart depends on:
// SubagentStart/Stop hook fields, task_started fields, and agent_id / parent_tool_use_id on messages.
import { query } from '@anthropic-ai/claude-agent-sdk'

const seen = []
const log = (kind, data) => {
  seen.push(kind)
  console.log(kind, JSON.stringify(data))
}

const hook = (name) => async (input, toolUseID) => {
  log(`hook:${name}`, {
    toolUseID,
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    tool_name: input.tool_name,
    subagent_type: input.tool_input?.subagent_type,
    last: input.last_assistant_message?.slice(0, 60)
  })
  return {}
}

for await (const msg of query({
  prompt: 'Use the fact-finder agent to get one fun fact about octopuses, wait for it, then repeat the fact to me in one sentence.',
  options: {
    cwd: process.cwd(),
    model: 'haiku',
    agents: {
      orchestrator: {
        description: 'Lead agent',
        prompt: 'You are the orchestrator. Delegate to fact-finder via the Agent tool with subagent_type "fact-finder". Do not answer from your own knowledge.',
        tools: ['Agent'],
        model: 'haiku'
      },
      'fact-finder': {
        description: 'Finds fun facts. Use for any fact lookup.',
        prompt: 'You answer with one short fun fact about the requested topic, from your own knowledge. No tools.',
        tools: [],
        model: 'haiku'
      }
    },
    agent: 'orchestrator',
    allowedTools: ['Agent'],
    settingSources: [],
    maxTurns: 6,
    env: { ...process.env, CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1' },
    hooks: {
      PreToolUse: [{ hooks: [hook('PreToolUse')] }],
      SubagentStart: [{ hooks: [hook('SubagentStart')] }],
      SubagentStop: [{ hooks: [hook('SubagentStop')] }]
    }
  }
})) {
  if (msg.type === 'system' && msg.subtype === 'init') log('init', { model: msg.model, agents: msg.agents })
  else if (msg.type === 'system' && (msg.subtype === 'task_started' || msg.subtype === 'task_notification'))
    log(`system:${msg.subtype}`, {
      task_id: msg.task_id,
      tool_use_id: msg.tool_use_id,
      parent_task_id: msg.parent_task_id,
      subagent_type: msg.subagent_type,
      description: msg.description,
      status: msg.status
    })
  else if (msg.type === 'assistant')
    log('assistant', {
      agent_id: msg.agent_id,
      parent_tool_use_id: msg.parent_tool_use_id,
      blocks: msg.message.content.map((b) => (b.type === 'tool_use' ? `tool_use:${b.name}:${b.id}` : b.type === 'text' ? `text:${b.text.slice(0, 50)}` : b.type))
    })
  else if (msg.type === 'user')
    log('user', {
      agent_id: msg.agent_id,
      parent_tool_use_id: msg.parent_tool_use_id,
      content: Array.isArray(msg.message.content) ? msg.message.content.map((b) => b.type) : 'string'
    })
  else if (msg.type === 'result') log('result', { subtype: msg.subtype, cost: msg.total_cost_usd, text: msg.result?.slice(0, 120) })
}
console.log('\nkinds seen:', [...new Set(seen)].join(', '))
