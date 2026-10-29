// Verifies the in-process MCP tool round-trip OrgAI's setup flow depends on:
// a root agent (options.agent) restricted to an SDK MCP tool, the tool name as seen by
// PreToolUse / canUseTool, and that the handler's returned text reaches the model.
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

const seen = []
const log = (kind, data) => { seen.push(kind); console.log(kind, JSON.stringify(data)) }

const server = createSdkMcpServer({
  name: 'orgai',
  tools: [
    tool('propose_plan', 'Propose a plan to the user. Blocks until they decide.', { title: z.string(), steps: z.array(z.string()) }, async (args) => {
      log('handler', args)
      return { content: [{ type: 'text', text: 'REVISE: the user wants exactly two steps.' }] }
    })
  ]
})

for await (const msg of query({
  prompt: 'Propose a three-step plan for making tea using propose_plan. If the user asks for changes, call it again with the revised plan, then say DONE.',
  options: {
    cwd: process.cwd(),
    model: 'haiku',
    permissionMode: 'acceptEdits',
    settingSources: [],
    mcpServers: { orgai: server },
    agents: {
      architect: { description: 'Planner', prompt: 'You plan. Use the propose_plan tool from the orgai MCP server for every proposal.', tools: ['mcp__orgai__propose_plan'], model: 'haiku' }
    },
    agent: 'architect',
    canUseTool: async (name, input) => { log('canUseTool', { name, keys: Object.keys(input) }); return { behavior: 'allow', updatedInput: input } },
    hooks: {
      PreToolUse: [{ hooks: [async (i) => { log('hook:pre', { tool_name: i.tool_name, agent_type: i.agent_type }); return {} }] }]
    }
  }
})) {
  if (msg.type === 'system' && msg.subtype === 'init') log('init', { tools: msg.tools, mcp: msg.mcp_servers })
  if (msg.type === 'assistant') for (const b of msg.message.content) { if (b.type === 'text') log('text', b.text.slice(0, 120)); if (b.type === 'tool_use') log('tool_use', { name: b.name }) }
  if (msg.type === 'result') log('result', { subtype: msg.subtype, cost: msg.total_cost_usd })
}
console.log('SEEN', seen.join(','))
