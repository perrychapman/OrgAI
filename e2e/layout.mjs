// Token-free. Creates projects in both form modes with "Skip AI setup", checks the live view's layout with a very
// long repository path (no horizontal page scroll, sidebar visible, empty state shown), screenshots, and deletes them.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, cleanup, endSession, openAppSettings, projectTab, teamPanelTab, runRecordsDir, createProject, deleteProject, findProject, finish, launch, log, makeFixtureRepo, openProject, removeFixture, sleep } from './lib.mjs'

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

  // ---- First launch setup steps (ui-overhaul Welcome); only on a data dir with no projects yet ----
  if (await page.locator('[data-testid=dash-start-choice]').isVisible().catch(() => false)) {
    await page.evaluate(() => localStorage.removeItem('orgai.welcome.done'))
    await page.reload()
    const setup = page.locator('[data-testid=welcome-setup]')
    await setup.waitFor({ timeout: 15_000 })
    check((await setup.getAttribute('data-stage')) === '1', 'W1 first launch opens on step 1 of the setup')
    check((await page.locator('.welcome-steps [aria-current=step]').count()) === 1, 'W1 exactly one step is current')
    const n1 = await page.locator('[data-testid=welcome-next], [data-testid=welcome-sign-in]').count()
    check(n1 === 1, 'W1 step 1 offers one primary action (Continue, or Sign in when the pick is not connected)')
    // Step 1 -> 2: continue (without signing in when nothing is connected; no IPC is spent on a mock).
    const anyway = page.locator('[data-testid=welcome-continue-anyway]')
    if (await anyway.isVisible().catch(() => false)) await anyway.click()
    else await page.locator('[data-testid=welcome-next]').click()
    await page.locator('[data-testid=welcome-setup][data-stage="2"]').waitFor({ timeout: 5000 })
    check(await page.evaluate(() => document.activeElement?.classList.contains('welcome-title') ?? false), 'W2 Continue moves focus to the new step heading')
    // Arrow keys move inside the radiogroup.
    await page.locator('[data-testid=welcome-option][data-value=code] input').focus()
    await page.keyboard.press('ArrowDown')
    check(await page.locator('[data-testid=welcome-option][data-value=engagement] input').isChecked(), 'W2 ArrowDown picks the next kind of work')
    await page.locator('[data-testid=welcome-next]').click()
    await page.locator('[data-testid=welcome-setup][data-stage="3"]').waitFor({ timeout: 5000 })
    check((await page.locator('[data-testid=welcome-option]').count()) === 3, 'W3 step 3 offers three ways to ask')
    // The preselected way is the app's own default for a new project; only that one says Recommended; one name per mode.
    const appDefault = await page.evaluate(async () => (await window.orgai.settings.get()).defaultPermissionMode)
    await page.locator('[data-testid=welcome-option] input:checked').waitFor({ timeout: 5000 })
    const checkedMode = await page.locator('[data-testid=welcome-option]:has(input:checked)').getAttribute('data-value')
    check(checkedMode === appDefault, 'W3 step 3 preselects the app default permission mode', `${checkedMode} vs ${appDefault}`)
    const recommended = await page.locator('[data-testid=welcome-option]:has(.welcome-option-badge[data-kind=recommended])').evaluateAll((els) => els.map((e) => e.getAttribute('data-value')))
    check(recommended.length === 1 && recommended[0] === appDefault, 'W3 only the default is marked Recommended', recommended.join(','))
    const askTitles = await page.locator('[data-testid=welcome-option] .welcome-option-title').allInnerTexts()
    check(askTitles.some((t) => t.startsWith('Ask before risky actions')) && askTitles.some((t) => t.startsWith('Go ahead within the rules')) && !askTitles.some((t) => /Ask about everything|Unattended/.test(t)), 'W3 step 3 uses the one name set', askTitles.join(' | '))
    // At the smallest supported window the step's buttons are fully inside the viewport (sticky footer).
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 640))
    await sleep(300)
    for (const tid of ['welcome-back', 'welcome-next']) {
      const box = await page.locator(`[data-testid=${tid}]`).boundingBox()
      const vh = await page.evaluate(() => window.innerHeight)
      check(!!box && box.y >= 0 && box.y + box.height <= vh + 0.5, `W3 ${tid} is fully visible at 1024x640`, JSON.stringify({ box, vh }))
    }
    await shot('welcome-step3-1024')
    await page.locator('[data-testid=welcome-back]').click()
    check((await page.locator('[data-testid=welcome-setup]').getAttribute('data-stage')) === '2', 'W3 Back returns to step 2')
    await page.locator('[data-testid=welcome-skip]').click()
    await page.locator('[data-testid=dash-start-choice]').waitFor({ timeout: 5000 })
    check(await page.locator('[data-testid=project-kind-option][data-kind=engagement] input').isChecked(), 'W4 Skip setup lands on the start choice with the picked kind preselected')
    check(await page.evaluate(() => localStorage.getItem('orgai.welcome.done') === '1'), 'W4 skipping is remembered')
    await shot('welcome-start')
  }

  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'existing-repo project created')
  check(project?.setup === undefined, 'skip AI setup leaves no setup record')
  check(project?.roles?.length === 4, 'default org chart has 4 roles', String(project?.roles?.length))
  check((await page.locator('.editor').count()) > 0, 'lands on the Team tab after create')
  check((await page.locator('[data-testid=tab-team]').getAttribute('aria-selected')) === 'true', 'the Team tab is selected after create')
  check((await teamPanelTab(page, 'Role').count()) === 1 && (await teamPanelTab(page, 'Catalog').count()) === 1, 'the side panel has Role and Catalog tabs')
  check((await teamPanelTab(page, 'Catalog').getAttribute('aria-selected')) === 'true', 'Catalog is selected while no role is selected')
  check((await page.locator('.editor .frame-tray [data-testid=team-recommend]').count()) === 1, 'the Team assistant tray opens on Recommend')
  check((await page.locator('.role-node [data-testid=role-node-caps]').count()) === 4, 'every role node shows its capability line')
  await page.locator('.react-flow__node').first().click()
  await sleep(300)
  check((await teamPanelTab(page, 'Role').getAttribute('aria-selected')) === 'true', 'selecting a role switches the panel to Role')
  check((await page.locator('[data-testid=role-capabilities]').count()) === 1, 'the Role pane has the What it can use block')
  // The Architect is reached from Start from (docs/design/team-tab-overhaul.md 1.3), not from the tray. The menu and its
  // dialog are another engineer's component: the step runs when the menu is mounted.
  const startFrom = page.locator('[data-testid=team-start-from]')
  check((await startFrom.count()) === 1, 'the Start from menu is in the header')
  if ((await startFrom.count()) === 1) {
    await startFrom.click()
    await page.locator('[data-testid=start-from-architect]').click()
    // The tray's Design pane still holds the same form until phase 3: scope to the dialog.
    await page.locator('[data-testid=architect-dialog] [data-testid=org-change-start]').waitFor({ state: 'visible', timeout: 5000 })
    check((await page.locator('[data-testid=role-capabilities]').count()) === 1, 'the Architect dialog does not replace the role inspector')
    await shot('team-architect')
    await page.keyboard.press('Escape')
    await sleep(300)
    check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'team-start-from'), 'closing the Architect dialog returns focus to Start from')
  } else log('Start from is not mounted yet: the Architect step was skipped')
  await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } })
  await shot('editor')

  // The Team header: one row, no overlap, no hint sentence, the notice row reserves its 32 px and the stage never moves
  // (docs/design/team-tab-overhaul.md 1.1, 1.5 and 1.10). Both window sizes, both themes.
  const frameSlots = ['.frame-toolbar', '.frame-stage', '.frame-tray', '.frame-footer']
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
    await sleep(500)
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await sleep(300)
      const tag = `${w}x${h} ${theme}`
      const m = await page.evaluate((slots) => {
        const box = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom } }
        const header = document.querySelector('.editor [data-testid=team-header]')
        const parts = header ? [...header.querySelectorAll('[data-testid=team-title], [data-testid=team-role-count], [data-testid=team-problems-chip], [data-testid=team-layout], [data-testid=team-start-from], [data-testid=team-files-chip], [data-testid=team-add-role]')].filter((el) => el.getClientRects().length > 0).map((el) => ({ id: el.getAttribute('data-testid'), ...box(el) })) : []
        const primary = [...document.querySelectorAll('.editor .frame-toolbar .btn.primary')].filter((el) => el.getClientRects().length > 0 && !el.closest('[popover], dialog')).length
        return {
          header: header && box(header),
          parts,
          primary,
          slots: Object.fromEntries(slots.map((s) => [s, document.querySelectorAll(s).length])),
          stage: box(document.querySelector('.frame-stage')),
          footer: box(document.querySelector('.frame-footer')),
          footerText: document.querySelector('.frame-footer')?.textContent ?? '',
          iw: window.innerWidth,
          sw: document.documentElement.scrollWidth
        }
      }, frameSlots)
      check(!!m.header && m.parts.length >= 4, `the Team header shows its controls at ${tag}`, JSON.stringify(m.parts.map((p) => p.id)))
      const row = m.parts.length > 0 && Math.max(...m.parts.map((p) => (p.t + p.b) / 2)) - Math.min(...m.parts.map((p) => (p.t + p.b) / 2)) <= 4
      check(row, `the Team header is one row at ${tag}`, JSON.stringify(m.parts))
      const overlap = m.parts.some((p, i) => m.parts.some((q, j) => j > i && p.l < q.r - 0.5 && q.l < p.r - 0.5 && p.t < q.b - 0.5 && q.t < p.b - 0.5))
      check(!overlap, `no two Team header controls overlap at ${tag}`, JSON.stringify(m.parts))
      check(m.parts.every((p) => p.l >= m.header.l - 0.5 && p.r <= m.header.r + 0.5), `the Team header controls stay inside the header at ${tag}`, JSON.stringify([m.header, m.parts]))
      check(m.primary === 1, `the header has exactly one primary button (Add role) at ${tag}`, String(m.primary))
      check(Object.values(m.slots).every((n) => n === 1), `the frame slots toolbar, stage, tray and footer exist at ${tag}`, JSON.stringify(m.slots))
      check(Math.abs(m.footer.b - m.footer.t - 32) <= 1.5, `the notice row is 32 px high at ${tag}`, JSON.stringify(m.footer))
      check(!/Drag from a node|Shift\+F10/.test(m.footerText), `the footer hint sentence is gone at ${tag}`, m.footerText)
      check((await page.locator('[data-testid=team-title]').innerText()) === 'Team' && /^\d+ roles?$/.test(await page.locator('[data-testid=team-role-count]').innerText()), `the Team title and role count show at ${tag}`)
      check(m.sw <= m.iw, `the Team tab has no horizontal page scroll at ${tag}`)
      await shot(`team-header-${w}x${h}-${theme}`)
    }
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  {
    // Adding a role posts a notice with Undo: the stage's top and bottom edges are the same before, during and after.
    const stageEdges = () => page.evaluate(() => { const b = document.querySelector('.frame-stage').getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom)] })
    await page.locator('[data-testid=team-hint-dismiss]').click().catch(() => {})
    await sleep(300)
    const still = await stageEdges()
    await page.locator('[data-testid=team-add-role]').click()
    await page.locator('[data-testid=add-role-popover]').waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('[data-testid=add-role-submit]').click()
    await page.locator('[data-testid=team-notice-undo]').waitFor({ timeout: 5000 })
    check(/^Added New role under /.test(await page.locator('[data-testid=team-notice-row]').innerText()), 'adding a role says "Added {name} under {Parent}." in the notice row')
    check(JSON.stringify(await stageEdges()) === JSON.stringify(still), 'the stage top and bottom do not move when a notice appears', JSON.stringify([still, await stageEdges()]))
    await page.locator('[data-testid=team-notice-undo]').click()
    await sleep(500)
    check((await page.locator('.react-flow__node').count()) === 4, 'Undo takes the added role out again')
    check(JSON.stringify(await stageEdges()) === JSON.stringify(still), 'the stage top and bottom do not move when the notice clears', JSON.stringify([still, await stageEdges()]))
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
  await sleep(400)

  await projectTab(page, 'Live').click()
  await sleep(800)
  const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
  check(overflow.sw <= overflow.cw, 'live view has no horizontal page scroll', `${overflow.sw}/${overflow.cw}`)
  check(await page.locator('.sidebar').isVisible(), 'sidebar stays visible with a long path')
  const pillBox = await page.locator('[data-testid=project-folder]').boundingBox()
  const vw = await page.evaluate(() => window.innerWidth)
  check(!!pillBox && pillBox.x + pillBox.width <= vw, 'folder name fits in the window', JSON.stringify(pillBox))
  const heading = await page.locator('.new-run h2').first().innerText({ timeout: 5000 }).catch(() => '')
  check(/something to do|What should the team do/i.test(heading), 'empty state invites a first task', heading)
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
    const comp = document.querySelector('.composer')
    // The two-column New run page lays the composer out with display: contents (its field is the card, its aside is the
    // second column): then the field is the box that must stay inside the window.
    const c = getComputedStyle(comp).display === 'contents' ? { left: 0, right: window.innerWidth } : comp?.getBoundingClientRect()
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
        return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, iw: window.innerWidth, ih: window.innerHeight, tabs: r('.run-tabs'), strip: r('[data-testid=run-strip]'), toolbar: r('.frame-toolbar'), stage: r('.frame-stage'), frame: r('.canvas-frame'), topbar: r('main .topbar'), composer: r('.composer'), side: document.querySelector('.side-panel')?.getAttribute('data-collapsed'), panels: document.querySelectorAll('.run-body > .side-panel').length, layout: document.querySelector('.run-body')?.getAttribute('data-layout'), flag: document.querySelector('.run-body')?.getAttribute('data-side-panel') }
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
      // package.json carries a -dev version on dev branches, so the badge is expected there; a release version has none.
      const pkgVersion = JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
      const wantDev = /^\d+\.\d+\.\d+-.*dev/i.test(pkgVersion)
      const devBadge = page.locator('[data-testid=dev-build-badge]')
      check((await devBadge.count()) === (wantDev ? 1 : 0), `dev build badge ${wantDev ? 'shows' : 'is absent'} for version ${pkgVersion} at ${w}x${h} ${theme}`)
      if (wantDev) {
        const bb = await devBadge.boundingBox()
        const sb = await page.locator('.sidebar').boundingBox()
        const label = w < 1180 ? await page.locator('.brand-lockup-expand').getAttribute('aria-label') : await page.locator('.brand-lockup-devtag').getAttribute('aria-label')
        check(!!bb && !!sb && bb.x >= sb.x && bb.x + bb.width <= sb.x + sb.width + 0.5, `dev badge sits inside the sidebar at ${w}x${h} ${theme}`, JSON.stringify({ bb, sb }))
        check(String(label).includes(`Dev build ${pkgVersion}`), `dev badge label names the version at ${w}x${h} ${theme}`, String(label))
      }
      check((await page.locator('main .topbar .badge').count()) === 0, `no status badge in the topbar on Live at ${w}x${h} ${theme}`)
      check(m.sw <= m.cw, `no horizontal scroll with runs at ${w}x${h} ${theme}`, JSON.stringify(m))
      check(inside(m.tabs), `run tabs inside viewport at ${w}x${h} ${theme}`, JSON.stringify(m.tabs))
      check(inside(m.strip), `run strip inside viewport at ${w}x${h} ${theme}`, JSON.stringify(m.strip))
      check(inside(m.composer), `composer with mode row inside viewport at ${w}x${h} ${theme}`, JSON.stringify(m.composer))
      check(!!m.strip && !!m.topbar && m.strip.t >= m.topbar.b - 0.5 && Math.abs(m.strip.b - m.strip.t - 40) <= 1.5, `run strip is 40 px and sits under the topbar at ${w}x${h} ${theme}`, JSON.stringify([m.topbar, m.strip]))
      check(!!m.toolbar && !!m.strip && m.toolbar.t >= m.strip.b - 0.5 && Math.abs(m.toolbar.b - m.toolbar.t - 32) <= 1.5, `canvas toolbar is 32 px and sits under the strip at ${w}x${h} ${theme}`, JSON.stringify([m.strip, m.toolbar]))
      check(!!m.tabs && !!m.strip && m.tabs.l >= m.strip.l - 0.5 && m.tabs.r <= m.strip.r + 0.5, `run tabs live inside the strip at ${w}x${h} ${theme}`, JSON.stringify([m.strip, m.tabs]))
      check(!!m.stage && !!m.toolbar && m.stage.t >= m.toolbar.b - 0.5, `stage sits under the toolbar at ${w}x${h} ${theme}`, JSON.stringify([m.toolbar, m.stage]))
      // A run in the conversation layout (an ended run opened under 1100 px) has no panel at all; on the canvas it starts collapsed.
      check(m.layout === 'conversation' ? m.panels === 0 && m.flag === 'none' : w >= 1100 || m.side === 'true', `run panel starts collapsed below 1100 px of main width (none in the conversation layout) at ${w}x${h} ${theme}`, JSON.stringify([m.layout, m.panels, m.flag, m.side]))
      check((await page.locator('.react-flow__controls').count()) === 0, `React Flow controls are gone from the canvas at ${w}x${h} ${theme}`)
      check((await page.locator('[data-testid=run-strip] .btn:visible').first().evaluate((el) => el.getBoundingClientRect().height).catch(() => 28)) <= 36, `strip buttons fit the 40 px strip at ${w}x${h} ${theme}`)
      log(`chrome above canvas at ${w}x${h} ${theme}:`, m.stage ? Math.round(m.stage.t) : '?', 'px; stage', m.stage ? `${Math.round(m.stage.r - m.stage.l)}x${Math.round(m.stage.b - m.stage.t)}` : '?')
      // The legend lives behind the toolbar "?" popover: a shape plus a word per state.
      // An ended single-agent run opens as the conversation under 1100 px; the legend belongs to the agents layout.
      if ((await page.locator('[data-testid=canvas-legend-trigger]').count()) === 0) await page.locator('[data-testid=run-layout-toggle]').click()
      const legendBtn = page.locator('[data-testid=canvas-legend-trigger]')
      await legendBtn.click()
      await sleep(250)
      const legendText = ((await page.locator('[data-testid=canvas-legend]').innerText().catch(() => '')) || '').toLowerCase()
      check(
        ['working', 'needs you', 'finished', 'failed', 'selected', 'folded', 'reporting line', 'message'].every((t) => legendText.includes(t)),
        `legend popover lists all eight entries at ${w}x${h} ${theme}`,
        legendText.replace(/\s+/g, ' ')
      )
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

  // Keyboard order: skip to content, skip to sidebar, the sidebar toggle, then Search or jump to.
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
  check(stops[0] === 'Skip to content' && stops[1] === 'Skip to sidebar' && /sidebar/i.test(stops[2]) && /Search or jump to/.test(stops[3]), 'first Tab stops are the two skip links, the sidebar toggle and Search or jump to', JSON.stringify(stops))
  await page.keyboard.press('Tab')
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'nav-home'), 'the next Tab stop is Home')
  await page.keyboard.press('Tab')
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'nav-inbox'), 'then Inbox')

  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

  // The top nav group: Home, Inbox, Chat; Inbox navigates and Home returns. The sidebar rows keep their testids.
  await page.locator('[data-testid=nav-inbox]').click()
  await sleep(400)
  check((await page.locator('[data-testid=nav-inbox]').getAttribute('aria-current')) === 'page' && (await page.title()) === 'Inbox · OrgAI', 'the Inbox row opens the Inbox and is the current page', await page.title())
  check((await page.locator('[data-testid=nav-home]').getAttribute('aria-current')) === null && (await page.locator('[data-testid=nav-project][data-name="' + NAME + '"][aria-current=page]').count()) === 0, 'on Inbox neither Home nor a project row is current')
  check((await page.locator('[data-testid=needs-you-row]').count()) === 0, 'no Needs-you bell while nothing waits')
  await page.locator('[data-testid=nav-home]').click()
  await page.waitForSelector('[data-testid=dashboard]', { timeout: 10_000 })
  check((await page.locator('[data-testid=nav-home]').innerText()).trim() === 'Home', 'the Home row reads "Home"')
  check((await page.locator('[data-testid=nav-assistant][data-id=quick]').innerText()).includes('Chat') && (await page.locator('.sidebar-assistants [data-testid=nav-assistant]').count()) === 2, 'Chat leads the nav group and two helpers sit in their own group')
  check((await page.getByRole('button', { name: 'New project or engagement', exact: true }).count()) === 1, 'the Projects heading has its New project or engagement button')
  await page.getByRole('button', { name: 'New project or engagement', exact: true }).click()
  await page.locator('[data-testid=new-project-dialog], [data-testid=new-project-form]').first().waitFor({ timeout: 10_000 }).catch(() => {})
  check((await page.locator('[data-testid=new-project-dialog], form.card').count()) >= 1, 'the + button opens the new-project form')
  await page.keyboard.press('Escape')
  await sleep(400)

  // Command palette: Ctrl/Cmd+K and the sidebar button open one dialog with a combobox over a listbox.
  const paletteBox = () => page.locator('[data-testid=command-palette]')
  const input = page.locator('[data-testid=command-palette-input]')
  const activeOption = () => page.evaluate(() => {
    const i = document.querySelector('[data-testid=command-palette-input]')
    const id = i?.getAttribute('aria-activedescendant')
    const o = id ? document.getElementById(id) : null
    return { id, selected: o?.getAttribute('aria-selected'), text: o?.textContent ?? '' }
  })
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null))
  await page.keyboard.press(`${mod}+k`)
  await input.waitFor({ state: 'visible', timeout: 5000 })
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'command-palette-input'), 'Ctrl/Cmd+K opens the palette with focus in the search field')
  check((await input.getAttribute('role')) === 'combobox' && (await input.getAttribute('aria-controls')) !== null && (await page.locator('[role=listbox] [role=option]').count()) >= 5, 'the field is a combobox over a listbox with options')
  const first = await activeOption()
  check(first.selected === 'true' && !!first.text, 'the first option is the active descendant', JSON.stringify(first))
  await page.keyboard.press('ArrowDown')
  const second = await activeOption()
  check(second.id !== first.id && second.selected === 'true', 'ArrowDown moves the active option', JSON.stringify([first, second]))
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  check((await activeOption()).id !== first.id, 'ArrowUp from the first option wraps to the last')
  const texts = await page.locator('[role=option]').allInnerTexts()
  check(['Home', 'Inbox', 'Chat', 'Usage', 'Schedules', 'App settings', 'New project or engagement', 'New chat'].every((t) => texts.some((x) => x.includes(t))), 'the palette lists the app destinations and both create actions', texts.join(' | ').replace(/\s+/g, ' ').slice(0, 300))
  check(texts.some((x) => x.includes(NAME)), 'the palette lists the project', texts.length + ' options')
  await shot('palette-open')
  await page.keyboard.type('usag')
  await sleep(150)
  check((await activeOption()).text.includes('Usage'), 'typing ranks the match first', JSON.stringify(await activeOption()))
  await page.keyboard.press('Enter')
  await sleep(500)
  check(!(await paletteBox().evaluate((el) => el.open)) && (await page.locator('[data-testid=nav-usage]').getAttribute('aria-current')) === 'page', 'Enter on Usage closes the palette and opens Usage')
  // A project by name, then the empty state, then Esc and focus return to the button that opened it.
  await page.keyboard.press(`${mod}+k`)
  await input.waitFor({ state: 'visible', timeout: 5000 })
  await page.keyboard.type('e2e layout')
  await sleep(150)
  check((await activeOption()).text.includes(NAME), 'typing a project name puts it first', JSON.stringify(await activeOption()))
  await page.keyboard.press('Enter')
  await sleep(800)
  check((await page.locator('[data-testid=nav-project][data-name="' + NAME + '"]').getAttribute('aria-current')) === 'page', 'Enter on a project opens it')
  await page.locator('[data-testid=sidebar-search]').click()
  await input.waitFor({ state: 'visible', timeout: 5000 })
  await page.keyboard.type('zzzzqqqq')
  await sleep(150)
  check(/No results for "zzzzqqqq"/.test(await page.locator('[data-testid=command-palette-empty]').innerText().catch(() => '')), 'a query with no match shows No results for "x"')
  check((await page.locator('[role=option]').count()) === 0 && (await input.getAttribute('aria-activedescendant')) === null, 'no option and no active descendant while empty')
  await page.keyboard.press('Escape')
  await sleep(400)
  check(!(await paletteBox().evaluate((el) => el.open)), 'Esc closes the palette')
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'sidebar-search'), 'focus returns to the Search or jump to button')
  // Both themes: the dialog sits inside the window.
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await sleep(200)
    await page.keyboard.press(`${mod}+k`)
    await input.waitFor({ state: 'visible', timeout: 5000 })
    await sleep(300)
    const pb = await paletteBox().boundingBox()
    const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    check(!!pb && pb.x >= 0 && pb.y >= 0 && pb.x + pb.width <= vp.w && pb.y + pb.height <= vp.h, `the palette sits inside the window in ${theme}`, JSON.stringify([pb, vp]))
    await shot(`palette-${theme}`)
    await page.keyboard.press(`${mod}+k`)
    await sleep(300)
    check(!(await paletteBox().evaluate((el) => el.open)), `Ctrl/Cmd+K again closes the palette in ${theme}`)
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))

  // Ctrl/Cmd+B toggles the sidebar between the 232 px column and the 56 px rail, and the choice survives a reload.
  const sideW = () => page.evaluate(() => Math.round(document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0))
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

  // Drag handles: the sidebar handle resizes by mouse drag and by arrow key, survives a reload, and double-click resets.
  const sbHandle = page.locator('[data-testid=sidebar-resize]')
  const hb = await sbHandle.boundingBox()
  if (hb) {
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb.x + hb.width / 2 + 60, hb.y + hb.height / 2, { steps: 5 })
    await page.mouse.up()
  }
  const dragged = await sideW()
  check(Math.abs(dragged - 292) <= 2, 'dragging the sidebar handle widens the sidebar', String(dragged))
  check((await sbHandle.getAttribute('aria-valuenow')) === String(dragged), 'sidebar handle reports its width (aria-valuenow)')
  await sbHandle.focus()
  await page.keyboard.press('ArrowLeft')
  await sleep(100)
  check(Math.abs((await sideW()) - (dragged - 16)) <= 1, 'ArrowLeft narrows the sidebar by 16 px', String(await sideW()))
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  await sleep(600)
  check(Math.abs((await sideW()) - (dragged - 16)) <= 1, 'the dragged sidebar width persists across a reload', String(await sideW()))
  await page.locator('[data-testid=sidebar-resize]').dblclick()
  await sleep(200)
  check(Math.abs((await sideW()) - 232) <= 1, 'double-clicking the sidebar handle resets the width', String(await sideW()))
  // The side panel handle (when the live view shows the run panel).
  const spHandle = page.locator('[data-testid=side-panel-resize]').first()
  await openProject(page, NAME)
  await projectTab(page, 'Team').click()
  await sleep(600)
  log('side panel handles:', await spHandle.count())
  if (await spHandle.count()) {
    const panelW = () => page.evaluate(() => Math.round(document.querySelector('.side-panel')?.getBoundingClientRect().width ?? 0))
    const before = await panelW()
    await spHandle.focus()
    await page.keyboard.press('ArrowLeft')
    await sleep(150)
    check((await panelW()) - before >= 15, 'ArrowLeft widens the side panel by 16 px', `${before} -> ${await panelW()}`)
    await spHandle.dblclick()
    await sleep(150)
    check(Math.abs((await panelW()) - before) <= 1, 'double-clicking the side panel handle restores the default', `${before} -> ${await panelW()}`)
  }

  // The account row opens a popover with a way to App settings > Connections; Esc closes it and focus returns.
  await page.locator('[data-testid=auth-pill]').click()
  await page.locator('[data-testid=account-popover]').waitFor({ state: 'visible', timeout: 5000 })
  check((await page.locator('[data-testid=account-popover]').getByRole('button', { name: /Connections/ }).count()) === 1, 'account popover links to App settings Connections')
  check((await page.locator('[data-testid=account-popover]').getByRole('button', { name: /refresh/i }).count()) === 0 && !/Updated/.test(await page.locator('[data-testid=account-popover]').innerText()), 'account popover has no Refresh button or Updated text')
  await shot('account-popover')
  await page.keyboard.press('Escape')
  await sleep(200)
  check(!(await page.locator('[data-testid=account-popover]').isVisible()), 'Esc closes the account popover')
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'auth-pill'), 'focus returns to the account row')

  // Settings > Appearance: the theme switch flips data-theme on <html>, persists across a reload and reaches a second window.
  await openAppSettings(page)
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click()
  const appearance = page.locator('[data-testid=appearance-section]')
  await appearance.waitFor({ timeout: 10_000 })
  const themeGroup = appearance.getByRole('radiogroup', { name: 'Colour mode' })
  await themeGroup.getByRole('radio', { name: 'Light', exact: true }).check()
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
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click()
  await appearance.waitFor({ timeout: 10_000 })
  await themeGroup.getByRole('radio', { name: /^Dark\b/ }).check()
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
