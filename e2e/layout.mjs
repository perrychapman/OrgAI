// Token-free. Creates projects in both form modes with "Skip AI setup", checks the live view's layout with a very
// long repository path (no horizontal page scroll, sidebar visible, empty state shown), screenshots, and deletes them.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, cleanup, endSession, openAppSettings, projectTab, runRecordsDir, createProject, deleteProject, findProject, finish, launch, log, makeFixtureRepo, openProject, removeFixture, sleep } from './lib.mjs'

// The scripted mock adapter (no tokens) is opt-in via this env var; the app child inherits it.
process.env.ORGAI_MOCK = '1'

// 1x1 transparent PNG, pasted into the composer to exercise the image path.
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const NAME = 'E2E layout (orgai test)'
const NEW_NAME = 'E2E layout new idea (orgai test)'

// A long path stresses the topbar folder name.
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-layout-'))
const repo = path.join(base, 'a-rather-long-directory-name-for-layout-checks', 'and-another-nested-level-to-make-it-longer', 'repo')
makeFixtureRepo('layout', { at: repo })

const { app, page, shot } = await launch({ shotPrefix: 'layout' })
try {
  log('auth pill:', await page.locator('[data-testid=auth-pill]').innerText())

  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'existing-repo project created')
  check(project?.setup === undefined, 'skip AI setup leaves no setup record')
  check(project?.roles?.length === 4, 'default org chart has 4 roles', String(project?.roles?.length))
  check((await page.locator('.editor').count()) > 0, 'lands on the org chart editor after create')
  await shot('editor')

  await projectTab(page, 'Live').click()
  await sleep(800)
  const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
  check(overflow.sw <= overflow.cw, 'live view has no horizontal page scroll', `${overflow.sw}/${overflow.cw}`)
  check(await page.locator('.sidebar').isVisible(), 'sidebar stays visible with a long path')
  const pillBox = await page.locator('[data-testid=project-folder]').boundingBox()
  const vw = await page.evaluate(() => window.innerWidth)
  check(!!pillBox && pillBox.x + pillBox.width <= vw, 'folder name fits in the window', JSON.stringify(pillBox))
  const heading = await page.locator('.new-run h2').innerText({ timeout: 5000 }).catch(() => '')
  check(/something to do/i.test(heading), 'empty state invites a first task', heading)
  check((await page.locator('.composer textarea').count()) === 1, 'composer is present')
  await shot('live-long-path')

  // Viewport x theme matrix on the live view (screenshots for visual review), checking the composer never overflows.
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
    await sleep(400)
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await sleep(300)
      const m = await page.evaluate(() => {
        const c = document.querySelector('.composer')?.getBoundingClientRect()
        return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, ch: window.innerHeight, iw: window.innerWidth, c: c && { l: c.left, r: c.right, b: c.bottom } }
      })
      check(m.sw <= m.cw, `no horizontal scroll at ${w}x${h} ${theme}`, JSON.stringify(m))
      check(!!m.c && m.c.r <= m.iw + 0.5 && m.c.l >= 0 && m.c.b <= m.ch + 0.5, `composer inside viewport at ${w}x${h} ${theme}`, JSON.stringify(m))
      await shot(`live-${w}x${h}-${theme}`)
    }
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))

  // Image paste under the mock adapter: switch the project to it, then paste, send, and read the transcript.
  const live = await findProject(page, NAME)
  await page.evaluate((p) => window.orgai.projects.save({ ...p, provider: { ...p.provider, id: 'mock' } }), live)
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  await openProject(page, NAME)
  await projectTab(page, 'Live').click()
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.evaluate((el, b64) => {
    const bin = atob(b64)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'tiny.png', { type: 'image/png' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, TINY_PNG)
  await page.locator('.attach-item').first().waitFor({ timeout: 5000 }).catch(() => {})
  check((await page.locator('.attach-item .attach-thumb').count()) === 1, 'pasted image shows a thumbnail')
  check((await page.getByRole('button', { name: 'Remove image 1' }).count()) === 1, 'thumbnail has a "Remove image 1" button')
  const cm = await page.evaluate(() => {
    const f = document.querySelector('.composer-field')?.getBoundingClientRect()
    const c = document.querySelector('.composer')?.getBoundingClientRect()
    return { f: f && [f.left, f.right], c: c && [c.left, c.right] }
  })
  check(!!cm.f && !!cm.c && cm.f[0] >= cm.c[0] - 0.5 && cm.f[1] <= cm.c[1] + 0.5, 'composer-field stays inside the composer', JSON.stringify(cm))
  await shot('composer-with-image')
  await ta.focus()
  await shot('composer-focused')
  await ta.fill('Look at this image')
  await page.locator('.composer .btn.primary').click()
  await page.locator('.entry.user').first().waitFor({ timeout: 15_000 }).catch(() => {})
  check((await page.locator('.entry.user .entry-thumb').count()) >= 1, 'user transcript entry shows an image thumbnail')
  check((await page.locator('.attach-item').count()) === 0, 'attachment strip clears after sending')
  await shot('transcript-with-image')

  // Persistence: end the session, reload the renderer, reopen the run from history and expect the thumbnail
  // to be rehydrated from the on-disk image store. Project deletion below removes the run; leftovers are checked after.
  await endSession(page)
  const imageDirs = () => {
    const out = []
    try {
      for (const d of fs.readdirSync(runRecordsDir(), { withFileTypes: true })) {
        const img = path.join(runRecordsDir(), d.name, 'images')
        if (d.isDirectory() && fs.existsSync(img) && fs.readdirSync(img).length) out.push(d.name)
      }
    } catch {}
    return out
  }
  const withImages = imageDirs()
  check(withImages.length >= 1, 'sent image is stored on disk under runs/<id>/images', withImages.join(','))
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  await openProject(page, NAME)
  await sleep(800)
  check((await page.locator('.new-run').count()) === 0 && (await page.locator('.run-tab[aria-selected="true"]').count()) === 1, 'a project with history opens on its newest run, not the empty state')
  await projectTab(page, 'History').click()
  await sleep(500)
  check((await page.locator('.run-row').count()) >= 1, 'run appears in the History tab after reload')
  if ((await page.locator('.run-row button.run-open').count()) > 0) await page.locator('.run-row button.run-open').first().click()
  else await projectTab(page, 'Live').click()
  await sleep(1500)
  await page.locator('[data-testid=side-tab-transcript], .side .tabs button:has-text("Transcript")').first().click()
  await sleep(500)
  const reopenedThumb = page.locator('.entry.user .entry-thumb').first()
  check((await reopenedThumb.count()) >= 1, 'reopened run transcript still shows the image thumbnail')
  const loaded = await reopenedThumb.evaluate((el) => {
    const img = el.tagName === 'IMG' ? el : el.querySelector('img')
    return !!img && img.complete && img.naturalWidth > 0
  }).catch(() => false)
  check(loaded, 'reopened thumbnail image decodes (rehydrated from disk)')
  await shot('transcript-with-image-reopened')

  // Run tabs keyboard model: Ctrl+T opens the New run page as a second tab, Ctrl+W closes it again.
  await projectTab(page, 'Live').click()
  await sleep(500)
  check((await page.locator('.run-tabs [role="tablist"] [role="tab"]').count()) === 1, 'one run tab for the reopened run')
  check((await page.locator('.canvas-toolbar').count()) === 0, 'no toolbar floats over the canvas')
  await page.keyboard.press('Control+t')
  await sleep(400)
  check((await page.locator('.new-run').count()) === 1, 'Ctrl+T opens the New run page')
  check((await page.locator('.run-tabs [role="tab"]').count()) === 2, 'the New run page is a second tab')
  check((await page.locator('[data-testid=run-meta]').count()) === 0 && (await page.locator('.react-flow').count()) === 0, 'no other run is on screen on the New run page')
  await shot('new-run-page')
  await page.keyboard.press('Control+w')
  await sleep(400)
  check((await page.locator('.new-run').count()) === 0 && (await page.locator('[data-testid=run-meta]').count()) === 1, 'Ctrl+W closes the New run page and returns to the run')
  await page.locator('.run-tab-new').click()
  await sleep(300)
  check((await page.locator('.new-run').count()) === 1, 'the + button opens the New run page')
  await page.locator('.run-tab[aria-selected="false"]').first().focus()
  await page.keyboard.press('ArrowRight')
  check(await page.evaluate(() => document.activeElement?.getAttribute('aria-selected') === 'true'), 'ArrowRight moves focus to the next tab')
  await page.keyboard.press('ArrowLeft')
  check(await page.evaluate(() => document.activeElement?.getAttribute('aria-selected') === 'false'), 'ArrowLeft moves focus back')
  await page.keyboard.press('Enter')
  await sleep(400)
  check((await page.locator('[data-testid=run-meta]').count()) === 1, 'Enter activates the focused tab')

  // Run tabs, run header, composer and the History tab in the viewport x theme matrix.
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
    await sleep(400)
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await sleep(300)
      await projectTab(page, 'Live').click()
      await sleep(300)
      const m = await page.evaluate(() => {
        const r = (sel) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b && { l: b.left, r: b.right, t: b.top, b: b.bottom } }
        return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, iw: window.innerWidth, ih: window.innerHeight, tabs: r('.run-tabs'), strip: r('[data-testid=run-strip]'), toolbar: r('.frame-toolbar'), stage: r('.frame-stage'), frame: r('.canvas-frame'), topbar: r('main .topbar'), composer: r('.composer'), side: document.querySelector('.side-panel')?.getAttribute('data-collapsed') }
      })
      const inside = (b) => !!b && b.l >= -0.5 && b.r <= m.iw + 0.5 && b.t >= -0.5 && b.b <= m.ih + 0.5
      const shellM = await page.evaluate(() => {
        const hh = (sel) => document.querySelector(sel)?.getBoundingClientRect().height
        return { topbar: hh('main .topbar'), brand: hh('.sidebar .brand-lockup'), footer: hh('.sidebar-footer'), side: document.querySelector('.sidebar')?.getBoundingClientRect().width }
      })
      check(Math.abs(shellM.topbar - 48) <= 1, `topbar is 48 px high at ${w}x${h} ${theme}`, JSON.stringify(shellM))
      check(Math.abs(shellM.brand - 48) <= 1, `brand row is 48 px high at ${w}x${h} ${theme}`, JSON.stringify(shellM))
      check(w < 1180 ? Math.abs(shellM.side - 56) <= 1 : Math.abs(shellM.side - 232) <= 1, `sidebar is ${w < 1180 ? 'a 56 px rail' : '232 px wide'} at ${w}x${h} ${theme}`, JSON.stringify(shellM))
      if (w >= 1180) check(shellM.footer < 80, `sidebar footer is under 80 px at ${w}x${h} ${theme}`, JSON.stringify(shellM))
      check((await page.locator('main .topbar .badge').count()) === 0, `no status badge in the topbar on Live at ${w}x${h} ${theme}`)
      check(m.sw <= m.cw, `no horizontal scroll with runs at ${w}x${h} ${theme}`, JSON.stringify(m))
      check(inside(m.tabs), `run tabs inside viewport at ${w}x${h} ${theme}`, JSON.stringify(m.tabs))
      check(inside(m.strip), `run strip inside viewport at ${w}x${h} ${theme}`, JSON.stringify(m.strip))
      check(inside(m.composer), `composer with mode row inside viewport at ${w}x${h} ${theme}`, JSON.stringify(m.composer))
      check(!!m.strip && !!m.topbar && m.strip.t >= m.topbar.b - 0.5 && Math.abs(m.strip.b - m.strip.t - 40) <= 1.5, `run strip is 40 px and sits under the topbar at ${w}x${h} ${theme}`, JSON.stringify([m.topbar, m.strip]))
      check(!!m.toolbar && !!m.strip && m.toolbar.t >= m.strip.b - 0.5 && Math.abs(m.toolbar.b - m.toolbar.t - 32) <= 1.5, `canvas toolbar is 32 px and sits under the strip at ${w}x${h} ${theme}`, JSON.stringify([m.strip, m.toolbar]))
      check(!!m.tabs && !!m.strip && m.tabs.l >= m.strip.l - 0.5 && m.tabs.r <= m.strip.r + 0.5, `run tabs live inside the strip at ${w}x${h} ${theme}`, JSON.stringify([m.strip, m.tabs]))
      check(!!m.stage && !!m.toolbar && m.stage.t >= m.toolbar.b - 0.5, `stage sits under the toolbar at ${w}x${h} ${theme}`, JSON.stringify([m.toolbar, m.stage]))
      check(w >= 1100 || m.side === 'true', `run panel starts collapsed below 1100 px of main width at ${w}x${h} ${theme}`, String(m.side))
      check((await page.locator('.react-flow__controls').count()) === 0, `React Flow controls are gone from the canvas at ${w}x${h} ${theme}`)
      check((await page.locator('[data-testid=run-strip] .btn:visible').first().evaluate((el) => el.getBoundingClientRect().height).catch(() => 28)) <= 36, `strip buttons fit the 40 px strip at ${w}x${h} ${theme}`)
      log(`chrome above canvas at ${w}x${h} ${theme}:`, m.stage ? Math.round(m.stage.t) : '?', 'px; stage', m.stage ? `${Math.round(m.stage.r - m.stage.l)}x${Math.round(m.stage.b - m.stage.t)}` : '?')
      // The legend lives behind the toolbar "?" popover: a shape plus a word per state.
      const legendBtn = page.locator('[data-testid=canvas-legend-trigger]')
      await legendBtn.click()
      await sleep(250)
      const legendText = ((await page.locator('[data-testid=canvas-legend]').innerText().catch(() => '')) || '').toLowerCase()
      check(['working', 'needs approval', 'done', 'error', 'message'].every((t) => legendText.includes(t)), `legend popover lists all five states at ${w}x${h} ${theme}`, legendText.replace(/\s+/g, ' '))
      await page.keyboard.press('Escape')
      await sleep(150)
      check((await page.locator('.frame-footer').count()) === 0, `no legend row under the canvas at ${w}x${h} ${theme}`)
      const zoomBefore = await page.evaluate(() => document.querySelector('.react-flow__viewport')?.style.transform ?? '')
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
      await sleep(350)
      const zoomAfter = await page.evaluate(() => document.querySelector('.react-flow__viewport')?.style.transform ?? '')
      check(zoomBefore !== zoomAfter, `the toolbar Zoom in button zooms the canvas at ${w}x${h} ${theme}`, `${zoomBefore} -> ${zoomAfter}`)
      await page.getByRole('button', { name: 'Fit to view', exact: true }).click()
      const tab = page.locator('.run-tab[aria-selected="true"]')
      await tab.focus()
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Tab') // keyboard modality so :focus-visible matches
      const ring = await tab.evaluate((el) => { const s = getComputedStyle(el); return { o: s.outlineStyle, ow: s.outlineWidth, bs: s.boxShadow } })
      check((ring.o !== 'none' && parseFloat(ring.ow) > 0) || ring.bs !== 'none', `run tab shows a focus ring at ${w}x${h} ${theme}`, JSON.stringify(ring))
      // A pointer click must not paint the keyboard focus ring.
      const tb = await tab.boundingBox()
      await page.evaluate(() => document.activeElement?.blur())
      await page.mouse.move(5, 5)
      await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2)
      await sleep(150)
      const mring = await page.evaluate(() => { const el = document.activeElement; if (!el || !el.matches('.run-tab')) return { skipped: true }; const s = getComputedStyle(el); return { o: s.outlineStyle, ow: s.outlineWidth, fv: el.matches(':focus-visible') } })
      check(!!mring.skipped || (!mring.fv && (mring.o === 'none' || parseFloat(mring.ow) === 0)), `a mouse click on a run tab shows no focus ring at ${w}x${h} ${theme}`, JSON.stringify(mring))
      await shot(`live-run-${w}x${h}-${theme}`)
      await projectTab(page, 'History').click()
      await sleep(300)
      const hm = await page.evaluate(() => {
        const b = document.querySelector('.run-row')?.getBoundingClientRect()
        return { iw: window.innerWidth, ih: window.innerHeight, row: b && { l: b.left, r: b.right, t: b.top, b: b.bottom } }
      })
      check(!!hm.row && hm.row.l >= -0.5 && hm.row.r <= hm.iw + 0.5 && hm.row.b <= hm.ih + 0.5, `History row inside viewport at ${w}x${h} ${theme}`, JSON.stringify(hm))
      await shot(`history-${w}x${h}-${theme}`)
    }
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))

  // Keyboard order: skip to content, skip to sidebar, the sidebar toggle, then Projects.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000))
  await sleep(300)
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  await sleep(600)
  const stops = []
  await page.evaluate(() => document.querySelector('.skip-link')?.focus())
  for (let i = 0; i < 4; i++) {
    if (i > 0) await page.keyboard.press('Tab')
    stops.push(await page.evaluate(() => (document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent || '').trim()))
  }
  check(stops[0] === 'Skip to content' && stops[1] === 'Skip to sidebar' && /sidebar/i.test(stops[2]) && /Projects/.test(stops[3]), 'first Tab stops are the two skip links, the sidebar toggle and Projects', JSON.stringify(stops))

  // Ctrl/Cmd+B toggles the sidebar between the 232 px column and the 56 px rail, and the choice survives a reload.
  const sideW = () => page.evaluate(() => Math.round(document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0))
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null))
  const wide = await sideW()
  await page.keyboard.press(`${mod}+b`)
  await sleep(400)
  const narrow = await sideW()
  check(Math.abs(wide - 232) <= 1 && Math.abs(narrow - 56) <= 1, 'Ctrl/Cmd+B collapses the sidebar to the rail', `${wide} -> ${narrow}`)
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  await sleep(600)
  check(Math.abs((await sideW()) - 56) <= 1, 'the collapsed sidebar persists across a reload', String(await sideW()))
  await page.keyboard.press(`${mod}+b`)
  await sleep(400)
  check(Math.abs((await sideW()) - 232) <= 1, 'Ctrl/Cmd+B expands the sidebar again', String(await sideW()))
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  await sleep(600)
  check(Math.abs((await sideW()) - 232) <= 1, 'the expanded sidebar persists across a reload')

  // The account row opens a popover with a way to App settings > Connections; Esc closes it and focus returns.
  await page.locator('[data-testid=auth-pill]').click()
  await page.locator('[data-testid=account-popover]').waitFor({ state: 'visible', timeout: 5000 })
  check((await page.locator('[data-testid=account-popover]').getByRole('button', { name: /Connections/ }).count()) === 1, 'account popover links to App settings Connections')
  await shot('account-popover')
  await page.keyboard.press('Escape')
  await sleep(200)
  check(!(await page.locator('[data-testid=account-popover]').isVisible()), 'Esc closes the account popover')
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'auth-pill'), 'focus returns to the account row')

  // Settings > Appearance: the theme switch flips data-theme on <html>, persists across a reload and reaches a second window.
  await openAppSettings(page)
  const appearance = page.locator('[data-testid=appearance-section]')
  await appearance.waitFor({ timeout: 10_000 })
  const themeGroup = appearance.getByRole('radiogroup', { name: 'Theme' })
  await themeGroup.locator('label.seg-item', { hasText: 'Light' }).click()
  await sleep(800)
  check((await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', 'Settings > Appearance Light flips data-theme to light')
  await shot('settings-appearance-light')
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  await sleep(600)
  check((await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', 'the chosen theme persists across a reload')
  const themeProj = await findProject(page, NAME)
  const themeRuns = await page.evaluate((id) => window.orgai.runs.list(id), themeProj.id)
  if (themeRuns.length) {
    await page.evaluate((t) => window.orgai.window.openRun(t), { projectId: themeProj.id, runId: themeRuns[0].id })
    let win2
    for (let i = 0; i < 30 && !win2; i++) {
      win2 = app.windows().find((w) => w !== page)
      if (!win2) await sleep(500)
    }
    check(!!win2, 'a second window opens for the theme check')
    if (win2) {
      await win2.waitForSelector('.sidebar, [data-testid=run-strip]', { timeout: 20_000 }).catch(() => {})
      await sleep(600)
      check((await win2.evaluate(() => document.documentElement.dataset.theme)) === 'light', 'the second window uses the saved light theme')
      await win2.close().catch(() => {})
    }
  }
  await openAppSettings(page)
  await appearance.waitFor({ timeout: 10_000 })
  await themeGroup.locator('label.seg-item', { hasText: 'Dark' }).click()
  await sleep(800)
  check((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', 'Settings > Appearance Dark flips data-theme back to dark')

  // New-idea mode, also token-free with setup skipped.
  const created = await createProject(page, { mode: 'new', path: path.join(base, 'new-idea-folder'), name: NEW_NAME, brief: 'A tiny todo app for layout testing.' })
  check(!!created, 'new-idea project created')
  check(created?.brief === 'A tiny todo app for layout testing.', 'new-idea brief stored')
  await shot('new-idea')
  check((await deleteProject(page, NEW_NAME)) === 0, 'new-idea project deleted')
  await shot('projects-after-delete')
} catch (e) {
  check(false, 'layout flow ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
  await deleteProject(page, NEW_NAME).catch(() => {})
} finally {
  await cleanup(app, page, NAME)
  removeFixture(base)
}
{
  const leftover = (() => { try { return fs.readdirSync(runRecordsDir()).filter((n) => !n.endsWith('.json')) } catch { return [] } })()
  log('run dirs without a record file:', leftover.length)
}
finish('e2e/layout')
