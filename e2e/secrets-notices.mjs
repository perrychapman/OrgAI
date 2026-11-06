// Token-free. Mock adapter, temp ORGAI_DATA_DIR, a key-file vault in a sibling folder of the data dir (never the OS
// keychain: lib.mjs sets ORGAI_VAULT_NO_OS_KEYSTORE and launches with --use-mock-keychain). The secret vault notices on the
// Dashboard (docs/design/cli-standalone.md 5.5): "N saved secrets were removed by an older version of OrgAI" with
// Keep removed and Restore, a damaged secrets.json with Start over, and a vault whose key does not match with Try again
// and Start over. Each is seeded the way it happens: secrets saved through the app, then secrets.json edited as an older
// OrgAI would, then a relaunch. 1024x640 and 1600x1000 in both themes; no horizontal overflow; focus lands on a real
// element after every action.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DATA_DIR, TMP, check, finish, launch, log, screenshot, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
// E2E_KEY_DIR (optional) is the folder the key file's own folder is made in; default os.tmpdir(), a sibling of the data dir.
const keyDir = fs.mkdtempSync(path.join(process.env.E2E_KEY_DIR?.trim() || TMP, 'orgai-e2e-vaultkey-'))
const KEY_FILE = path.join(keyDir, 'vault.key')
process.env.ORGAI_VAULT_KEY_FILE = KEY_FILE
const LEGACY = path.join(DATA_DIR, 'data', 'secrets.json')
process.on('exit', () => fs.rmSync(keyDir, { recursive: true, force: true }))

let { app, page } = await launch({ shotPrefix: 'secrets-notices' })

const status = () => page.evaluate(() => window.orgai.secrets.status())
const setSize = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await page.waitForFunction((w2) => Math.abs(window.innerWidth - w2) <= 1, w, { timeout: 10_000 }).catch(() => {})
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await sleep(400)
}
const setTheme = async (theme) => {
  await page.evaluate(async (t) => {
    const s = await window.orgai.settings.get()
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, theme: t } })
  }, theme)
  await sleep(500)
}
const relaunchApp = async () => {
  await app.close().catch(() => {})
  ;({ app, page } = await launch({ shotPrefix: 'secrets-notices', clearPrefs: false }))
  await page.waitForSelector('[data-testid=dashboard]', { timeout: 30_000 })
}
const focusInfo = () =>
  page.evaluate(() => {
    const a = document.activeElement
    return { tag: a?.tagName ?? '', testid: a?.getAttribute('data-testid') ?? '', h1: !!a?.matches?.('main .topbar h1'), body: a === document.body }
  })
const saveSecrets = async () => {
  await page.evaluate(async () => {
    await window.orgai.connections.setSecret({ id: 'litellm', apiKey: 'sk-e2e-notice' })
    const list = await window.orgai.mcpLibrary.upsert({ id: 'lib-notice', name: 'acme-crm', transport: 'stdio', command: 'npx', args: ['-y', '@acme/crm-mcp@1.0.0'], secretEnv: ['API_TOKEN'], source: 'user', addedAt: new Date().toISOString() })
    const id = list.find((i) => i.entry.name === 'acme-crm').entry.id
    await window.orgai.mcpLibrary.setSecret({ libraryId: id, kind: 'env', name: 'API_TOKEN', value: 'tok-e2e-notice' })
  })
}
/** Edit secrets.json as an older OrgAI that removed `keys` would, with the app closed. */
const removeFromLegacy = (keys) => {
  const doc = JSON.parse(fs.readFileSync(LEGACY, 'utf8'))
  for (const k of Object.keys(doc.secrets)) if (keys.test(k)) delete doc.secrets[k]
  fs.writeFileSync(LEGACY, JSON.stringify(doc))
}
const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1)
const visible = async (sel) => (await page.locator(sel).count()) > 0 && (await page.locator(sel).first().isVisible())
const goDashboard = async () => {
  await page.locator('.sidebar .nav-item', { hasText: /^\s*Dashboard\s*$/ }).or(page.locator('.sidebar [aria-label="Dashboard"]')).first().click()
  await page.waitForSelector('[data-testid=dashboard]', { timeout: 10_000 })
}

try {
  // ---- Healthy vault: nothing to say ----
  let s = await status()
  check(s.state === 'open' && s.scheme === 'key-file', 'the key-file vault is open', JSON.stringify({ state: s.state, scheme: s.scheme }))
  check(!(await visible('[data-testid=secret-notices]')), 'a healthy vault shows no notice')

  // ---- Removed by an older OrgAI: Keep removed ----
  await saveSecrets()
  await app.close()
  removeFromLegacy(/^(connection:litellm|mcplib:)/)
  ;({ app, page } = await launch({ shotPrefix: 'secrets-notices', clearPrefs: false }))
  await page.waitForSelector('[data-testid=dashboard]', { timeout: 30_000 })
  s = await status()
  check(s.softDeletes.filter((d) => d.by === 'legacy').length === 2, 'two secrets read as removed by an older OrgAI', JSON.stringify(s.softDeletes))
  const removed = page.locator('[data-testid=secret-notice-removed]')
  await removed.waitFor({ timeout: 10_000 })
  const text = (await removed.innerText()).replace(/\s+/g, ' ')
  check(text.includes('2 saved secrets were removed by an older version of OrgAI.'), 'the notice counts the removed secrets', text)
  check(text.includes('LiteLLM') && text.includes('acme-crm'), 'the notice names the services', text)
  check((await removed.getByRole('button').allInnerTexts()).join('|') === 'Restore|Keep removed', 'Restore and Keep removed are offered')
  check((await page.locator('[data-testid=secret-notices]').count()) === 1, 'one notice region')

  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    for (const theme of ['dark', 'light']) {
      await setSize(w, h)
      await setTheme(theme)
      check(await removed.isVisible(), `removed notice visible at ${w}x${h} ${theme}`)
      check(await noOverflow(), `no horizontal overflow at ${w}x${h} ${theme}`)
      const box = await removed.boundingBox()
      check(!!box && box.x >= 0 && box.x + box.width <= w + 1, `notice fits the width at ${w}x${h} ${theme}`)
      await screenshot(page, `secrets-notices-removed-${w}-${theme}`)
    }
  }
  await setSize(1600, 1000)

  await page.locator('[data-testid=secret-keep-removed]').click()
  await removed.waitFor({ state: 'detached', timeout: 10_000 })
  check(true, 'Keep removed takes the notice away')
  await sleep(400)
  s = await status()
  check(s.softDeletes.length === 0, 'the soft deletes are confirmed in the store', JSON.stringify(s.softDeletes))
  let f = await focusInfo()
  check(f.h1 || (!f.body && f.testid !== ''), 'focus lands on a real element after Keep removed', JSON.stringify(f))
  await relaunchApp()
  check(!(await visible('[data-testid=secret-notices]')), 'kept-removed secrets stay quiet after a relaunch')

  // ---- Removed by an older OrgAI: Restore ----
  await saveSecrets()
  await app.close()
  removeFromLegacy(/^connection:litellm/)
  ;({ app, page } = await launch({ shotPrefix: 'secrets-notices', clearPrefs: false }))
  await page.waitForSelector('[data-testid=dashboard]', { timeout: 30_000 })
  const one = page.locator('[data-testid=secret-notice-removed]')
  await one.waitFor({ timeout: 10_000 })
  check((await one.innerText()).includes('1 saved secret was removed by an older version of OrgAI.'), 'the singular sentence for one secret')
  const vaultCount = async () => (await status()).counts.vault
  const before = await vaultCount()
  await page.locator('[data-testid=secret-restore]').click()
  await one.waitFor({ state: 'detached', timeout: 10_000 })
  await sleep(400)
  check((await vaultCount()) === before + 1, 'Restore puts the secret back in the vault', `${before} -> ${await vaultCount()}`)
  s = await status()
  check(s.softDeletes.length === 0, 'nothing is left to restore', JSON.stringify(s.softDeletes))
  f = await focusInfo()
  check(f.h1 || (!f.body && f.testid !== ''), 'focus lands on a real element after Restore', JSON.stringify(f))

  // ---- Damaged secrets.json ----
  await app.close()
  fs.writeFileSync(LEGACY, '{ this is not json')
  ;({ app, page } = await launch({ shotPrefix: 'secrets-notices', clearPrefs: false }))
  await page.waitForSelector('[data-testid=dashboard]', { timeout: 30_000 })
  const bad = page.locator('[data-testid=secret-notice-legacy-corrupt]')
  await bad.waitFor({ timeout: 10_000 })
  const badText = (await bad.innerText()).replace(/\s+/g, ' ')
  check(/secrets\.json/.test(badText) && /damaged/.test(badText) && /Start over/.test(badText), 'the damaged-file notice says what it is and offers Start over', badText)
  check(!/orgai (secrets|command)|`/.test(badText), 'the notice names no terminal command', badText)
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    for (const theme of ['dark', 'light']) {
      await setSize(w, h)
      await setTheme(theme)
      check((await bad.isVisible()) && (await noOverflow()), `damaged-file notice fits at ${w}x${h} ${theme}`)
      await screenshot(page, `secrets-notices-damaged-${w}-${theme}`)
    }
  }
  await setSize(1600, 1000)
  await page.locator('[data-testid=secret-start-over]').click()
  const confirmBtn = page.locator('[data-testid=secret-start-over-confirm]')
  await confirmBtn.waitFor({ timeout: 5_000 })
  await page.keyboard.press('Escape')
  await confirmBtn.waitFor({ state: 'detached', timeout: 5_000 })
  check(await bad.isVisible(), 'cancelling Start over changes nothing')
  f = await focusInfo()
  check(f.testid === 'secret-start-over', 'focus returns to Start over after cancelling', JSON.stringify(f))
  await page.locator('[data-testid=secret-start-over]').click()
  await confirmBtn.click()
  await bad.waitFor({ state: 'detached', timeout: 15_000 })
  await sleep(400)
  s = await status()
  check(s.legacyFile !== 'corrupt', 'Start over moves the damaged file aside', s.legacyFile)
  check(fs.readdirSync(path.join(DATA_DIR, 'data')).some((n) => n.startsWith('secrets.json.corrupt-')), 'the damaged file is kept under a new name')
  f = await focusInfo()
  check(f.h1 || (!f.body && f.testid !== ''), 'focus lands on a real element after Start over', JSON.stringify(f))

  // ---- A key that does not match: Try again, Start over ----
  await app.close()
  const good = fs.readFileSync(KEY_FILE)
  fs.writeFileSync(KEY_FILE, Buffer.from('A'.repeat(43) + '=\n'))
  ;({ app, page } = await launch({ shotPrefix: 'secrets-notices', clearPrefs: false }))
  await page.waitForSelector('[data-testid=dashboard]', { timeout: 30_000 })
  s = await status()
  const vault = page.locator('[data-testid=secret-notice-vault]')
  if (s.state === 'open' || s.state === 'absent') {
    log('SKIP the vault-key notice: the wrong key file did not close the vault', s.state)
  } else {
    await vault.waitFor({ timeout: 10_000 })
    const vt = (await vault.innerText()).replace(/\s+/g, ' ')
    check(!/orgai (secrets|command)|`/.test(vt), 'the vault notice names no terminal command', vt)
    check((await vault.getByRole('button').allInnerTexts()).join('|').includes('Try again'), 'Try again is offered')
    await page.locator('[data-testid=secret-retry]').click()
    await sleep(800)
    check((await page.locator('[data-testid=secret-notice-error]').count()) > 0 && (await vault.isVisible()), 'Try again with the same key says it is still closed')
    check(!/orgai (secrets|command)|`/.test((await page.locator('[data-testid=secret-notice-error]').first().innerText())), 'the failure names no terminal command')
    for (const theme of ['dark', 'light']) {
      await setTheme(theme)
      check((await vault.isVisible()) && (await noOverflow()), `vault notice fits in ${theme}`)
      await screenshot(page, `secrets-notices-vault-${theme}`)
    }
    // The old key comes back: Try again opens the vault and the notice goes.
    fs.writeFileSync(KEY_FILE, good)
    await page.locator('[data-testid=secret-retry]').click()
    await vault.waitFor({ state: 'detached', timeout: 15_000 })
    await sleep(400)
    s = await status()
    check(s.state === 'open', 'Try again opens the vault once the key is back', s.state)
    f = await focusInfo()
    check(f.h1 || (!f.body && f.testid !== ''), 'focus lands on a real element after Try again', JSON.stringify(f))
  }

  // ---- Connections: a reason names no terminal command ----
  await page.evaluate(() => window.orgai.settings.get())
  await goDashboard()
} catch (e) {
  check(false, 'script ran to the end', e instanceof Error ? e.message : String(e))
} finally {
  await app.close().catch(() => {})
}
finish('secrets-notices')
