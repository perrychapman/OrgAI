// Verifies the mechanism behind request_permission_rules: a PreToolUse hook that answers
// permissionDecision 'allow' bypasses the permission system in every mode (here the strictest one,
// 'dontAsk', which denies anything not pre-approved), and the same hook lets the in-process harness
// tools through. Flow: Bash is denied, the agent asks for a rule through the MCP tool, the harness
// "grants" it into a runtime set, and the retried Bash call is allowed by the hook alone.
// Costs a fraction of a cent on haiku. Do not run in loops.
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
const log = (k, d) => console.log(k, typeof d === 'string' ? d.slice(0, 400) : JSON.stringify(d).slice(0, 400))
const granted = new Set()
let asked = 0
const bashCalls = []
const server = createSdkMcpServer({
  name: 'orgai',
  version: '1.0.0',
  tools: [
    tool(
      'request_permission_rules',
      'Ask the user to allow tool calls matching permission rules such as Bash(echo:*). Returns GRANTED or DENIED.',
      { rules: z.array(z.string()), reason: z.string() },
      async ({ rules, reason }) => {
        log('tool request_permission_rules', { rules, reason })
        for (const r of rules) granted.add(r)
        return { content: [{ type: 'text', text: `GRANTED: ${rules.join(', ')}. Retry the command now.` }] }
      }
    )
  ]
})
const matches = (cmd) => [...granted].some((r) => { const m = /^Bash\((.*):\*\)$/.exec(r); return m && cmd.trim().startsWith(m[1]) })
for await (const msg of query({
  prompt: `Run the shell command node -e 'console.log("hook-ok")' with Bash and report its output verbatim. If the call is denied, call request_permission_rules with rules ["Bash(node:*)"] and a one-line reason, then run the command again. Say DONE when finished.`,
  options: {
    cwd: process.cwd(), model: 'haiku', permissionMode: 'dontAsk', settingSources: [],
    mcpServers: { orgai: server },
    strictMcpConfig: true,
    canUseTool: async (name, input) => { asked++; log('canUseTool', { name }); return { behavior: 'deny', message: 'canUseTool should not be consulted in dontAsk' } },
    hooks: { PreToolUse: [{ hooks: [async (i) => {
      if (i.tool_name.startsWith('mcp__orgai__')) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'harness tool' } }
      if (i.tool_name === 'Bash') {
        const ok = matches(String(i.tool_input?.command ?? ''))
        bashCalls.push({ command: i.tool_input?.command, hookAllowed: ok })
        log('hook Bash', { command: i.tool_input?.command, hookAllowed: ok })
        if (ok) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'granted rule' } }
      }
      return {}
    }] }] }
  }
})) {
  if (msg.type === 'system' && msg.subtype === 'init') log('init', { mode: msg.permissionMode, tools: msg.tools.filter((t) => t.includes('orgai') || t === 'Bash') })
  if (msg.type === 'user' && Array.isArray(msg.message.content)) for (const b of msg.message.content) if (b.type === 'tool_result') log('tool_result', typeof b.content === 'string' ? b.content : JSON.stringify(b.content))
  if (msg.type === 'assistant') for (const b of msg.message.content) if (b.type === 'text') log('text', b.text)
  if (msg.type === 'result') {
    const denied = bashCalls.some((c) => !c.hookAllowed)
    const allowed = bashCalls.some((c) => c.hookAllowed)
    const sawOutput = msg.subtype === 'success' && /hook-ok/.test(msg.result ?? '')
    log('result', { subtype: msg.subtype, cost: msg.total_cost_usd, canUseToolCalls: asked, bashCalls, granted: [...granted] })
    console.log(denied && allowed && sawOutput && asked === 0 ? 'PERMISSION HOOK OK' : 'PERMISSION HOOK FAILED')
  }
}
