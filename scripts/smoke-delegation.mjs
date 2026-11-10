// Verifies the subagent event mapping OrgAI's live chart depends on:
// SubagentStart/Stop hook fields, task_started fields, and agent_id / parent_tool_use_id on messages.
// `node scripts/smoke-delegation.mjs handback` (SDK 0.3.318): runs in permission mode 'auto', where a subagent reports
// through the built-in SubagentHandback tool. A manager must delegate to fact-worker: its first SubagentHandback is
// denied at PreToolUse (does it continue and hand back again?), and its first SubagentStop after a successful hand-back
// is blocked (does it continue, can it hand back a second time, and what does the root see?).
import { query } from '@anthropic-ai/claude-agent-sdk'

const handback = process.argv[2] === 'handback'
const seen = []
const t0 = Date.now()
const log = (kind, data) => {
  seen.push(kind)
  console.log(`${String(Date.now() - t0).padStart(6)}ms ${kind}`, JSON.stringify(data))
}
let handbackDenied = false
let managerStopBlocked = false

const hook = (name) => async (input, toolUseID) => {
  log(`hook:${name}`, {
    toolUseID,
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    tool_name: input.tool_name,
    subagent_type: input.tool_input?.subagent_type,
    message: input.tool_name === 'SubagentHandback' ? String(input.tool_input?.message ?? '').slice(0, 120) : undefined,
    response: input.tool_response === undefined ? undefined : JSON.stringify(input.tool_response).slice(0, 300),
    error: input.error === undefined ? undefined : String(input.error).slice(0, 200),
    stop_hook_active: input.stop_hook_active,
    lastLen: input.last_assistant_message?.length,
    last: input.last_assistant_message?.slice(0, 60)
  })
  if (!handback) return {}
  if (name === 'PreToolUse' && input.tool_name === 'SubagentHandback' && input.agent_type === 'manager' && !handbackDenied) {
    handbackDenied = true
    log('decision', { denyHandback: true })
    const reason = 'Harness: you cannot report yet. Spawn fact-worker with the Agent tool (subagent_type "fact-worker") first, then hand back its fact.'
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
  }
  if (name === 'SubagentStop' && input.agent_type === 'manager' && !managerStopBlocked) {
    managerStopBlocked = true
    log('decision', { blockStop: true })
    return { decision: 'block', reason: 'Harness: before you finish, also add one sentence about squid, and report again with SubagentHandback.' }
  }
  return {}
}

const agents = handback
  ? {
      orchestrator: {
        description: 'Lead agent',
        prompt: 'You are the orchestrator. Delegate to manager via the Agent tool with subagent_type "manager". Do not answer from your own knowledge. Quote every report you receive from it verbatim in your final answer.',
        tools: ['Agent'],
        model: 'haiku'
      },
      manager: {
        description: 'Manager. Use for fact requests.',
        prompt: 'You are a manager. Answer the request at once from your own knowledge and report it. Use a tool only when the harness tells you to.',
        tools: ['Agent'],
        model: 'haiku'
      },
      'fact-worker': {
        description: 'Finds one fun fact.',
        prompt: 'Answer with one short fun fact about the topic, starting with the words "WORKER FACT:". No tools.',
        tools: [],
        model: 'haiku'
      }
    }
  : {
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
    }

for await (const msg of query({
  prompt: handback
    ? 'Ask the manager agent (subagent_type "manager") for one fun fact about octopuses, wait for its report, then answer.'
    : 'Use the fact-finder agent to get one fun fact about octopuses, wait for it, then repeat the fact to me in one sentence.',
  options: {
    cwd: process.cwd(),
    model: 'haiku',
    agents,
    agent: 'orchestrator',
    allowedTools: ['Agent'],
    settingSources: [],
    maxTurns: handback ? 14 : 6,
    ...(handback ? { permissionMode: 'auto' } : {}),
    env: { ...process.env, CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: handback ? '2' : '1' },
    hooks: {
      PreToolUse: [{ hooks: [hook('PreToolUse')] }],
      ...(handback ? { PostToolUse: [{ hooks: [hook('PostToolUse')] }], PostToolUseFailure: [{ hooks: [hook('PostToolUseFailure')] }] } : {}),
      SubagentStart: [{ hooks: [hook('SubagentStart')] }],
      SubagentStop: [{ hooks: [hook('SubagentStop')] }]
    }
  }
})) {
  if (msg.type === 'system' && msg.subtype === 'init') log('init', { model: msg.model, agents: msg.agents, permissionMode: msg.permissionMode })
  else if (msg.type === 'system' && (msg.subtype === 'task_started' || msg.subtype === 'task_notification'))
    log(`system:${msg.subtype}`, {
      task_id: msg.task_id,
      tool_use_id: msg.tool_use_id,
      parent_task_id: msg.parent_task_id,
      subagent_type: msg.subagent_type,
      description: msg.description,
      status: msg.status,
      summary: msg.summary?.slice(0, 120),
      handback: msg.handback,
      handback_report: msg.handback_report === undefined ? undefined : JSON.stringify(msg.handback_report).slice(0, 160)
    })
  else if (msg.type === 'assistant')
    log('assistant', {
      agent_id: msg.agent_id,
      parent_tool_use_id: msg.parent_tool_use_id,
      blocks: msg.message.content.map((b) => (b.type === 'tool_use' ? `tool_use:${b.name}:${b.id}` : b.type === 'text' ? `text:${b.text.slice(0, handback ? 200 : 50)}` : b.type))
    })
  else if (msg.type === 'user')
    log('user', {
      agent_id: msg.agent_id,
      parent_tool_use_id: msg.parent_tool_use_id,
      content: Array.isArray(msg.message.content)
        ? msg.message.content.map((b) =>
            !handback ? b.type : b.type === 'tool_result' ? `tool_result:${b.tool_use_id}:${JSON.stringify(b.content).slice(0, 700)}` : b.type === 'text' ? `text:${b.text.slice(0, 700)}` : b.type
          )
        : handback
          ? `string:${String(msg.message.content).slice(0, 700)}`
          : 'string'
    })
  else if (msg.type === 'result') log('result', { subtype: msg.subtype, cost: msg.total_cost_usd, text: msg.result?.slice(0, handback ? 600 : 120) })
}
console.log('\nkinds seen:', [...new Set(seen)].join(', '))
