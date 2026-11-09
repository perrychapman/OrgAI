#!/usr/bin/env node
/**
 * Probe: does a Codex manager use Codex's BUILT-IN multi-agent tools instead of OrgAI's harness tools, and does the
 * rename (spawn_agent/send_message/list_agents -> spawn_report/message_agent/list_team) change that?
 * (docs/design/delegation-enforcement.md 5.1 step 6.) SPENDS TOKENS on a real model: N runs per variant, each one
 * manager turn plus the tool round trips. NOT run by CI or by its author; the orchestrator runs it by hand.
 *
 *   node scripts/probe-codex-native-agents.mjs --yes [--runs 10] [--model gpt-6-luna] [--home <CODEX_HOME>]
 *                                              [--variant old|new|both] [--features-on]
 *
 * What it does. For each variant ("old" names, "new" names) and each run it starts `codex app-server` (same driver
 * as scripts/smoke-codex.mjs) and starts ONE thread for the lab's middle layer: the manager of the chart
 * lead -> manager -> (policy, evidence). The manager gets the harness tools under the variant's names as dynamic tools,
 * a developer prompt naming its two reports (roles "policy" and "evidence") and a brief from the lead asking for both
 * a policy review and an evidence digest. The harness side answers spawn calls with a canned handle and never starts the
 * reports (the probe only measures what the manager reaches for). The lead layer is not simulated: its brief is the
 * manager's first message.
 * By default the app-server runs with features.multi_agent=false and features.multi_agent_v2=false, like OrgAI now does;
 * --features-on leaves Codex's defaults to see the raw behaviour.
 *
 * Per run it records: native items (collabAgentToolCall / subAgentActivity), their raw tool names, calls to the harness
 * spawn tool and whether both roles were spawned. Prints one JSON line per run and a summary per variant.
 * The results go in docs/agent-notes/connections-mcp.md.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d)

if (!flag('--yes')) {
  console.error('This script spends tokens on a real model (N runs per variant). Re-run with --yes to continue.')
  process.exit(2)
}

const RUNS = Number(opt('--runs', '10'))
const MODEL = opt('--model', 'gpt-6-luna')
const VARIANT = opt('--variant', 'both')
const HOME = opt('--home', process.env.CODEX_HOME ?? join(homedir(), '.codex'))
const TURN_TIMEOUT_MS = 240_000

const PLATFORMS = {
  'linux-x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl'],
  'linux-arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl'],
  'darwin-x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin'],
  'darwin-arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin'],
  'win32-x64': ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc'],
  'win32-arm64': ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc']
}

function findBinary() {
  if (process.env.ORGAI_CODEX_PATH) return { path: process.env.ORGAI_CODEX_PATH }
  const [pkg, triple] = PLATFORMS[`${process.platform}-${process.arch}`] ?? []
  if (!pkg) throw new Error(`No Codex binary for ${process.platform}-${process.arch}`)
  const root = dirname(createRequire(import.meta.url).resolve(`${pkg}/package.json`))
  const vendor = join(root, 'vendor', triple)
  const bin = join(vendor, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
  if (!existsSync(bin)) throw new Error(`Missing ${bin}`)
  const pathDir = join(vendor, 'codex-path')
  return { path: bin, pathDir: existsSync(pathDir) ? pathDir : undefined }
}

const NAMES = {
  old: { spawn: 'spawn_agent', message: 'send_message', list: 'list_agents' },
  new: { spawn: 'spawn_report', message: 'message_agent', list: 'list_team' }
}

const tool = (name, description, properties, required) => ({ type: 'function', name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } })
const toolsFor = (n) => [
  tool(n.spawn, "Delegate work to a report in your org chart. Returns at once with the report's handle; its final report arrives later as a message from the harness.", { role: { type: 'string', description: 'Role slug, exactly as listed in your instructions' }, brief: { type: 'string' }, name: { type: 'string' } }, ['role', 'brief']),
  tool(n.message, 'Send a message to another running agent by handle.', { to: { type: 'string' }, message: { type: 'string' } }, ['to', 'message']),
  tool(n.list, 'List the agents in this run with their handles, roles and states.', {}, [])
]

const instructions = (n) =>
  `You are the manager in an org chart: lead -> manager -> policy, evidence.\n` +
  `You do not do the analysis yourself. You delegate to your reports by calling ${n.spawn} with role set to exactly "policy" or "evidence" and a complete brief; ` +
  `their reports arrive later as harness messages. Use ${n.message} to follow up and ${n.list} to see who is running. Spawn both reports before you finish.`
const FIRST_MESSAGE = 'Lead here. We need (1) a policy review of the refund rules in docs/refunds.md and (2) an evidence digest of the last three incident reports. Get both done through your reports and answer once they are spawned.'

class Client {
  constructor(cwd) {
    const bin = findBinary()
    const env = { ...process.env, CODEX_HOME: HOME }
    if (bin.pathDir) env.PATH = `${bin.pathDir}${delimiter}${env.PATH ?? ''}`
    const config = flag('--features-on') ? [] : ['features.multi_agent=false', 'features.multi_agent_v2=false']
    this.child = spawn(bin.path, ['app-server', ...config.flatMap((c) => ['-c', c])], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.next = 1
    this.pending = new Map()
    this.notifications = []
    this.handler = async () => ({})
    this.buf = ''
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (c) => this.onData(c))
    this.child.stderr.on('data', () => {})
  }
  onData(chunk) {
    this.buf += chunk
    let i
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (line) this.onLine(JSON.parse(line))
    }
  }
  onLine(msg) {
    if (msg.id !== undefined && msg.method) {
      Promise.resolve(this.handler(msg.method, msg.params)).then(
        (result) => this.write({ id: msg.id, result }),
        (e) => this.write({ id: msg.id, error: { code: -32000, message: String(e) } })
      )
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) p?.reject(new Error(`${p.method}: ${msg.error.message}`))
      else p?.resolve(msg.result)
    } else if (msg.method) {
      this.notifications.push(msg)
      this.onNotification?.(msg)
    }
  }
  write(m) {
    this.child.stdin.write(`${JSON.stringify(m)}\n`)
  }
  request(method, params) {
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject })
      this.write(params === undefined ? { id, method } : { id, method, params })
      setTimeout(() => reject(new Error(`${method} timed out`)), 60_000).unref()
    })
  }
  async init() {
    await this.request('initialize', { clientInfo: { name: 'orgai-probe', title: 'OrgAI probe', version: '0.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false } })
    this.write({ method: 'initialized' })
  }
  close() {
    try {
      this.child.stdin.end()
      this.child.kill()
    } catch {}
  }
}

async function runOnce(variant) {
  const names = NAMES[variant]
  const cwd = mkdtempSync(join(tmpdir(), 'orgai-probe-native-'))
  const c = new Client(cwd)
  const result = { variant, nativeItems: 0, nativeToolNames: [], harnessSpawns: 0, rolesSpawned: [], spawnedBoth: false, status: 'unknown' }
  try {
    await c.init()
    const started = await c.request('thread/start', {
      cwd,
      model: MODEL,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions: instructions(names),
      dynamicTools: toolsFor(names),
      serviceName: 'orgai'
    })
    const threadId = started.thread.id
    let n = 0
    c.handler = async (method, params) => {
      if (method === 'item/tool/call') {
        if (params.tool === names.spawn) {
          result.harnessSpawns += 1
          const role = String(params.arguments?.role ?? '')
          result.rolesSpawned.push(role)
          return { contentItems: [{ type: 'inputText', text: `Spawned ${role}-${++n}. It works in the background; its final report arrives as a message from the harness.` }], success: true }
        }
        return { contentItems: [{ type: 'inputText', text: params.tool === names.list ? 'No other agents are running.' : 'Delivered.' }], success: true }
      }
      if (method.endsWith('/requestApproval')) return { decision: 'decline' }
      return {}
    }
    const done = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('turn timed out')), TURN_TIMEOUT_MS)
      c.onNotification = (m) => {
        const item = m.params?.item
        if (m.method === 'item/started' && item && (item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity')) {
          result.nativeItems += 1
          result.nativeToolNames.push(String(item.tool ?? item.type))
        }
        if (m.method === 'turn/completed' && m.params.threadId === threadId) {
          clearTimeout(t)
          resolve(m.params.turn)
        }
      }
    })
    await c.request('turn/start', { threadId, input: [{ type: 'text', text: FIRST_MESSAGE, text_elements: [] }] })
    const turn = await done
    result.status = turn.status
  } catch (e) {
    result.status = `error: ${e.message}`
  } finally {
    c.close()
    rmSync(cwd, { recursive: true, force: true })
  }
  result.spawnedBoth = result.rolesSpawned.includes('policy') && result.rolesSpawned.includes('evidence')
  return result
}

const variants = VARIANT === 'both' ? ['old', 'new'] : [VARIANT]
const summary = {}
for (const v of variants) {
  const s = { runs: 0, runsWithNative: 0, nativeItems: 0, runsWithHarnessSpawn: 0, runsSpawnedBoth: 0, nativeToolNames: {} }
  for (let i = 0; i < RUNS; i++) {
    const r = await runOnce(v)
    console.log(JSON.stringify(r))
    s.runs += 1
    if (r.nativeItems) s.runsWithNative += 1
    s.nativeItems += r.nativeItems
    if (r.harnessSpawns) s.runsWithHarnessSpawn += 1
    if (r.spawnedBoth) s.runsSpawnedBoth += 1
    for (const t of r.nativeToolNames) s.nativeToolNames[t] = (s.nativeToolNames[t] ?? 0) + 1
  }
  summary[v] = s
}
console.log(JSON.stringify({ model: MODEL, featuresOff: !flag('--features-on'), summary }, null, 2))
