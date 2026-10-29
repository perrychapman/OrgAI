// Smoke test for the Codex adapter's assumptions about `codex app-server`. SPENDS A FEW TOKENS (two short turns
// on the cheapest listed model). Never run it in a loop, and only with the account owner's consent.
//
//   node scripts/smoke-codex.mjs --yes [--model <id>] [--home <CODEX_HOME>] [--no-resume]
//
// CODEX_HOME defaults to $CODEX_HOME, else ~/.codex (the login the Codex CLI already has on this machine).
// OrgAI's own login lives in <data dir>/codex; pass --home to use that one.
//
// What it verifies (prints a compact report):
//   1. initialize (experimentalApi) and account/read, model/list
//   2. thread/start with developerInstructions and two dynamicTools (orgai_echo, and update_plan, which collides
//      with a built-in Codex tool) accepted, and the thread/start response fields
//   3. a turn that calls the dynamic tool: shape of item/tool/call (tool name, namespace, arguments, callId),
//      item/started + item/completed notifications (dynamicToolCall, commandExecution, agentMessage, reasoning)
//   4. an approval request for a harmless command: method and param keys, accepted with { decision: 'accept' }
//   5. thread/tokenUsage/updated and turn/completed
//   6. the model's own list of callable tools (does update_plan reach the harness? are Codex's multi-agent tools on?)
//   7. thread/resume after a restart, then a turn: are the dynamic tools still there? (the adapter's MCP restart
//      and run continuation assume yes)
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined)

if (!flag('--yes')) {
  console.error('This script spends a few tokens on a real model (two short turns). Re-run with --yes to continue.')
  process.exit(2)
}

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

const home = opt('--home') ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
const work = mkdtempSync(join(tmpdir(), 'orgai-smoke-codex-'))
const report = { verified: [], unexpected: [], notes: [] }
const ok = (m) => report.verified.push(m)
const bad = (m) => report.unexpected.push(m)
const note = (m) => report.notes.push(m)
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).sort().join(',') : typeof o)

class Client {
  constructor() {
    const bin = findBinary()
    const env = { ...process.env, CODEX_HOME: home }
    if (bin.pathDir) env.PATH = `${bin.pathDir}${delimiter}${env.PATH ?? ''}`
    this.child = spawn(bin.path, ['app-server'], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.next = 1
    this.pending = new Map()
    this.notifications = []
    this.serverRequests = []
    this.handler = async () => ({})
    this.buf = ''
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (c) => this.onData(c))
    this.child.stderr.on('data', () => {})
    this.exited = new Promise((r) => this.child.on('exit', r))
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
      this.serverRequests.push({ method: msg.method, params: msg.params })
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
    const r = await this.request('initialize', { clientInfo: { name: 'orgai-smoke', title: 'OrgAI smoke', version: '0.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false } })
    this.write({ method: 'initialized' })
    return r
  }
  close() {
    try {
      this.child.stdin.end()
      this.child.kill()
    } catch {}
  }
}

const echoTool = {
  type: 'function',
  name: 'orgai_echo',
  description: 'Echo a short text back. Call it with the text you were given.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }
}
const planTool = {
  type: 'function',
  name: 'update_plan',
  description: 'OrgAI harness plan update (collides with a built-in Codex tool). Call it with a note.',
  inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false }
}

const threadParams = (model) => ({
  cwd: work,
  ...(model ? { model } : {}),
  approvalPolicy: 'untrusted',
  sandbox: 'workspace-write',
  developerInstructions: 'You are a test agent. Follow the user instructions exactly and keep every answer under 40 words.',
  dynamicTools: [echoTool, planTool],
  serviceName: 'orgai'
})

async function runTurn(c, threadId, text, label) {
  const calls = []
  const approvals = []
  c.handler = async (method, params) => {
    if (method === 'item/tool/call') {
      calls.push(params)
      return { contentItems: [{ type: 'inputText', text: params.tool === 'orgai_echo' ? `echoed: ${params.arguments?.text ?? ''}` : 'noted' }], success: true }
    }
    if (method.endsWith('/requestApproval')) {
      approvals.push({ method, keys: keys(params), command: params.command, kind: params.kind })
      return { decision: 'accept' }
    }
    return {}
  }
  const start = c.notifications.length
  const done = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}: turn timed out`)), 180_000)
    c.onNotification = (n) => {
      if (n.method === 'turn/completed' && n.params.threadId === threadId) {
        clearTimeout(t)
        resolve(n.params.turn)
      }
    }
  })
  const res = await c.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] })
  ok(`${label}: turn/start response has turn.id (${res?.turn?.id ? 'yes' : 'NO'})`)
  const turn = await done
  const notes = c.notifications.slice(start)
  return { turn, calls, approvals, notes }
}

function summarize(label, r) {
  const methods = {}
  for (const n of r.notes) methods[n.method] = (methods[n.method] ?? 0) + 1
  note(`${label} notifications: ${JSON.stringify(methods)}`)
  const itemTypes = new Map()
  for (const n of r.notes) if (n.method === 'item/completed') itemTypes.set(n.params.item.type, keys(n.params.item))
  for (const [t, k] of itemTypes) note(`${label} item/completed ${t} fields: ${k}`)
  const usage = r.notes.find((n) => n.method === 'thread/tokenUsage/updated')
  if (usage) ok(`${label}: thread/tokenUsage/updated total keys: ${keys(usage.params.tokenUsage?.total)}`)
  else bad(`${label}: no thread/tokenUsage/updated`)
  const msg = [...r.notes].reverse().find((n) => n.method === 'item/completed' && n.params.item.type === 'agentMessage')
  if (msg) note(`${label} final agentMessage phase=${msg.params.item.phase} text=${JSON.stringify(msg.params.item.text).slice(0, 400)}`)
  ok(`${label}: turn/completed status=${r.turn.status}`)
}

let c = new Client()
try {
  // 1. handshake, account, models
  const init = await c.init()
  ok(`initialize ok (${keys(init)})`)
  const account = await c.request('account/read', { refreshToken: false })
  ok(`account/read: ${JSON.stringify(account).slice(0, 200)}`)
  if (!account?.account) throw new Error(`No Codex login in CODEX_HOME=${home}. Log in first (codex login) or pass --home.`)
  const models = await c.request('model/list', {})
  const list = (models.data ?? []).filter((m) => !m.hidden)
  ok(`model/list: ${list.map((m) => m.model).join(', ')}`)
  const cheap = opt('--model') ?? (list.find((m) => /mini|nano|spark/i.test(m.model)) ?? list[0])?.model
  note(`using model ${cheap ?? '(default)'}`)

  // 2. thread/start
  const started = await c.request('thread/start', threadParams(cheap))
  ok(`thread/start accepted developerInstructions + 2 dynamicTools; response keys: ${keys(started)}; approvalPolicy=${JSON.stringify(started.approvalPolicy)} sandbox=${JSON.stringify(started.sandbox)}`)
  const threadId = started.thread.id

  // 3-6. the first turn
  const r1 = await runTurn(
    c,
    threadId,
    'Do these in order: (1) call orgai_echo with text "ping"; (2) call update_plan with note "x"; (3) run the shell command: echo hello ; (4) answer with the names of all the tools you can call, comma separated, then the word DONE.',
    'turn 1'
  )
  summarize('turn 1', r1)
  if (r1.calls.length) {
    const echo = r1.calls.find((x) => x.tool === 'orgai_echo')
    if (echo) ok(`item/tool/call shape: keys=${keys(echo)} namespace=${JSON.stringify(echo.namespace)} tool=${echo.tool} arguments=${JSON.stringify(echo.arguments)}`)
    else bad(`dynamic tool orgai_echo was never called; calls: ${r1.calls.map((x) => x.tool)}`)
    const plan = r1.calls.find((x) => x.tool === 'update_plan')
    if (plan) ok('our update_plan reached the harness (no collision problem)')
    else bad('update_plan did not reach the harness (built-in shadowed it?) - the adapter renames it to orgai_update_plan')
  } else bad('no item/tool/call server request at all')
  const dyn = r1.notes.filter((n) => n.params?.item?.type === 'dynamicToolCall')
  if (dyn.length) ok(`item/* dynamicToolCall present: fields ${keys(dyn[0].params.item)}`)
  else bad('no dynamicToolCall item notifications')
  if (r1.approvals.length) ok(`approval requests: ${JSON.stringify(r1.approvals)}`)
  else bad('no approval request for `echo hello` under untrusted (the command may count as known-safe)')
  if (r1.notes.some((n) => n.params?.item?.type === 'collabAgentToolCall')) bad('Codex used its built-in multi-agent tools')

  // 7. resume after restart
  if (!flag('--no-resume')) {
    c.close()
    await c.exited
    c = new Client()
    await c.init()
    const { dynamicTools, serviceName, ...resumeParams } = threadParams(cheap)
    void dynamicTools
    void serviceName
    const resumed = await c.request('thread/resume', { threadId, ...resumeParams })
    ok(`thread/resume ok (${keys(resumed)})`)
    const r2 = await runTurn(c, threadId, 'Call orgai_echo with text "again", then answer DONE.', 'turn 2 (after resume)')
    summarize('turn 2', r2)
    if (r2.calls.some((x) => x.tool === 'orgai_echo')) ok('dynamic tools survive thread/resume')
    else bad('dynamic tools did NOT survive thread/resume - the adapter would need to re-register them (not possible in 0.166.0 ThreadResumeParams)')
  }
} catch (e) {
  bad(`FAILED: ${e.message}`)
} finally {
  c.close()
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {}
}

console.log('\n=== Codex smoke report ===')
for (const m of report.verified) console.log('VERIFIED  ', m)
for (const m of report.unexpected) console.log('UNEXPECTED', m)
for (const m of report.notes) console.log('note      ', m)
process.exit(report.unexpected.some((m) => m.startsWith('FAILED')) ? 1 : 0)
