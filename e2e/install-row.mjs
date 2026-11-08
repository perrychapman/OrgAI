// App settings > General > Advanced > Terminal: the "orgai command" install row (cli-standalone-default.md 5.3).
// Token-free and offline: a fake npm sits first on PATH (it records its argv, cwd and environment, then fakes the
// result by a mode file), a temporary HOME holds the old app shim, and no real npm or network is used.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { TMP, check, finish, launch, log, openAppSettings, sleep } from './lib.mjs'

const win = process.platform === 'win32'
// The tag follows the app version like installTag() in cliInstaller.ts: stable X.Y.Z is latest, anything else next.
const appVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const tag = /^\d+\.\d+\.\d+$/.test(String(appVersion).trim().replace(/^v/, '').replace(/\+.*$/, '')) ? 'latest' : 'next'
const root = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-install-row-'))
const home = path.join(root, 'home')
const localAppData = path.join(root, 'localappdata')
const otherBin = path.join(root, 'other-bin')
const prefix = path.join(root, 'prefix')
const prefixBin = win ? prefix : path.join(prefix, 'bin')
const npmBin = path.join(root, 'npm-bin')
const shimBin = win ? path.join(localAppData, 'OrgAI', 'bin') : path.join(home, '.local', 'bin')
const shimFile = path.join(shimBin, win ? 'orgai.cmd' : 'orgai')
const otherFile = path.join(otherBin, win ? 'orgai.cmd' : 'orgai')
const ctl = path.join(root, 'ctl.json')
const npmLog = path.join(root, 'npm-calls.jsonl')
const ranMark = path.join(root, 'foreign-ran')
const pidFile = path.join(root, 'npm.pid')
for (const d of [home, localAppData, otherBin, prefixBin, npmBin, shimBin]) fs.mkdirSync(d, { recursive: true })

// The fake npm: a node script behind an npm (POSIX) or npm.cmd (Windows) wrapper.
const fakeScript = path.join(npmBin, 'fake-npm.mjs')
fs.writeFileSync(
  fakeScript,
  `import * as fs from 'node:fs'
import * as path from 'node:path'
const ctl = JSON.parse(fs.readFileSync(${JSON.stringify(ctl)}, 'utf8'))
fs.appendFileSync(${JSON.stringify(npmLog)}, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  env: {
    ORGAI_DATA_DIR: process.env.ORGAI_DATA_DIR !== undefined,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY !== undefined,
    CODEX_HOME: process.env.CODEX_HOME !== undefined,
    npm_config_registry: process.env.npm_config_registry ?? null
  }
}) + '\\n')
if (ctl.mode === 'hang') {
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
  console.log('npm http fetch GET orgai-cli')
  setInterval(() => {}, 1000)
} else if (ctl.mode === 'eacces') {
  console.error('npm error code EACCES')
  console.error('npm error syscall mkdir')
  console.error('npm error path /usr/local/lib/node_modules/orgai-cli')
  process.exit(243)
} else if (ctl.mode === 'ok') {
  const prefix = ${JSON.stringify(prefix)}
  const pkg = path.join(prefix, win32() ? 'node_modules' : path.join('lib', 'node_modules'), 'orgai-cli')
  fs.mkdirSync(path.join(pkg, 'out', 'cli'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'orgai-cli', version: '9.9.9' }))
  const entry = path.join(pkg, 'out', 'cli', 'orgai.mjs')
  fs.writeFileSync(entry, '#!/usr/bin/env node\\n', { mode: 0o755 })
  if (win32()) fs.writeFileSync(path.join(prefix, 'orgai.cmd'), '@ECHO off\\r\\n"%~dp0\\\\node_modules\\\\orgai-cli\\\\out\\\\cli\\\\orgai.mjs" %*\\r\\n')
  else {
    fs.rmSync(path.join(prefix, 'bin', 'orgai'), { force: true })
    fs.symlinkSync(entry, path.join(prefix, 'bin', 'orgai'))
  }
  console.log('added 1 package in 1s')
}
function win32() { return process.platform === 'win32' }
`
)
const setMode = (mode) => fs.writeFileSync(ctl, JSON.stringify({ mode }))
setMode('ok')
if (win) fs.writeFileSync(path.join(npmBin, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`)
else {
  fs.writeFileSync(path.join(npmBin, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, { mode: 0o755 })
}

const foreignText = win ? `@echo off\r\necho ran > "${ranMark}"\r\n` : `#!/bin/sh\ntouch "${ranMark}"\n`
const oldShimText = win
  ? '@echo off\r\nrem orgai-shim v1: written by an older OrgAI app\r\n"C:\\Gone\\OrgAI\\resources\\bin\\orgai.cmd" %*\r\n'
  : '#!/bin/sh\n# orgai-shim v1: written by an older OrgAI app\nexec "/Applications/Gone.app/Contents/Resources/bin/orgai" "$@"\n'
const readLog = () => (fs.existsSync(npmLog) ? fs.readFileSync(npmLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

// The app's PATH: other program first, then the old shim's folder, then npm's prefix, then the fake npm, then only
// the system folders (the real PATH may hold a real orgai that would change the first status).
const delim = path.delimiter
const systemDirs = win ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), process.env.SystemRoot ?? 'C:\\Windows'] : ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
process.env.PATH = [otherBin, shimBin, prefixBin, npmBin, ...systemDirs].join(delim)
process.env.HOME = home
process.env.USERPROFILE = home
process.env.LOCALAPPDATA = localAppData
// A stub login shell (named like a POSIX shell so the app accepts it) that prints exactly this PATH: a real
// /etc/zprofile (path_helper on macOS) would put /usr/local/bin ahead of the folders above.
if (!win) {
  const shellDir = path.join(root, 'shell')
  fs.mkdirSync(shellDir, { recursive: true })
  const stub = path.join(shellDir, 'bash')
  fs.writeFileSync(stub, '#!/bin/sh\nexec /bin/sh -c "$2"\n', { mode: 0o755 })
  process.env.SHELL = stub
} else delete process.env.SHELL
process.env.ANTHROPIC_API_KEY = 'e2e-not-a-key'
process.env.CODEX_HOME = path.join(root, 'codex')
process.env.npm_config_registry = 'https://registry.invalid.example/'
process.env.ORGAI_MOCK = '1'

const { app, page } = await launch({ shotPrefix: 'install-row' })
try {
  await openAppSettings(page)
  await page.getByRole('tab', { name: 'General', exact: true }).click().catch(() => {})
  await sleep(400)
  const adv = page.locator('[data-testid=settings-advanced][data-pane=app-general]')
  if ((await adv.count()) && !(await adv.evaluate((d) => d.open).catch(() => false))) await adv.locator('summary').click().catch(() => {})
  const row = page.locator('[data-testid=cli-command-row]')
  await row.waitFor({ state: 'attached', timeout: 15_000 })
  await row.scrollIntoViewIfNeeded()
  const status = page.locator('[data-testid=cli-command-status]')
  const text = async () => (await status.innerText()).trim()
  const refresh = async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await sleep(500)
  }
  const waitText = async (re, what) => {
    const t0 = Date.now()
    while (Date.now() - t0 < 15_000) {
      if (re.test(await text())) return true
      await sleep(200)
    }
    return check(false, what, `status is "${await text()}"`)
  }

  // 1. Nothing installed.
  await waitText(/Not installed/, 'status starts at Not installed')
  check((await text()) === 'Not installed', 'Not installed is the whole status line', await text())
  const cmdText = (await page.locator('[data-testid=cli-command-text]').innerText()).trim()
  check(cmdText === `npm install -g orgai-cli@${tag}`, `the command shown uses the tag for this app version (${tag})`, cmdText)
  check(await page.locator('[data-testid=cli-command-install]').isVisible(), 'Install is offered')
  check((await page.locator('[data-testid=cli-command-remove-old]').count()) === 0, 'no old-shim removal when there is no old shim')
  check((await page.getByRole('button', { name: 'Copy command' }).count()) === 1, 'Copy command is offered')

  // 2. Another program named orgai is classified by metadata and never run.
  fs.writeFileSync(otherFile, foreignText, { mode: 0o755 })
  await refresh()
  await waitText(/Another program named orgai/, 'a foreign orgai reads as Another program')
  check(!fs.existsSync(ranMark), 'the foreign orgai on PATH was not executed')
  fs.rmSync(otherFile)

  // 3. The old app shim.
  fs.writeFileSync(shimFile, oldShimText, { mode: 0o755 })
  await refresh()
  await waitText(/Old OrgAI app command \(no longer works\)/, 'the old shim reads as the old OrgAI app command')
  check(await page.locator('[data-testid=cli-command-remove-old]').isVisible(), 'Remove the old orgai command is offered')

  // 4. EACCES: npm output, the --prefix hint, and the fixed command, cwd and scrubbed environment.
  setMode('eacces')
  await page.locator('[data-testid=cli-command-install]').click()
  await page.locator('[data-testid=cli-command-hint]').waitFor({ timeout: 20_000 })
  const hint = await page.locator('[data-testid=cli-command-hint]').innerText()
  check(/--prefix/.test(hint), 'EACCES shows the --prefix hint', hint)
  const out1 = await page.locator('[data-testid=cli-command-output]').innerText()
  check(/code EACCES/.test(out1), "EACCES shows npm's own output", out1)
  const calls1 = readLog()
  check(calls1.length === 1, 'npm ran once', String(calls1.length))
  const c = calls1[0]
  check(JSON.stringify(c?.args) === JSON.stringify(['install', '-g', `orgai-cli@${tag}`, '--ignore-scripts']), 'npm got the fixed arguments', JSON.stringify(c?.args))
  check(c && fs.realpathSync(c.cwd) === fs.realpathSync(home), 'npm ran with the home folder as cwd', c?.cwd)
  check(c && c.env.ORGAI_DATA_DIR === false && c.env.ANTHROPIC_API_KEY === false && c.env.CODEX_HOME === false, 'ORGAI_*, ANTHROPIC_* and CODEX_* were scrubbed from npm env', JSON.stringify(c?.env))
  check(c?.env.npm_config_registry === 'https://registry.invalid.example/', "the user's npm registry setting stays", String(c?.env.npm_config_registry))
  check(fs.existsSync(shimFile), 'a failed install leaves the old shim alone')

  // 5. A successful install while the old shim still wins on PATH, then the cleanup re-classifies.
  setMode('ok')
  await page.locator('[data-testid=cli-command-install]').click()
  await page.locator('[data-testid=cli-command-notice]:has-text("Installed orgai-cli")').waitFor({ timeout: 20_000 })
  check(readLog().length === 2, 'second install ran npm once more')
  check(/Old OrgAI app command/.test(await text()), 'the old shim still wins on PATH right after the install', await text())
  const removeOld = page.locator('[data-testid=cli-command-remove-old]')
  check(await removeOld.isVisible(), 'the old-shim removal is offered after a successful install')
  await removeOld.click()
  await waitText(/Installed \(npm, 9\.9\.9\)/, 'after removal the npm install wins and shows its version')
  check(!fs.existsSync(shimFile), 'the old shim file is gone')
  check((await page.locator('[data-testid=cli-command-remove-old]').count()) === 0, 'no removal button once the old shim is gone')
  check((await page.locator('[data-testid=cli-command-install]').innerText()).trim() === 'Update', 'Install turns into Update when installed')

  // 6. A foreign file at the shim path is never removed.
  fs.writeFileSync(shimFile, foreignText, { mode: 0o755 })
  await refresh()
  check((await page.locator('[data-testid=cli-command-remove-old]').count()) === 0, 'a foreign file at the shim path gets no removal button')
  check(fs.readFileSync(shimFile, 'utf8') === foreignText, 'the foreign file is untouched')
  fs.rmSync(shimFile)

  // 7. Cancel a running install.
  setMode('hang')
  await refresh()
  await page.locator('[data-testid=cli-command-install]').click()
  const cancel = page.locator('[data-testid=cli-command-cancel]')
  await cancel.waitFor({ timeout: 15_000 })
  const t0 = Date.now()
  while (!fs.existsSync(pidFile) && Date.now() - t0 < 10_000) await sleep(100)
  let pid = Number(fs.readFileSync(pidFile, 'utf8'))
  check((await page.locator('[data-testid=cli-command-install]').count()) === 0, 'while installing, Install is replaced by Cancel (one at a time)')
  await cancel.click()
  await page.locator('[data-testid=cli-command-notice]:has-text("cancelled")').waitFor({ timeout: 15_000 })
  await sleep(500)
  let alive = true
  try {
    process.kill(pid, 0)
  } catch {
    alive = false
  }
  check(!alive, 'cancel stopped the npm process', `pid ${pid}`)
  check(await page.locator('[data-testid=cli-command-install]').isVisible(), 'Install is back after cancel')

  // 8. A reload remounts the row while npm runs: main still reports the install, so Cancel stays, Install is not offered.
  await page.locator('[data-testid=cli-command-install]').click()
  await cancel.waitFor({ timeout: 15_000 })
  await sleep(500)
  pid = Number(fs.readFileSync(pidFile, 'utf8'))
  await page.reload()
  await openAppSettings(page)
  await page.getByRole('tab', { name: 'General', exact: true }).click().catch(() => {})
  const adv2 = page.locator('[data-testid=settings-advanced][data-pane=app-general]')
  if ((await adv2.count()) && !(await adv2.evaluate((d) => d.open).catch(() => false))) await adv2.locator('summary').click().catch(() => {})
  await cancel.waitFor({ timeout: 15_000 })
  check((await page.locator('[data-testid=cli-command-install]').count()) === 0, 'after a remount a running install still shows Cancel, not Install')
  await cancel.click()
  await page.locator('[data-testid=cli-command-install]').waitFor({ timeout: 15_000 })
  await sleep(500)
  alive = true
  try {
    process.kill(pid, 0)
  } catch {
    alive = false
  }
  check(!alive, 'cancel after a remount stopped the npm process', `pid ${pid}`)
} catch (e) {
  check(false, 'install-row script ran to the end', e.stack ?? String(e))
} finally {
  await app.close().catch(() => {})
  fs.rmSync(root, { recursive: true, force: true })
  finish('install-row')
}
void os
void log
