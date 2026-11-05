// Free e2e for folder config trust. ORGAI_MOCK=1: the mock clones mock-org/with-agents (ships .claude/settings.json allowing
// Bash(npm test:*) plus .mcp.json) and its [mock:folder-config] script says whether the folder's config loaded, then runs
// Bash `npm test` (asks while ignored). Covers the New run notice, the review dialog (both sizes and themes), Accept,
// Revoke, the stale-digest path, the 'changed' state, the "Not used" ignored-rules group and the keyboard path.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DATA_DIR, TMP, check, finish, findProject, gotoProjects, launch, openProjectForm, projectTab, runRecordsDir, screenshot, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
delete process.env.ORGAI_MOCK_GH
delete process.env.ORGAI_MOCK_GIT
delete process.env.ORGAI_MOCK_SCRIPT

const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-trust-'))
const FOLDER = 'trust-repo'
const repoDir = path.join(base, FOLDER)
const settingsFile = path.join(repoDir, '.claude', 'settings.json')
const { app, page } = await launch({ shotPrefix: 'folder-trust' })
page.setDefaultTimeout(10_000)

const tid = (id) => page.locator(`[data-testid=${id}]`)
const textOf = async (id) => ((await tid(id).count()) ? ((await tid(id).first().innerText()) ?? '').trim() : '')
const activeTestId = () => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.closest('[data-testid]')?.getAttribute('data-testid') ?? null)

async function size(w, h, theme) {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await page.waitForFunction((cw) => Math.abs(window.innerWidth - cw) <= 1, w, { timeout: 10_000 }).catch(() => {})
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
  await sleep(200)
}

const CARD = 'section.frame-tray article.decision-card[data-kind="permission"]'
const newRunPage = async () => {
  await projectTab(page, 'Live').click()
  if (!(await page.locator('.new-run').count())) {
    await page.keyboard.press('Control+t')
    await page.locator('.new-run').waitFor()
  }
}
/** Start a run from the New run page and return once its first reply is on screen. */
const startRun = async (text) => {
  await newRunPage()
  const ta = page.locator('.composer textarea')
  await ta.waitFor()
  await ta.fill(text)
  await page.locator('.composer .btn.primary').click()
}
const endRun = async () => {
  const end = page.getByRole('button', { name: 'End session' })
  if (await end.count()) {
    await end.first().click().catch(() => {})
    await sleep(1200)
  }
}
// The transcript is not always on screen (side panel collapsed), so read what the newest run saved.
const pageHas = async (text, timeout = 20_000) => {
  const dir = runRecordsDir()
  const end = Date.now() + timeout
  while (Date.now() < end) {
    try {
      const files = fs.readdirSync(dir).map((f) => path.join(dir, f))
      files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      if (files[0] && fs.readFileSync(files[0], 'utf8').includes(text)) return true
    } catch {
      /* not written yet */
    }
    await sleep(300)
  }
  return false
}
const openPermissionsPane = async () => {
  await projectTab(page, 'Settings').click()
  await page.getByRole('tab', { name: 'Permissions', exact: true }).click()
  await page.locator('#settings-section-permissions').waitFor()
}
const openReview = async () => {
  await openPermissionsPane()
  await tid('folder-trust-review-open').click()
  await tid('folder-trust-dialog').waitFor({ state: 'visible' })
  await tid('folder-trust-accept').or(tid('folder-trust-revoke')).waitFor()
}
const closeReview = async () => {
  await page.keyboard.press('Escape')
  await tid('folder-trust-dialog').waitFor({ state: 'hidden' })
}
const statusState = async () => (await tid('folder-trust-status').getAttribute('data-state')) ?? ''

/** No page scroll; the dialog sits inside the window and its body scrolls itself. */
async function dialogFits(label) {
  const r = await page.evaluate(() => {
    const d = document.querySelector('[data-testid=folder-trust-dialog]')
    const b = d?.getBoundingClientRect()
    return {
      pageScroll: document.documentElement.scrollHeight - window.innerHeight,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      top: b?.top ?? -1,
      bottom: b?.bottom ?? -1,
      left: b?.left ?? -1,
      right: b?.right ?? -1,
      h: window.innerHeight,
      w: window.innerWidth
    }
  })
  check(r.pageScroll <= 0 && r.overflowX <= 0, `${label}: no page scroll`, JSON.stringify(r))
  check(r.top >= 0 && r.bottom <= r.h && r.left >= 0 && r.right <= r.w, `${label}: dialog inside the window`, JSON.stringify(r))
}

try {
  await size(1024, 640, 'dark')

  // ---- Clone and create ----
  await gotoProjects(page)
  const form = await openProjectForm(page)
  await form.locator('[data-testid=project-kind-option][data-kind=code] input[type=radio]').check({ force: true })
  await form.getByRole('radio', { name: 'From GitHub', exact: true }).check({ force: true })
  await tid('repo-source').fill('mock-org/with-agents')
  await tid('repo-parent').fill(base)
  await tid('repo-folder').fill(FOLDER)
  await sleep(600)
  await tid('repo-clone').click()
  await tid('repo-cloned-line').waitFor({ timeout: 30_000 })
  const cfg = await textOf('repo-config-line')
  check(/until you allow them in the project's Settings/.test(cfg), 'clone form: agents will not use these settings until allowed', cfg)
  await tid('setup-choice').waitFor()
  await form.locator('[data-testid=setup-choice] input[value=default]').check({ force: true })
  const mock = tid('use-mock')
  if ((await mock.count()) && !(await mock.isChecked())) await form.locator('label.checkbox', { hasText: 'Use the mock adapter' }).click()
  await tid('new-project-submit').click()
  await page.waitForSelector('[data-testid=dashboard]', { state: 'detached', timeout: 60_000 })
  const project = await findProject(page, FOLDER)
  check(!!project && path.resolve(project.path) === path.resolve(repoDir), 'project created on the clone', String(project?.path))
  check(project?.folderConfigTrust?.state === 'untrusted', 'project is gated and untrusted', JSON.stringify(project?.folderConfigTrust))

  // ---- M2: a findable pointer in the topbar on every view, not only the New run page ----
  for (const [w, h, theme] of [
    [1024, 640, 'dark'],
    [1024, 640, 'light'],
    [1600, 1000, 'dark']
  ]) {
    const tag = `${w}x${h} ${theme}`
    await size(w, h, theme)
    for (const tab of ['Team', 'History', 'Settings', 'Live']) {
      await projectTab(page, tab).click()
      await tid('topbar-folder-trust').waitFor({ timeout: 15_000 })
      const r = await page.evaluate(() => {
        const el = document.querySelector('[data-testid=topbar-folder-trust]')
        const b = el?.getBoundingClientRect()
        const top = b ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) : null
        const bar = document.querySelector('.project-topbar')
        return { inView: !!b && b.left >= 0 && b.right <= window.innerWidth && b.top >= 0 && b.bottom <= window.innerHeight, topmost: !!el && !!top && el.contains(top), barOverflow: bar ? bar.scrollWidth - bar.clientWidth : 0 }
      })
      check(r.inView && r.topmost && r.barOverflow <= 0, `${tag} ${tab}: topbar pointer is in view, topmost, and the bar does not overflow`, JSON.stringify(r))
    }
  }
  await size(1024, 640, 'dark')
  await projectTab(page, 'Team').click()
  check((await textOf('topbar-folder-trust')).includes('Folder settings ignored'), 'topbar pointer names the state', await textOf('topbar-folder-trust'))
  await tid('topbar-folder-trust').focus()
  await page.keyboard.press('Enter')
  await tid('folder-trust-dialog').waitFor({ state: 'visible', timeout: 10_000 })
  check(true, 'topbar pointer opens the review (keyboard)')
  await closeReview()

  // ---- Notice and dialog at both sizes and themes ----
  for (const [w, h, theme] of [
    [1024, 640, 'dark'],
    [1024, 640, 'light'],
    [1600, 1000, 'dark'],
    [1600, 1000, 'light']
  ]) {
    const tag = `${w}x${h} ${theme}`
    await size(w, h, theme)
    await newRunPage()
    await tid('folder-trust-notice').waitFor()
    const noticeText = await textOf('folder-trust-notice')
    check(noticeText.includes('came with its own agent settings') && noticeText.includes('Agents ignore them until you review and allow them'), `${tag}: notice says why agents ignore the settings and what Allow does`, noticeText)
    check(/\(\d+ [a-z ,0-9]+\)/.test(noticeText), `${tag}: notice counts what the folder holds`, noticeText)
    const nb = await tid('folder-trust-notice').boundingBox()
    check(!!nb && nb.y >= 0 && nb.y + nb.height <= h, `${tag}: notice in view`, JSON.stringify(nb))
    await screenshot(page, `folder-trust-${w}-${theme}-notice`)
    await tid('folder-trust-notice-review').click()
    await tid('folder-trust-dialog').waitFor({ state: 'visible' })
    await tid('folder-trust-accept').waitFor()
    await sleep(300)
    check((await textOf('folder-trust-dialog-status')).includes('ignore'), `${tag}: dialog states the state`)
    await dialogFits(`${tag} dialog`)
    // M1: every section says in one line what it is; files read in plain words; one text toggle, no per-file stops.
    const dlg = tid('folder-trust-dialog')
    const nSections = await dlg.locator('section.trust-section').count()
    check(nSections > 0 && (await dlg.locator('[data-testid=folder-trust-section-summary]').count()) === nSections, `${tag}: each section has its one-line summary`, `${nSections}`)
    const dtext = await dlg.innerText()
    check(!/Checked for changes|Not checked/.test(dtext), `${tag}: no "Checked for changes" / "Not checked" jargon`)
    check(dtext.includes('Allow covers this file; a change asks again') || dtext.includes("Instructions only; changes don't ask again"), `${tag}: files say what a change does`)
    check(dtext.includes('Permission rules it would add'), `${tag}: before Allow the title says "would add"`)
    check((await dlg.getByRole('button', { name: /^Show text/ }).count()) === 0, `${tag}: no per-file Show text stops`)
    check((await tid('folder-trust-text-toggle').count()) === 1, `${tag}: one Show all text toggle`)
    await screenshot(page, `folder-trust-${w}-${theme}-dialog`)
    await closeReview()
  }

  // ---- Keyboard: Review opens with Enter, Esc returns focus, Tab reaches the dialog's buttons ----
  await size(1024, 640, 'dark')
  await openPermissionsPane()
  check((await statusState()) === 'untrusted', 'settings status is untrusted')
  {
    // M1 / M5: one line why and what Allow does; the rules row has no doubled period and no appended trust sentence.
    const row = await textOf('folder-trust-status')
    check(row.includes('ignore') && row.includes('Allow lets agents use them from the next run'), 'settings row says why and what Allow does', row)
    const sum = await textOf('permissions-summary')
    check(!sum.includes('..') && !sum.includes('not allowed yet'), 'rules summary has no doubled period or trust sentence', sum)
  }
  await tid('folder-trust-review-open').focus()
  check((await activeTestId()) === 'folder-trust-review-open', 'Review is focusable')
  await page.keyboard.press('Enter')
  await tid('folder-trust-dialog').waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  await tid('folder-trust-dialog').waitFor({ state: 'hidden' })
  check((await activeTestId()) === 'folder-trust-review-open', 'Esc returns focus to the opener', String(await activeTestId()))

  // ---- First run: ignored, asks ----
  await startRun('[mock:folder-config] run the tests')
  check(await pageHas('Folder config ignored.'), 'run 1 says the folder config is ignored')
  await page.locator(CARD).first().waitFor({ timeout: 20_000 })
  check(true, 'run 1: npm test shows a permission card')
  {
    // M2: the card says the folder's own settings are ignored and links to the review.
    const line = page.locator(`${CARD} [data-testid=perm-trust-line]`).first()
    await line.waitFor({ timeout: 10_000 })
    check((await line.innerText()).includes("This folder's own settings are ignored right now."), 'card: quiet line says the folder settings are ignored', await line.innerText())
    const inView = await line.evaluate((el) => {
      const b = el.getBoundingClientRect()
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
      return b.top >= 0 && b.bottom <= window.innerHeight && !!top && el.contains(top)
    })
    check(inView, 'card: the line is in view and uncovered at 1024x640')
    await page.locator(`${CARD} [data-testid=perm-trust-review]`).first().click()
    await tid('folder-trust-dialog').waitFor({ state: 'visible', timeout: 10_000 })
    check(true, 'card: Review opens the folder settings review')
    await closeReview()
    await projectTab(page, 'Live').click()
    await page.locator(CARD).first().waitFor({ timeout: 10_000 })
  }
  await page.locator(CARD).first().getByRole('button', { name: 'Allow once', exact: true }).click()
  await sleep(1000)
  await endRun()

  // ---- Stale digest: change a digested file after the review opened ----
  await openReview()
  const before = fs.readFileSync(settingsFile, 'utf8')
  fs.writeFileSync(settingsFile, '{"permissions":{"allow":["Bash(npm test:*)","Bash(make lint:*)"]}}\n')
  await tid('folder-trust-accept').click()
  await tid('folder-trust-stale').waitFor()
  check((await textOf('folder-trust-stale')).includes('changed while you were reading'), 'stale: sentence shown')
  check(await tid('folder-trust-dialog').isVisible(), 'stale: dialog stays open')
  check((await activeTestId()) === 'folder-trust-stale', 'stale: focus on the message', String(await activeTestId()))
  check((await tid('folder-trust-dialog-status').getAttribute('data-state')) === 'untrusted', 'stale: still untrusted')
  check((await tid('folder-trust-dialog').innerText()).includes('make lint'), 'stale: review re-fetched with the new rule')
  await dialogFits('stale 1024')
  await screenshot(page, 'folder-trust-stale')
  // Accept via keyboard.
  await tid('folder-trust-accept').focus()
  await page.keyboard.press('Enter')
  await tid('folder-trust-revoke').waitFor()
  check((await tid('folder-trust-dialog-status').getAttribute('data-state')) === 'trusted', 'accept by keyboard: dialog says trusted')
  check((await textOf('folder-trust-live')).startsWith('Allowed.'), 'accept: live region announces it', await textOf('folder-trust-live'))
  {
    const t = await tid('folder-trust-dialog').innerText()
    check(t.includes('Permission rules it adds') && !t.includes('would add'), 'after Allow the title says "adds"')
    // The one text toggle shows and hides every file's text.
    const toggle = tid('folder-trust-text-toggle')
    check((await toggle.getAttribute('aria-expanded')) === 'false', 'files text starts hidden')
    await toggle.click()
    check((await toggle.getAttribute('aria-expanded')) === 'true' && (await tid('folder-trust-dialog').locator('pre.trust-text').count()) > 0, 'Show all text reveals the files')
  }
  await closeReview()
  check((await statusState()) === 'trusted', 'settings status is trusted')
  check((await textOf('folder-trust-status')).includes('Agents use this folder'), 'trusted sentence')
  const live = await page.evaluate(() => window.orgai.projects.list())
  check(live.find((p) => p.name === FOLDER)?.folderConfigTrust?.state === 'trusted', 'main stores trusted')

  // ---- Notice gone; second run loaded and no card ----
  await newRunPage()
  await sleep(500)
  check((await tid('folder-trust-notice').count()) === 0, 'notice gone once allowed')
  check((await tid('topbar-folder-trust').count()) === 0, 'topbar pointer gone once allowed')
  await startRun('[mock:folder-config] run the tests again')
  check(await pageHas('Folder config loaded.'), 'run 2 says the folder config loaded')
  check(await pageHas('Mock: the folder-config script is done.'), 'run 2 finishes its script')
  check((await page.locator(CARD).count()) === 0, 'run 2: no permission card')
  await endRun()

  // ---- Changed: edit a digested file while trusted ----
  fs.writeFileSync(settingsFile, '{"permissions":{"allow":["Bash(npm test:*)","Bash(make lint:*)","Bash(make docs:*)"]}}\n')
  await openPermissionsPane()
  await page.waitForFunction(() => document.querySelector('[data-testid=folder-trust-status]')?.getAttribute('data-state') === 'changed', null, { timeout: 15_000 }).catch(() => {})
  check((await statusState()) === 'changed', 'edited while trusted: status is changed', await statusState())
  check((await textOf('folder-trust-status')).includes('changed since you allowed'), 'changed sentence')
  await newRunPage()
  await tid('folder-trust-notice').waitFor({ timeout: 15_000 })
  check(true, 'changed: the notice returns')
  check((await textOf('folder-trust-notice')).includes('changed since you allowed them'), 'changed: the notice says it changed', await textOf('folder-trust-notice'))
  await tid('topbar-folder-trust').waitFor({ timeout: 10_000 }).catch(() => {})
  check((await tid('topbar-folder-trust').count()) === 1, 'changed: the topbar pointer returns')
  await startRun('[mock:folder-config] run the tests after the edit')
  check(await pageHas('Folder config ignored.'), 'changed: the run says ignored')
  await page.locator(CARD).first().waitFor({ timeout: 20_000 })
  await page.locator(CARD).first().getByRole('button', { name: 'Allow once', exact: true }).click()
  await sleep(800)
  await endRun()

  // ---- Re-accept, then Revoke ----
  await openReview()
  check(await tid('folder-trust-accept').isVisible(), 'changed: Accept offered')
  await tid('folder-trust-accept').click()
  await tid('folder-trust-revoke').waitFor()
  await tid('folder-trust-revoke').click()
  await tid('folder-trust-accept').waitFor()
  check((await tid('folder-trust-dialog-status').getAttribute('data-state')) === 'untrusted', 'revoke: dialog says untrusted')
  check((await textOf('folder-trust-live')).startsWith('Stopped.'), 'revoke: live region announces it', await textOf('folder-trust-live'))
  await closeReview()
  check((await statusState()) === 'untrusted', 'revoke: settings status untrusted')
  await newRunPage()
  await tid('folder-trust-notice').waitFor({ timeout: 15_000 })
  check(true, 'revoke: the notice is back')
  // Dismiss hides it for this digest only; the topbar pointer stays until the user decides.
  await tid('folder-trust-notice-dismiss').click()
  check((await tid('folder-trust-notice').count()) === 0, 'Dismiss hides the notice')
  check((await tid('topbar-folder-trust').count()) === 1, 'Dismiss leaves the topbar pointer')
  fs.writeFileSync(settingsFile, before)

  // ---- Ignored saved rules ("Not used") ----
  const rulesFile = path.join(DATA_DIR, 'data', 'projects', project.id, 'permission-rules.json')
  let doc = {}
  try {
    doc = JSON.parse(fs.readFileSync(rulesFile, 'utf8'))
  } catch {
    /* none yet */
  }
  doc.permissions = { ...(doc.permissions ?? {}) }
  doc.permissions.allow = [...(doc.permissions.allow ?? []), 'Bash', 'Bash(python:*)', 'Bash(echo‮:*)']
  fs.mkdirSync(path.dirname(rulesFile), { recursive: true })
  fs.writeFileSync(rulesFile, JSON.stringify(doc))
  for (const [w, h, theme] of [
    [1024, 640, 'dark'],
    [1600, 1000, 'light']
  ]) {
    const tag = `${w}x${h} ${theme}`
    await size(w, h, theme)
    await openPermissionsPane()
    const toggle = tid('permissions-summary-toggle')
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    await tid('rules-ignored').waitFor()
    const rows = tid('rule-ignored-row')
    check((await rows.count()) === 3, `${tag}: three ignored rules listed`, String(await rows.count()))
    check((await tid('rules-ignored').innerText()).includes('Not used'), `${tag}: group titled Not used`)
    check((await rows.first().locator('[data-testid=rule-ignored-reason]').innerText()).trim().length > 10, `${tag}: a reason is shown`)
    check((await tid('rule-ignored-hidden').count()) === 1, `${tag}: hidden-character rule is flagged`)
    const shown = await tid('rules-ignored').innerText()
    check(!shown.includes('‮'), `${tag}: the hidden character is written out, not rendered`)
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    check(over <= 0, `${tag}: no horizontal overflow`, String(over))
    await screenshot(page, `folder-trust-${w}-${theme}-ignored`)
  }
  await size(1024, 640, 'dark')
  await openPermissionsPane()
  {
    const toggle = tid('permissions-summary-toggle')
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    await tid('rules-ignored').waitFor()
    await tid('rule-ignored-remove').first().click()
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=rule-ignored-row]').length === 2, null, { timeout: 8000 })
    check(true, 'Remove drops one ignored rule')
    await sleep(300)
    check((await activeTestId()) === 'rule-ignored-remove', 'focus moves to the next Remove', String(await activeTestId()))
    check((await textOf('rules-ignored-status')).includes('Removed the rule'), 'removal is announced', await textOf('rules-ignored-status'))
    while ((await tid('rule-ignored-row').count()) > 0) {
      await tid('rule-ignored-remove').first().click()
      await sleep(500)
    }
    await sleep(300)
    check((await tid('rules-ignored').count()) === 0, 'the group goes when empty')
    const a = await page.evaluate(() => document.activeElement?.tagName ?? '')
    check(a === 'INPUT' || a === 'TEXTAREA', 'focus lands on the rule input when the group empties', a)
  }
} catch (err) {
  check(false, `script threw: ${err?.message ?? err}`)
  await screenshot(page, 'folder-trust-threw').catch(() => {})
} finally {
  await app.close().catch(() => {})
  fs.rmSync(base, { recursive: true, force: true })
}
finish('folder-trust')
