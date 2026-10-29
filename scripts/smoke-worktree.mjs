// Verifies agent worktree isolation as OrgAI will use it: the PreToolUse hook injects
// isolation:"worktree" into an Agent call, then we observe the WorktreeCreate/Remove hooks,
// what the parent receives as the tool result, and what is left in the repo afterwards.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { execSync } from 'node:child_process'

const cwd = process.argv[2]
if (!cwd) throw new Error('usage: node smoke-worktree.mjs <git repo path>')
const log = (kind, data) => console.log(kind, JSON.stringify(data).slice(0, 600))
const git = (args) => { try { return execSync(`git ${args}`, { cwd, encoding: 'utf8' }).trim() } catch (e) { return `ERR ${e.message.split('\n')[0]}` } }

for await (const msg of query({
  prompt: 'Delegate to the writer agent: create a file named NOTE.txt containing the single line "hello from the worktree", then wait for its report and tell me verbatim what it reported, including any branch or path it mentions.',
  options: {
    cwd,
    model: 'haiku',
    permissionMode: 'acceptEdits',
    settingSources: [],
    agents: {
      orchestrator: { description: 'Lead', prompt: 'You delegate with the Agent tool using subagent_type "writer". Never write files yourself.', tools: ['Agent'], model: 'haiku' },
      writer: { description: 'Writes files', prompt: 'Write exactly the file you are asked for, then report the absolute path you wrote and the output of `git status --short` and `git branch --show-current`.', tools: ['Write', 'Bash'], model: 'haiku' }
    },
    agent: 'orchestrator',
    env: { ...process.env, CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1' },
    hooks: {
      PreToolUse: [{ hooks: [async (i) => {
        if (i.tool_name === 'Agent') {
          log('hook:pre Agent input', i.tool_input)
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...i.tool_input, isolation: 'worktree' } } }
        }
        log('hook:pre', { tool: i.tool_name, agent_id: i.agent_id, cwd: i.cwd })
        return {}
      }] }],
      // Note: registering WorktreeCreate/WorktreeRemove hooks makes the host responsible for
      // creating/removing the worktree (the hook must return worktreePath). Leave them out to
      // get the CLI's built-in behaviour under <repo>/.claude/worktrees.
      SubagentStop: [{ hooks: [async (i) => { log('hook:SubagentStop', { agent_id: i.agent_id, last: i.last_assistant_message?.slice(0, 300) }); return {} }] }]
    }
  }
})) {
  if (msg.type === 'system' && (msg.subtype === 'task_started' || msg.subtype === 'task_notification')) log(msg.subtype, msg)
  if (msg.type === 'user' && Array.isArray(msg.message.content)) for (const b of msg.message.content) if (b.type === 'tool_result' && !msg.parent_tool_use_id) log('parent tool_result', typeof b.content === 'string' ? b.content : b.content)
  if (msg.type === 'assistant' && !msg.parent_tool_use_id) for (const b of msg.message.content) if (b.type === 'text') log('orchestrator text', b.text)
  if (msg.type === 'result') log('result', { subtype: msg.subtype, cost: msg.total_cost_usd })
}
console.log('--- after ---')
console.log('worktree list:', git('worktree list'))
console.log('branches:', git('branch -a'))
console.log('status:', git('status --short'))
console.log('NOTE.txt in main checkout:', git('ls-files --others --exclude-standard NOTE.txt') || '(absent)')
