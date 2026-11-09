// Smoke for docs/design/delegation-enforcement.md §5.3 (spends real tokens on haiku; run once per question).
//   S1: does SubagentStop {decision:'block', reason} keep a subagent going, and does it see the reason?
//   S2: does PostToolUse additionalContext (variant A) / updatedToolOutput (variant B) on the Agent call reach the parent?
//   S3: does run_in_background:false make a nested Agent call return only after the child's SubagentStop, and what is the
//       event order? Variant C leaves the default (background) for the nested spawn: does the manager get its worker's report?
// Usage: node scripts/smoke-delegation-gate.mjs [A|B|C]
import { query } from '@anthropic-ai/claude-agent-sdk'

const variant = (process.argv[2] ?? 'A').toUpperCase()
const t0 = Date.now()
const log = (kind, data) => console.log(`${String(Date.now() - t0).padStart(6)}ms ${kind}`, JSON.stringify(data ?? {}))
const TOKEN = 'RECEIPT-7731'
let managerStops = 0

const hooks = {
  PreToolUse: [
    {
      hooks: [
        async (input) => {
          log('hook:PreToolUse', { agent: input.agent_type ?? 'root', tool: input.tool_name, id: input.tool_use_id, bg: input.tool_input?.run_in_background, sub: input.tool_input?.subagent_type })
          if (input.tool_name === 'Agent' && variant !== 'C') {
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, run_in_background: false } } }
          }
          return {}
        }
      ]
    }
  ],
  PostToolUse: [
    {
      hooks: [
        async (input) => {
          const out = typeof input.tool_response === 'string' ? input.tool_response : JSON.stringify(input.tool_response)
          log('hook:PostToolUse', { agent: input.agent_type ?? 'root', tool: input.tool_name, id: input.tool_use_id, response: out?.slice(0, 160) })
          if (input.tool_name !== 'Agent' || (input.agent_type && input.agent_type !== 'orchestrator')) return {}
          const receipt = `Harness receipt ${TOKEN}: the manager's run record shows its worker children. Mention the code ${TOKEN} in your final answer.`
          if (variant === 'B') return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: `${receipt}\n\n${out}` } }
          return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: receipt } }
        }
      ]
    }
  ],
  SubagentStart: [{ hooks: [async (input) => (log('hook:SubagentStart', { id: input.agent_id, type: input.agent_type }), {})] }],
  SubagentStop: [
    {
      hooks: [
        async (input) => {
          log('hook:SubagentStop', { id: input.agent_id, type: input.agent_type, stop_hook_active: input.stop_hook_active, last: input.last_assistant_message?.slice(0, 160) })
          if (input.agent_type === 'manager' && variant !== 'C') {
            managerStops++
            if (managerStops === 1) {
              const reason = 'Harness: you cannot finish yet. Your role must delegate to fact-worker and receive its report. Spawn it now with the Agent tool (subagent_type "fact-worker"), wait for its report, then finish with that report.'
              log('decision', { block: true })
              return { decision: 'block', reason }
            }
          }
          return {}
        }
      ]
    }
  ]
}

for await (const msg of query({
  prompt: 'Ask the manager agent for one fun fact about octopuses (Agent tool, subagent_type "manager"), then give me its answer in one sentence.',
  options: {
    cwd: process.cwd(),
    model: 'haiku',
    agents: {
      orchestrator: {
        description: 'Lead agent',
        prompt: 'You are the lead. Delegate to the manager via the Agent tool with subagent_type "manager". Do not answer from your own knowledge. Wait for its report. If anything you receive contains a harness receipt code, end your answer with that code verbatim.',
        tools: ['Agent'],
        model: 'haiku'
      },
      manager: {
        description: 'Manager. Use for fact requests.',
        prompt:
          variant === 'C'
            ? 'You are a manager. Delegate the fact to fact-worker with the Agent tool (subagent_type "fact-worker"), then report its fact.'
            : 'You are a manager. Answer the request yourself, immediately, in one sentence, from your own knowledge. Do not use any tools unless the harness tells you to.',
        tools: ['Agent'],
        model: 'haiku'
      },
      'fact-worker': {
        description: 'Finds one fun fact.',
        prompt: 'Answer with one short fun fact about the topic, starting with the words "WORKER FACT:". No tools.',
        tools: [],
        model: 'haiku'
      }
    },
    agent: 'orchestrator',
    allowedTools: ['Agent'],
    settingSources: [],
    maxTurns: 12,
    env: { ...process.env, CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '2' },
    hooks
  }
})) {
  if (msg.type === 'system' && (msg.subtype === 'task_started' || msg.subtype === 'task_notification' || msg.subtype === 'task_updated'))
    log(`system:${msg.subtype}`, { task_id: msg.task_id, tool_use_id: msg.tool_use_id, parent_task_id: msg.parent_task_id, type: msg.subagent_type, status: msg.status ?? msg.patch?.status, summary: msg.summary?.slice(0, 120) })
  else if (msg.type === 'assistant')
    log('assistant', { agent_id: msg.agent_id ?? 'root', blocks: msg.message.content.map((b) => (b.type === 'tool_use' ? `tool_use:${b.name}:${b.id}:${JSON.stringify(b.input).slice(0, 80)}` : b.type === 'text' ? `text:${b.text.slice(0, 160)}` : b.type)) })
  else if (msg.type === 'user')
    log('user', { agent_id: msg.agent_id ?? 'root', parent_tool_use_id: msg.parent_tool_use_id, content: Array.isArray(msg.message.content) ? msg.message.content.map((b) => (b.type === 'tool_result' ? `tool_result:${b.tool_use_id}:${JSON.stringify(b.content).slice(0, msg.agent_id ? 200 : 4000)}` : b.type === 'text' ? `text:${b.text.slice(0, 200)}` : b.type)) : `string:${String(msg.message.content).slice(0, 200)}` })
  else if (msg.type === 'result') log('result', { subtype: msg.subtype, cost: msg.total_cost_usd, text: msg.result?.slice(0, 300) })
}
console.log(`\nvariant ${variant}: managerStops=${managerStops}; root mentions ${TOKEN}: see result text above`)
