import { _electron as electron } from 'playwright-core'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const APP = path.resolve(HERE, '../../../..')
export const OUT = path.join(APP, 'e2e/shots/ux/placement2')
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const TMP = fs.realpathSync.native(os.tmpdir())
// Stable dirs so several driver stages can share one app session.
export const DATA = path.join(TMP, 'orgai-p2-data')
export const SCRIPT = path.join(TMP, 'orgai-p2-script.json')
export const plain = { delayMs: 300, work: [
  { type: 'thinking', text: 'Small request.' },
  { type: 'text', text: 'Planning the work.' },
  { type: 'spawn', id: 'r1', description: 'Implement the change' },
  { type: 'tool', agent: 'r1', name: 'Read', input: { file_path: 'src/example.ts' }, result: 'x\n' },
  { type: 'finish', id: 'r1', result: 'Changed src/example.ts' },
  { type: 'text', text: 'Done. Anything else?' } ] }
export const three = { delayMs: 300, work: [
  { type: 'plan', goal: 'Add rate limiting', steps: ['Read the server', 'Implement limiter', 'Review'] },
  { type: 'text', text: 'Delegating.' },
  { type: 'spawn', id: 'r1', description: 'Implement the limiter' },
  { type: 'tool', agent: 'r1', name: 'Bash', input: { command: 'npm test -- --run rate-limit' }, ask: true, background: true, result: 'ok' },
  { type: 'tool', agent: 'r1', name: 'Edit', input: { file_path: 'src/server.js', old_string: 'a', new_string: 'b' }, ask: true, background: true, result: 'ok' },
  { type: 'harness', name: 'ask_user', args: { question: 'Which limiter strategy should the Implementer use?', options: [{ label: 'Token bucket', description: 'Smooth bursts' }, { label: 'Fixed window', description: 'Simplest' }], allowFreeText: true } } ] }
export function setScript(s) { fs.writeFileSync(SCRIPT, JSON.stringify(s)) }
export function mkRepo(n) {
  const d = fs.mkdtempSync(path.join(TMP, `orgai-p2-${n}-`))
  fs.writeFileSync(path.join(d, 'README.md'), '# ' + n)
  execFileSync('git', ['init', '-q'], { cwd: d })
  return d
}
export async function launch() {
  fs.mkdirSync(DATA, { recursive: true })
  const bin = createRequire(path.join(APP, 'package.json'))('electron')
  const app = await electron.launch({ executablePath: bin, args: [APP], cwd: APP, timeout: 60000, env: { ...process.env, ORGAI_MOCK: '1', ORGAI_DATA_DIR: DATA, ORGAI_MOCK_SCRIPT: SCRIPT } })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
  page.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text().slice(0, 200)) })
  await page.waitForSelector('.sidebar', { timeout: 60000 })
  return { app, page }
}
export async function size(app, page, w, h) {
  await app.evaluate(({ BrowserWindow }, [w, h]) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(w, h); win.center() }, [w, h])
  await sleep(600)
}
export async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, name + '.png') })
  console.log('shot', name)
}
export async function theme(page, t) {
  await page.evaluate(async (t) => { const s = await window.orgai.settings.get(); const cur = s.settings ?? s; await window.orgai.settings.set({ ...cur, appearance: { ...cur.appearance, theme: t } }) }, t)
  await sleep(500)
}
export const rect = (page, sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }, sel)
