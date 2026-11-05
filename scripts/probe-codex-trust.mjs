#!/usr/bin/env node
/**
 * Token-free check of how the bundled Codex treats a folder's own .codex/ config (folder config trust, ARCHITECTURE.md).
 * Starts `codex app-server` on a throwaway CODEX_HOME with no login, asks config/read, hooks/list and mcpServerStatus/list,
 * and calls thread/start. It never starts a turn, so no model is called and nothing is billed. The fixture repo's MCP
 * server is a command that does nothing. Prints one JSON report per scenario.
 *
 * Usage: node scripts/probe-codex-trust.mjs
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

function codexBinary() {
  const triple = process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  const pkg = process.platform === 'win32' ? '@openai/codex-win32-x64' : process.arch === 'arm64' ? '@openai/codex-darwin-arm64' : '@openai/codex-darwin-x64'
  const root = dirname(require.resolve(`${pkg}/package.json`))
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex'
  return join(root, 'vendor', triple, 'bin', name)
}

function fixture(root) {
  mkdirSync(join(root, '.codex'), { recursive: true })
  writeFileSync(
    join(root, '.codex', 'config.toml'),
    'model = "repo-model-marker"\n\n[mcp_servers.repo_marker]\ncommand = "node"\nargs = ["-e", "0"]\n'
  )
  writeFileSync(
    join(root, '.codex', 'hooks.json'),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo repo-hook-marker' }] }] } })
  )
  writeFileSync(join(root, 'AGENTS.md'), 'repo-doc-marker\n')
}

class Client {
  constructor(bin, args, env, cwd) {
    this.id = 0
    this.pending = new Map()
    this.stderr = ''
    this.child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let buf = ''
    this.child.stdout.on('data', (d) => {
      buf += d
      for (;;) {
        const i = buf.indexOf('\n')
        if (i < 0) break
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          resolve(msg)
        }
      }
    })
    this.child.stderr.on('data', (d) => (this.stderr += d))
  }
  request(method, params, ms = 20000) {
    const id = ++this.id
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ timeout: method })
      }, ms)
      this.pending.set(id, { resolve: (m) => (clearTimeout(timer), resolve(m)) })
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ method, params }) + '\n')
  }
  stop() {
    this.child.kill()
  }
}

function layerSummary(res) {
  const layers = res?.result?.layers ?? []
  return layers
    .filter((l) => l.name?.type === 'project')
    .map((l) => ({ dotCodexFolder: l.name.dotCodexFolder, disabledReason: l.disabledReason, hasMcp: !!l.config?.mcp_servers, model: l.config?.model ?? null }))
}

async function scenario(label, { projectCwd, threadCwd, config, sandbox = 'workspace-write', approvalPolicy = 'untrusted', userToml }) {
  const home = mkdtempSync(join(tmpdir(), 'codex-trust-home-'))
  if (userToml) writeFileSync(join(home, 'config.toml'), userToml)
  const env = { ...process.env, CODEX_HOME: home }
  delete env.OPENAI_API_KEY
  const args = ['app-server', ...config.flatMap((c) => ['-c', c])]
  const c = new Client(codexBinary(), args, env, projectCwd)
  const out = { label, config, threadCwd }
  try {
    const init = await c.request('initialize', { clientInfo: { name: 'orgai-probe', title: null, version: '0' }, capabilities: { experimentalApi: true } })
    out.init = init.error ? init.error : 'ok'
    c.notify('initialized')
    const before = await c.request('config/read', { includeLayers: true, cwd: threadCwd })
    out.before = { layers: layerSummary(before), effectiveModel: before.result?.config?.model ?? null, error: before.error ?? null }
    const hooksBefore = await c.request('hooks/list', { cwds: [threadCwd] })
    out.hooksBefore = (hooksBefore.result?.data ?? []).flatMap((e) => e.hooks.map((h) => ({ command: h.command, trustStatus: h.trustStatus, enabled: h.enabled, source: h.source })))
    const start = await c.request('thread/start', { cwd: threadCwd, sandbox, approvalPolicy }, 30000)
    out.threadStart = start.error ? start.error : start.result ? { model: start.result.model ?? null, threadId: !!start.result.thread?.id } : start
    const after = await c.request('config/read', { includeLayers: true, cwd: threadCwd })
    out.after = { layers: layerSummary(after), effectiveModel: after.result?.config?.model ?? null }
    const hooksAfter = await c.request('hooks/list', { cwds: [threadCwd] })
    out.hooksAfter = (hooksAfter.result?.data ?? []).flatMap((e) => e.hooks.map((h) => ({ command: h.command, trustStatus: h.trustStatus, enabled: h.enabled, source: h.source })))
    const threadId = start.result?.thread?.id
    const mcp = await c.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', ...(threadId ? { threadId } : {}) })
    out.mcp = mcp.error ? mcp.error : (mcp.result?.data ?? []).map((s) => s.name)
    const userToml = join(home, 'config.toml')
    out.userConfigAfter = existsSync(userToml) ? readFileSync(userToml, 'utf8') : null
  } finally {
    c.stop()
    if (out.init !== 'ok') out.stderr = c.stderr.slice(-1500)
    await new Promise((r) => setTimeout(r, 300))
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      /* a locked temp file stays behind */
    }
  }
  // One line per scenario: what a run in that state would load.
  const enabled = (s) => s?.layers?.map((l) => (l.disabledReason ? 'disabled' : 'loaded')).join(',') || 'no layer'
  console.log(
    JSON.stringify({
      label,
      init: out.init,
      before: enabled(out.before),
      after: enabled(out.after),
      threadModel: out.threadStart?.model ?? out.threadStart,
      hooksBefore: out.hooksBefore?.length,
      hooksAfter: out.hooksAfter?.length,
      hookTrust: out.hooksAfter?.map((h) => h.trustStatus),
      mcp: out.mcp,
      userConfigAfter: out.userConfigAfter
    })
  )
}

function toml(path) {
  return JSON.stringify(path)
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-trust-repo-')))
const repo = join(root, 'repo')
mkdirSync(repo)
fixture(repo)
execFileSync('git', ['init', '-q'], { cwd: repo })
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: repo })
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], { cwd: repo })
const wt = join(repo, '.claude', 'worktrees', 'agent-x')
execFileSync('git', ['worktree', 'add', '-q', '-b', 'wt', wt], { cwd: repo })
const plain = join(root, 'plain')
mkdirSync(plain)
fixture(plain)

// A dotted `-c projects."<path>".trust_level=...` is not seen by the trust lookup (first probe run: the positive control
// stayed disabled and danger-full-access still wrote trust). A whole inline table is one key and one TOML value.
const inline = (p, level) => `projects={ ${toml(p)} = { trust_level = "${level}" } }`
const untrusted = (p) => inline(p, 'untrusted')

const trusted = (p) => inline(p, 'trusted')
const dotted = join(root, 'my.repo.v2')
mkdirSync(dotted)
fixture(dotted)
await scenario('H dotted path, untrusted override, full access', { projectCwd: dotted, threadCwd: dotted, config: [untrusted(dotted)], sandbox: 'danger-full-access', approvalPolicy: 'never' })
await scenario('I repo, old trust on disk, untrusted override, full access', { projectCwd: repo, threadCwd: repo, config: [untrusted(repo)], sandbox: 'danger-full-access', approvalPolicy: 'never', userToml: `[projects.${toml(repo)}]\ntrust_level = "trusted"\n` })

// Positive control: proves the fixture loads when a folder is trusted.
await scenario('T git repo, trusted', { projectCwd: repo, threadCwd: repo, config: [trusted(repo)] })
for (const [sandbox, approvalPolicy] of [
  ['workspace-write', 'untrusted'],
  ['workspace-write', 'on-request'],
  ['workspace-write', 'never'],
  ['danger-full-access', 'never'],
  ['read-only', 'untrusted']
]) {
  await scenario(`A git repo, no override, ${sandbox} ${approvalPolicy}`, { projectCwd: repo, threadCwd: repo, config: [], sandbox, approvalPolicy })
  await scenario(`B git repo, untrusted override, ${sandbox} ${approvalPolicy}`, { projectCwd: repo, threadCwd: repo, config: [untrusted(repo)], sandbox, approvalPolicy })
}
await scenario('C worktree thread, override on the repo path', { projectCwd: repo, threadCwd: wt, config: [untrusted(repo)], approvalPolicy: 'on-request' })
await scenario('D no git, no override', { projectCwd: plain, threadCwd: plain, config: [], approvalPolicy: 'on-request' })
await scenario('E no git, override on the path', { projectCwd: plain, threadCwd: plain, config: [untrusted(plain)], approvalPolicy: 'on-request' })

try {
  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: repo })
} catch {
  /* left for the temp cleaner */
}
rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
