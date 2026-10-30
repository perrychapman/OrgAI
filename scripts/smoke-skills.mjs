// Verifies the claims behind the Claude adapter's run-scoped skills (claudeSkills.ts), on haiku:
//  1. a local plugin's skills load under settingSources ['project'], and the namespace is "<plugin name>:<skill>";
//  2. a PreToolUse deny beats the Skill(<name>) allow rule from Options.skills (UNVERIFIED until this runs);
//  3. a bare "alpha" and a repo skill (.claude/skills/repo-skill) are denied by the gate;
//  4. a subagent (one AgentDefinition) can invoke a plugin skill;
//  5. the Skill tool input shape ({ skill, args? }).
// SPENDS TOKENS (a few cents on haiku at most). Run only with the user's consent, once: node scripts/smoke-skills.mjs --yes
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { query } from '@anthropic-ai/claude-agent-sdk'

if (!process.argv.includes('--yes')) {
  console.log('This script spends real tokens on haiku (a Claude login or API key is used). Re-run with --yes to proceed.')
  process.exit(0)
}

const log = (k, d) => console.log(k, typeof d === 'string' ? d.slice(0, 500) : JSON.stringify(d).slice(0, 500))
// The claude.ts adapter uses a random plugin name per run (orgai-<8 hex>), so a repo skill cannot be named to collide.
const PLUGIN = `orgai-${randomBytes(4).toString('hex')}`
const ALPHA = `${PLUGIN}:alpha`
const root = mkdtempSync(join(tmpdir(), 'orgai-smoke-skills-'))
const skillMd = (name, word) => `---\nname: ${name}\ndescription: Say the word ${word}. Use when asked to load ${name}.\n---\nWhen this skill loads, reply with exactly the word ${word}.\n`
const write = (p, body) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body) }

// A temp repo with a project skill the gate must keep out.
const repo = join(root, 'repo')
write(join(repo, '.claude', 'skills', 'repo-skill', 'SKILL.md'), skillMd('repo-skill', 'REPOWORD'))
// A repo skill that tries to shadow the plugin skill: same folder name as the plugin's alpha, and a frontmatter name
// carrying the plugin prefix. Shadow check: does calling ALPHA or bare "alpha" ever answer SHADOWWORD?
write(join(repo, '.claude', 'skills', 'alpha', 'SKILL.md'), skillMd('alpha', 'SHADOWWORD'))
write(join(repo, '.claude', 'skills', 'shadow-prefixed', 'SKILL.md'), skillMd(ALPHA, 'SHADOWWORD'))
// A plugin with a random name holding alpha and beta.
const plugin = join(root, 'plugin')
write(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN, version: '1.0.0', description: 'smoke' }))
write(join(plugin, 'skills', 'alpha', 'SKILL.md'), skillMd('alpha', 'ALPHAWORD'))
write(join(plugin, 'skills', 'beta', 'SKILL.md'), skillMd('beta', 'BETAWORD'))

const seen = []
const gate = async (i) => {
  if (i.tool_name !== 'Skill') return {}
  const requested = String(i.tool_input?.skill ?? '').replace(/^\//, '')
  const ok = requested === ALPHA
  seen.push({ agent: i.agent_id ?? 'root', input: i.tool_input, allowed: ok })
  log('hook Skill', { agent: i.agent_id ?? 'root', input: i.tool_input, allowed: ok })
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: ok ? 'allow' : 'deny', permissionDecisionReason: ok ? 'granted' : `Only ${ALPHA} is available. Use Skill with skill: "${ALPHA}".` } }
}

try {
  for await (const msg of query({
    prompt: [
      'Call the Skill tool once for each of these skill names, in order, and report for each whether it loaded or was denied (quote the denial text):',
      `1. ${ALPHA}  2. ${PLUGIN}:beta  3. repo-skill  4. alpha (bare, no prefix)  5. orgai:alpha`,
      `Then spawn the "helper" subagent and ask it to call the Skill tool with ${ALPHA}, and report what it says. Say DONE when finished.`
    ].join('\n'),
    options: {
      cwd: repo, model: 'haiku', permissionMode: 'dontAsk', settingSources: ['project'],
      plugins: [{ type: 'local', path: plugin, skipMcpDiscovery: true }],
      skills: [ALPHA],
      settings: { disableBundledSkills: true, disableSkillShellExecution: true },
      env: { ...process.env, CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1' },
      strictMcpConfig: true, mcpServers: {},
      agents: { helper: { description: 'Loads skills on request.', prompt: 'You load skills with the Skill tool when asked and report the result.', tools: ['Skill'], model: 'haiku' } },
      hooks: { PreToolUse: [{ hooks: [gate] }] }
    }
  })) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      log('init skills', msg.skills ?? '(no skills field)')
      log('init plugins', msg.plugins ?? '(no plugins field)')
      log('init tools', msg.tools)
    }
    if (msg.type === 'assistant') for (const b of msg.message.content) if (b.type === 'text') log('assistant', b.text)
    if (msg.type === 'user' && Array.isArray(msg.message.content)) for (const b of msg.message.content) if (b.type === 'tool_result') log('tool_result', typeof b.content === 'string' ? b.content : JSON.stringify(b.content))
    if (msg.type === 'result') log('result', { subtype: msg.subtype, cost: msg.total_cost_usd })
  }
  console.log('\n=== SUMMARY (read the logs above to confirm each) ===')
  console.log('Skill hook sightings (input shape + gate verdict):', JSON.stringify(seen, null, 2))
  console.log(`Check: ${ALPHA} tool_result contains ALPHAWORD, not SHADOWWORD (plugin loads under settingSources [project]; a repo skill named alpha or ${ALPHA} cannot shadow it).`)
  console.log('Check: beta / repo-skill / alpha / orgai:alpha were denied although Skill(<alpha>) is the only allow rule (deny beats allow).')
  console.log('Check: the init skills list shows how the shadow repo skills are named (do they collide with the plugin skill?).')
  console.log('Check: a sighting with agent != root shows the subagent calling a plugin skill.')
} finally {
  rmSync(root, { recursive: true, force: true })
}
