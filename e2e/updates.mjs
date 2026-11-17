// Token- and network-free. Mock adapter, temp ORGAI_DATA_DIR, ORGAI_UPDATE_MOCK (src/main/updaterMock.ts; honoured only
// by an unpackaged app) switched per launch. The renderer side of the desktop updater (docs/agent-notes/updates.md
// "Renderer"): App settings > About > Updates and the sidebar notice.
//   available:      Help > Check for Updates… lands on About with the Updates heading focused; check -> available;
//                   the release notes' HTML shows as text (no element made from it); the sidebar notice appears off
//                   App settings, without taking focus, opens About, and its dismissal holds for the version;
//                   download progress with a text equivalent -> downloaded; Restart and install with a live mock run
//                   asks first (run count), Not now installs nothing, the confirmation installs (force) and the
//                   block says it is restarting. Both themes at 1024x640 and 1600x1000 without horizontal overflow.
//   download-error: the download fails at 60 %, Retry download starts it again.
//   manual:         the release page action (shell.openExternal stubbed), no download offered, download refused.
//   error:          the check fails with the fixed sentence and offers Check again.
//   up-to-date:     up to date with a last-checked line and no notice.
// The "Check for updates automatically" switch is turned off in one launch and found off in the next.
import { check, cleanup, createProject, finish, gotoProjects, launch, makeFixtureRepo, openAppSettings, openProject, removeFixture, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'

const NAME = 'E2E updates (orgai test)'
const repo = makeFixtureRepo('updates')

let app
let page

async function start(mode) {
  process.env.ORGAI_UPDATE_MOCK = mode
  ;({ app, page } = await launch({ shotPrefix: `updates-${mode}` }))
  page.setDefaultTimeout(8000)
  // Never open a real browser: record what the release page action would open.
  await app.evaluate(({ shell }) => {
    globalThis.__orgaiOpened = []
    shell.openExternal = async (url) => {
      globalThis.__orgaiOpened.push(url)
    }
  })
}
async function stop() {
  await app?.close().catch(() => {})
  app = undefined
}

const menu = (id) =>
  app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId)
    if (!item) throw new Error(`no menu item ${itemId}`)
    item.click()
  }, id)
const setSize = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await sleep(400)
}
const setTheme = async (theme) => {
  await page.evaluate(async (t) => {
    const s = await window.orgai.settings.get()
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, theme: t } })
  }, theme)
  await sleep(500)
}
const visible = async (sel) => (await page.locator(sel).count()) > 0 && (await page.locator(sel).first().isVisible())
const text = async (sel) => (await page.locator(sel).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
const status = () => text('[data-testid=updates-status]')
const action = () => text('[data-testid=updates-action]')
const waitText = async (sel, re, timeout = 10_000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (re.test(await text(sel))) return true
    await sleep(100)
  }
  return false
}
const focusedId = () => page.evaluate(() => document.activeElement?.id ?? '')
const opened = () => app.evaluate(() => globalThis.__orgaiOpened ?? [])
/** Open App settings > About by the gear and the pane tab. */
async function openAbout() {
  await openAppSettings(page)
  await page.getByRole('tab', { name: 'About' }).click()
  await page.locator('[data-testid=updates-block]').waitFor()
}
const noOverflow = () =>
  page.evaluate(() => {
    const block = document.querySelector('[data-testid=updates-block]')
    const scroller = block?.closest('.settings-col') ?? document.documentElement
    return !!block && block.scrollWidth <= block.clientWidth + 1 && scroller.scrollWidth <= scroller.clientWidth + 1
  })

try {
  // ---------------- available (with a live mock run) ----------------
  await start('available')
  {
    const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
    check(!!project, 'project created on the mock adapter')
    await page.locator('[data-testid=tab-live]').click()
    await page.locator('.new-run').waitFor({ timeout: 10_000 })
    await page.locator('.composer textarea').fill('Updates check task')
    await page.locator('.composer .btn.primary').click()
    await page.locator('[data-testid=run-meta]').waitFor({ timeout: 20_000 })

    check(!(await visible('[data-testid=update-notice]')), 'no sidebar notice before a check found anything')

    // Help > Check for Updates…: main checks, the renderer lands on About > Updates.
    await menu('check-for-updates')
    await page.locator('[data-testid=updates-block]').waitFor({ timeout: 10_000 })
    await page.waitForFunction(() => document.activeElement?.id === 'appsettings-updates-title', null, { timeout: 4000 }).catch(() => {})
    check((await focusedId()) === 'appsettings-updates-title', 'Check for Updates… focuses the Updates heading', await focusedId())
    check(await waitText('[data-testid=updates-status]', /Version 99\.0\.0 is available\./), 'the menu check finds 99.0.0', await status())
    check((await action()) === 'Download update', 'the primary action is Download update', await action())
    check(await visible('[data-testid=updates-release-page]'), 'the release page is offered beside it')
    check(/\d{4} \d\d:\d\d/.test(await text('[data-testid=updates-checked]')), 'the last check time shows', await text('[data-testid=updates-checked]'))
    check((await text('[data-testid=updates-current]')).length > 0, 'the installed version shows')

    // Untrusted notes: shown as text, nothing built from them.
    const notes = await page.evaluate(() => {
      const el = document.querySelector('[data-testid=updates-notes]')
      return el ? { text: el.textContent ?? '', children: el.childElementCount, tags: el.querySelectorAll('*').length } : null
    })
    // Main strips the mock's tags and decodes entities once before IPC (updater.ts plainReleaseNotes).
    check(!!notes && notes.text.includes('OrgAI 99.0.0') && notes.text.includes('HTML & are shown as text'), 'the release notes show as plain text', JSON.stringify(notes))
    check(!!notes && notes.children === 0 && notes.tags === 0, 'no element is created from the release notes', JSON.stringify(notes))
    // Tag-like text can still arrive (an entity-encoded tag decodes to "<img ...>" after stripping): push such a state
    // to the renderer on main's channel and check it stays a text node.
    const hostile = '<img src=x onerror="window.__orgaiPwned=1"><b>bold</b> [link](https://example.com) https://example.com'
    await app.evaluate(async ({ BrowserWindow }, notesText) => {
      const w = BrowserWindow.getAllWindows()[0]
      const real = await w.webContents.executeJavaScript('window.orgai.updates.get()')
      w.webContents.send('updates:changed', { ...real, releaseNotes: notesText })
    }, hostile)
    await sleep(400)
    const injected = await page.evaluate(() => {
      const el = document.querySelector('[data-testid=updates-notes]')
      return el ? { text: el.textContent ?? '', tags: el.querySelectorAll('*').length, pwned: (window).__orgaiPwned === 1, imgs: document.querySelectorAll('[data-testid=updates-block] img, [data-testid=updates-block] b').length } : null
    })
    check(!!injected && injected.text === hostile && injected.tags === 0 && injected.imgs === 0 && !injected.pwned, 'tag-like, Markdown and URL text in the notes renders as literal text (no element, no link, no script)', JSON.stringify(injected))
    await page.screenshot({ path: 'e2e/shots/updates-available-hostile-notes.png' })
    // Back to main's own state.
    await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.webContents.send('updates:changed', await w.webContents.executeJavaScript('window.orgai.updates.get()'))
    })
    await sleep(200)
    check(await page.evaluate(() => document.querySelector('[data-testid=updates-block] a[href*="github.com"]') === null), 'the release URL is never an anchor')

    // The notice stays away on App settings, appears elsewhere without taking focus.
    check(!(await visible('[data-testid=update-notice]')), 'no sidebar notice on App settings (the block says it)')
    await gotoProjects(page)
    const before = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80) ?? '')
    await page.locator('[data-testid=update-notice]').waitFor({ timeout: 4000 }).catch(() => {})
    check(/Update available: 99\.0\.0/.test(await text('[data-testid=update-notice]')), 'the sidebar notice says an update is available', await text('[data-testid=update-notice]'))
    check((await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80) ?? '')) === before, 'the notice does not move focus')
    await page.locator('[data-testid=update-notice-open]').click()
    await page.locator('[data-testid=updates-block]').waitFor()
    await page.waitForFunction(() => document.activeElement?.id === 'appsettings-updates-title', null, { timeout: 4000 }).catch(() => {})
    check((await focusedId()) === 'appsettings-updates-title', 'the notice opens About with the Updates heading focused')

    // Toggle off, persisted (the next launch checks it is still off).
    const sw = page.locator('[data-testid=auto-update-check-switch]')
    check((await sw.getAttribute('aria-checked')) === 'true', 'automatic checks are on by default')
    await sw.click()
    await sleep(600)
    check((await page.evaluate(() => window.orgai.settings.get().then((s) => s.autoUpdateCheck))) === false, 'turning the switch off saves autoUpdateCheck false')

    // Download with progress, by keyboard.
    await page.locator('[data-testid=updates-action]').focus()
    await page.keyboard.press('Enter')
    await page.locator('[data-testid=updates-progress]').waitFor({ timeout: 4000 }).catch(() => {})
    const bar = await page.evaluate(() => {
      const p = document.querySelector('[data-testid=updates-progress] progress')
      return p ? { label: p.getAttribute('aria-label'), text: p.getAttribute('aria-valuetext') } : null
    })
    check(!!bar && bar.label === 'Download progress' && /%/.test(bar.text ?? ''), 'the progress bar has a name and a text equivalent', JSON.stringify(bar))
    check(/^Downloading/.test(await status()), 'the status says it is downloading', await status())
    check((await page.locator('[data-testid=updates-action]').getAttribute('aria-disabled')) === 'true', 'the action stays focusable but inert while downloading')
    check(await waitText('[data-testid=updates-status]', /is ready/), 'the download finishes', await status())
    check((await action()) === 'Restart and install', 'the primary action is Restart and install', await action())
    check((await focusedId()) === '' && (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'updates-action', 'focus stayed on the action through the download')
    check(await waitText('[data-testid=updates-announce]', /downloaded|ready/i, 2000),'the polite region announced the finished download', await text('[data-testid=updates-announce]'))

    // Both themes and window sizes.
    for (const [w, h] of [
      [1024, 640],
      [1600, 1000]
    ]) {
      for (const theme of ['dark', 'light']) {
        await setSize(w, h)
        await setTheme(theme)
        await page.locator('[data-testid=updates-block]').scrollIntoViewIfNeeded()
        check(await noOverflow(), `no horizontal overflow at ${w}x${h} ${theme}`)
        await page.screenshot({ path: `e2e/shots/updates-available-downloaded-${w}x${h}-${theme}.png` })
      }
    }
    await setTheme('dark')

    // The ready notice and its dismissal (for this version).
    await gotoProjects(page)
    await page.locator('[data-testid=update-notice]').waitFor({ timeout: 4000 }).catch(() => {})
    check(/Update ready: 99\.0\.0/.test(await text('[data-testid=update-notice]')), 'the notice says the update is ready', await text('[data-testid=update-notice]'))
    await page.locator('[data-testid=update-notice-dismiss]').click()
    await sleep(300)
    check(!(await visible('[data-testid=update-notice]')), 'Dismiss hides the notice')
    check((await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'app-settings-button', 'focus moves to App settings after Dismiss')
    await openProject(page, NAME)
    check(!(await visible('[data-testid=update-notice]')), 'the dismissed notice stays hidden elsewhere')

    // Install with a live run: asks first; Not now installs nothing; the confirmation installs.
    await openAbout()
    await page.locator('[data-testid=updates-action]').click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ timeout: 4000 }).catch(() => {})
    const body = (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ')
    check(/stops \d+ working runs?\. They stay in History and can be continued/.test(body), 'the confirmation says how many runs stop and that they stay continuable', body)
    await page.screenshot({ path: 'e2e/shots/updates-available-confirm.png' })
    await dialog.getByRole('button', { name: 'Not now' }).click()
    await sleep(300)
    check(/Not installed now/.test(await text('[data-testid=updates-feedback]')), 'Not now says nothing was installed', await text('[data-testid=updates-feedback]'))
    check((await page.evaluate(() => window.orgai.updates.get().then((s) => !!s.installing))) === false, 'Not now did not install')
    await page.locator('[data-testid=updates-action]').click()
    await page.locator('[data-testid=updates-install-confirm]').click()
    check(await waitText('[data-testid=updates-status]', /Restarting to install version 99\.0\.0/), 'the confirmed install shows the restart', await status())
    check((await action()) === 'Restarting…', 'the action reads Restarting… and is inert', await action())
    await page.screenshot({ path: 'e2e/shots/updates-available-installing.png' })

    await openProject(page, NAME)
    await cleanup(undefined, page, NAME)
  }
  await stop()

  // ---------------- download-error ----------------
  await start('download-error')
  {
    await openAbout()
    const sw = page.locator('[data-testid=auto-update-check-switch]')
    check((await sw.getAttribute('aria-checked')) === 'false', 'the automatic-check switch stayed off after a relaunch')
    await sw.click()
    await sleep(600)
    check((await page.evaluate(() => window.orgai.settings.get().then((s) => s.autoUpdateCheck))) === true, 'turning it back on saves true')
    await page.locator('[data-testid=updates-action]').click()
    check(await waitText('[data-testid=updates-status]', /Version 99\.0\.0 is available\./), 'download-error: the check finds 99.0.0', await status())
    await page.locator('[data-testid=updates-action]').click()
    check(await waitText('[data-testid=updates-status]', /^Could not download version 99\.0\.0\. .*connection/i), 'the failed download names the version and says why', await status())
    check((await action()) === 'Retry download', 'the action offers Retry download', await action())
    await page.screenshot({ path: 'e2e/shots/updates-download-error.png' })
    await page.locator('[data-testid=updates-action]').click()
    check(await waitText('[data-testid=updates-status]', /^Downloading/, 3000), 'Retry download starts the download again', await status())
    check(await waitText('[data-testid=updates-status]', /offline|internet|connection/i), 'and it fails again the same way', await status())
  }
  await stop()

  // ---------------- manual ----------------
  await start('manual')
  {
    await openAbout()
    check(/Not checked yet/.test(await status()), 'manual: not checked yet before a check', await status())
    await page.locator('[data-testid=updates-action]').click()
    check(await waitText('[data-testid=updates-status]', /Version 99\.0\.0 is available\./), 'manual: the check finds 99.0.0', await status())
    check(/updated by hand.*release page/.test(await text('[data-testid=updates-capability]')), 'manual: the block explains why there is no download', await text('[data-testid=updates-capability]'))
    check((await action()) === 'Open release page', 'manual: the action is Open release page', await action())
    check(!(await page.getByRole('button', { name: /Download update|Restart and install/ }).count()), 'manual: no download or install button')
    await page.screenshot({ path: 'e2e/shots/updates-manual.png' })
    await page.locator('[data-testid=updates-action]').click()
    await sleep(400)
    const urls = await opened()
    check(urls.length === 1 && /\/releases\/tag\/v99\.0\.0$/.test(urls[0]), 'manual: Open release page opens the tag page through main', JSON.stringify(urls))
    check(/Opened the release page/.test(await text('[data-testid=updates-feedback]')), 'manual: the block says the page opened', await text('[data-testid=updates-feedback]'))
    const refused = await page.evaluate(() => window.orgai.updates.download())
    check(refused.ok === false && refused.reason === 'unsupported', 'manual: a download is refused', JSON.stringify(refused))
    await gotoProjects(page)
    check(/Update available: 99\.0\.0/.test(await text('[data-testid=update-notice]')), 'manual: the sidebar notice shows too')
  }
  await stop()

  // ---------------- error ----------------
  await start('error')
  {
    await openAbout()
    await page.locator('[data-testid=updates-action]').click()
    check(await waitText('[data-testid=updates-status]', /offline|internet|connection|reach/i), 'error: the failed check says why', await status())
    check((await action()) === 'Check again', 'error: the action is Check again', await action())
    check(!(await visible('[data-testid=updates-notes]')), 'error: no release notes')
    await page.screenshot({ path: 'e2e/shots/updates-error.png' })
  }
  await stop()

  // ---------------- up-to-date ----------------
  await start('up-to-date')
  {
    await openAbout()
    await page.locator('[data-testid=updates-action]').click()
    check(await waitText('[data-testid=updates-status]', /is up to date\./), 'up-to-date: says up to date', await status())
    check(/^Last checked /.test(await text('[data-testid=updates-checked]')), 'up-to-date: the last-checked line shows', await text('[data-testid=updates-checked]'))
    check((await action()) === 'Check for updates', 'up-to-date: the action is Check for updates again', await action())
    await gotoProjects(page)
    check(!(await visible('[data-testid=update-notice]')), 'up-to-date: no sidebar notice')
  }
} finally {
  if (app && page && !page.isClosed()) await cleanup(app, page, NAME).catch(() => {})
  await stop()
  removeFixture(repo)
  delete process.env.ORGAI_UPDATE_MOCK
}
finish('updates')
