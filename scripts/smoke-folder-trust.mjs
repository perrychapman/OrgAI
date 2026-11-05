// Folder config trust: what the Claude CLI does with a project's own .claude/settings.json under the three settings
// source choices OrgAI can make. WRITTEN, NOT RUN. This spends tokens (three short haiku conversations, a fraction of a
// cent each) and the project settings it creates contain hooks that really execute on this machine, so it needs the
// user's explicit consent and refuses to start without --yes. Do not run it in loops or in CI.
//
//   node scripts/smoke-folder-trust.mjs --yes
//
// Each case works in its own temp dir whose .claude/settings.json holds a SessionStart and a PreToolUse hook that append
// to marker files, and `env: { ORGAI_SMOKE_ENV: 'from-settings' }`. A Bash call prints the variable.
//   (a) settingSources []          : expect no marker files; the Bash call sees options.env's 'from-options'.
//   (b) settingSources ['project'] : expect both markers; the Bash call sees 'from-settings' (no options.env value).
//   (c) settingSources ['project'] + options.env ORGAI_SMOKE_ENV='from-options': prints which value wins.
// It prints one result line per case. The run's conclusion for OrgAI: (a) must hold for an untrusted folder, and (c)
// says whether OrgAI's env can override a repository's settings env when the folder is trusted.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.argv.includes('--yes')) {
  console.error('This script spends tokens and runs hooks from a generated settings file. Run it only with the user\'s consent: node scripts/smoke-folder-trust.mjs --yes')
  process.exit(2)
}

const q = (s) => JSON.stringify(s)

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'orgai-fct-smoke-'))
  const marks = { session: join(dir, 'marker-session.txt'), pretool: join(dir, 'marker-pretool.txt') }
  const hook = (file) => ({ type: 'command', command: `${q(process.execPath)} -e ${q(`require('fs').appendFileSync(${JSON.stringify(file)}, 'ran\\n')`)}` })
  mkdirSync(join(dir, '.claude'))
  writeFileSync(
    join(dir, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [hook(marks.session)] }], PreToolUse: [{ hooks: [hook(marks.pretool)] }] }, env: { ORGAI_SMOKE_ENV: 'from-settings' } }, null, 2)
  )
  return { dir, marks }
}

async function runCase(name, settingSources, optionsEnv) {
  const { dir, marks } = makeDir()
  let seen = '(no Bash result)'
  let cost = 0
  try {
    const printEnv = `${q(process.execPath)} -e ${q(`console.log('ENV=' + process.env.ORGAI_SMOKE_ENV)`)}`
    for await (const msg of query({
      prompt: `Run exactly this command with the Bash tool and then say DONE: ${printEnv}`,
      options: {
        cwd: dir,
        model: 'haiku',
        maxTurns: 4,
        settingSources,
        ...(optionsEnv ? { env: { ...process.env, ORGAI_SMOKE_ENV: optionsEnv } } : {}),
        canUseTool: async (tool, input) => (tool === 'Bash' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'smoke test: Bash only' })
      }
    })) {
      if (msg.type === 'user' && Array.isArray(msg.message.content)) {
        for (const b of msg.message.content) {
          if (b.type !== 'tool_result') continue
          const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
          const m = /ENV=(\S*?)(?:\\n|\s|"|$)/.exec(text)
          if (m) seen = m[1]
        }
      }
      if (msg.type === 'result') cost = msg.total_cost_usd ?? 0
    }
    const markers = [existsSync(marks.session) ? 'SessionStart' : null, existsSync(marks.pretool) ? 'PreToolUse' : null].filter(Boolean)
    console.log(`${name}: settingSources=${JSON.stringify(settingSources)} options.env=${optionsEnv ?? 'unset'} -> hooks ran: ${markers.length ? markers.join('+') : 'none'}; Bash saw ORGAI_SMOKE_ENV=${seen}; cost $${cost.toFixed(4)}`)
  } catch (e) {
    console.log(`${name}: FAILED ${String(e?.message ?? e).slice(0, 300)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

await runCase('(a)', [], 'from-options')
await runCase('(b)', ['project'], undefined)
await runCase('(c)', ['project'], 'from-options')
