// Verifies three facts the network and unattended features rely on: permissionMode 'auto' runs
// without canUseTool for ordinary calls, Agent `name` makes a report addressable, and the real
// SendMessage input shape as seen by PreToolUse.
import { query } from '@anthropic-ai/claude-agent-sdk'
const log = (k, d) => console.log(k, JSON.stringify(d).slice(0, 500))
let asked = 0
for await (const msg of query({
  prompt: 'Spawn the worker agent (run_in_background true) with the task "wait for a message, then reply to the orchestrator with the word pong". Then use ListAgents, then SendMessage the worker (use its name) the text "ping". When its reply arrives, say DONE and stop.',
  options: {
    cwd: process.cwd(), model: 'haiku', permissionMode: 'auto', settingSources: [],
    env: { ...process.env, CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1' },
    agents: {
      orchestrator: { description: 'Lead', prompt: 'You coordinate. Reports are addressable by name with SendMessage.', tools: ['Agent', 'SendMessage', 'ListAgents'], model: 'haiku' },
      worker: { description: 'Worker', prompt: 'Wait for a message from the orchestrator; when it arrives, SendMessage back to "orchestrator" (or the lead) the word pong, then finish.', tools: ['SendMessage', 'ListAgents'], model: 'haiku' }
    },
    agent: 'orchestrator',
    canUseTool: async (name, input) => { asked++; log('canUseTool', { name, keys: Object.keys(input) }); return { behavior: 'allow', updatedInput: input } },
    hooks: { PreToolUse: [{ hooks: [async (i) => {
      if (i.tool_name === 'Agent') { log('hook Agent', { agent_id: i.agent_id, input: i.tool_input }); return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...i.tool_input, name: 'worker-1' } } } }
      if (i.tool_name === 'SendMessage' || i.tool_name === 'ListAgents') log('hook ' + i.tool_name, { agent_id: i.agent_id, agent_type: i.agent_type, input: i.tool_input })
      return {}
    }] }] }
  }
})) {
  if (msg.type === 'system' && msg.subtype === 'init') log('init', { mode: msg.permissionMode, tools: msg.tools })
  if (msg.type === 'system' && msg.subtype === 'task_started') log('task_started', { task_id: msg.task_id, subagent_type: msg.subagent_type, name: msg.name, keys: Object.keys(msg) })
  if (msg.type === 'user' && Array.isArray(msg.message.content)) for (const b of msg.message.content) if (b.type === 'tool_result') log('tool_result' + (msg.parent_tool_use_id ? ' (sub)' : ''), typeof b.content === 'string' ? b.content : b.content)
  if (msg.type === 'assistant' && !msg.parent_tool_use_id) for (const b of msg.message.content) if (b.type === 'text') log('text', b.text)
  if (msg.type === 'result') log('result', { subtype: msg.subtype, cost: msg.total_cost_usd, asked })
}
