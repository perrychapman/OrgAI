// Token-free. Mock adapter, temp ORGAI_DATA_DIR. Engagement phase 2-3 renderer surfaces (docs/design/engagement-2.md
// sections 3-7): team templates (save, taken name, App settings list, New project from a template, Replace the team +
// Undo, remove), the Ask run mode (conversation layout, Ask meta, History kind), the engagement plan (write, save,
// stale refusal), context notes (add, edit, remove), History > Trends (Month picker, Copy as CSV) and Forget engagement.
// The full flow runs at 1600x1000 dark; layout checks repeat at the other size / theme combinations.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, deleteProject, findProject, finish, gotoProjects, launch, openAppSettings, openProject, openProjectForm, openTeam, projectTab, sleep, windowShift } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-eng2-'))
const mk = (name) => {
  const dir = path.join(base, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
const wfA = mk('acme-audit')
const wfB = mk('birch-review')
const wfC = mk('cedar-from-template')

const A = 'E2E2 Acme audit (orgai test)'
const B = 'E2E2 Birch review (orgai test)'
const C = 'E2E2 Cedar from template (orgai test)'
const TEMPLATE = 'E2E team template'

const { app, page, shot } = await launch({ shotPrefix: 'engagement2' })
page.setDefaultTimeout(8000)

const setSize = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await page.waitForFunction((cw) => Math.abs(window.innerWidth - cw) <= 1, w, { timeout: 10_000 }).catch(() => {})
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await sleep(600)
}
const setTheme = async (theme) => {
  await page.evaluate(async (t) => {
    const s = await window.orgai.settings.get()
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, theme: t } })
  }, theme)
  await sleep(500)
}
const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim()
const until = async (fn, ms = 10_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await fn()) return true
    } catch {
      /* keep polling */
    }
    await sleep(200)
  }
  return false
}
const roleNames = async (name) => ((await findProject(page, name))?.roles ?? []).map((r) => r.name).sort()
const noPageScroll = () => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight }))
const fitsWindow = async (what) => {
  const o = await noPageScroll()
  check(o.sw <= o.cw && o.sh <= o.ch + 1, `${what}: the page does not scroll`, JSON.stringify(o))
}
const inView = (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.left >= -1 && r.right <= window.innerWidth + 1
  }, sel)

/** Create an engagement through the form with the setup interview off. Only valid while no template exists. */
async function createEngagement({ name, dir, template = false }) {
  await gotoProjects(page)
  const form = await openProjectForm(page)
  await form.locator('[data-testid=project-kind-option][data-kind=engagement] input[type=radio]').check({ force: true })
  await form.getByLabel('Name', { exact: true }).fill(name)
  await form.getByLabel('Working folder', { exact: true }).fill(dir)
  if (template) {
    await form.locator('[data-testid=setup-choice-template]').check({ force: true })
    await form.locator('[data-testid=new-project-template]').selectOption({ index: 0 })
    await form.getByRole('button', { name: 'Create from template', exact: true }).click()
  } else {
    const arch = form.locator('[data-testid=architect-setup]')
    if (await arch.isChecked()) await form.locator('label.checkbox', { hasText: 'Start with the setup interview' }).click()
    await form.getByRole('button', { name: 'Create project', exact: true }).click()
  }
  await page.waitForSelector('[data-testid=dashboard]', { state: 'detached', timeout: 60_000 })
  return findProject(page, name)
}
const openSettingsPane = async (pane) => {
  await projectTab(page, 'Settings').click()
  await page.getByRole('tab', { name: pane, exact: true }).click()
  await sleep(300)
}
const openTemplatesMenu = async () => {
  await page.locator('[data-testid=team-templates]').click()
  await page.locator('[data-testid=team-template-save]').waitFor({ state: 'visible' })
}

try {
  // ======== Setup: two engagements before any template exists ========
  const a = await createEngagement({ name: A, dir: wfA })
  check(!!a && a.kind === 'engagement', 'engagement A created')
  const b = await createEngagement({ name: B, dir: wfB })
  check(!!b, 'engagement B created')
  await setSize(1600, 1000)
  await setTheme('dark')

  // ======== 1. Templates ========
  await openProject(page, A)
  await openTeam(page)
  const before = (await roleNames(A)).length
  await page.getByRole('button', { name: 'Add role', exact: true }).click()
  check(await until(async () => (await roleNames(A)).length === before + 1), 'Add role saved one more role on A', `${before} -> ${(await roleNames(A)).length}`)
  const aRoles = await roleNames(A)
  const bRoles0 = await roleNames(B)

  // With no templates the apply item is disabled with a reason.
  await openTemplatesMenu()
  check((await page.locator('[data-testid=team-template-apply]').getAttribute('aria-disabled')) === 'true', 'Templates menu: Replace the team is disabled with no templates')
  check(/No templates yet/.test(await page.locator('[data-testid=team-template-apply]').innerText()), 'Templates menu: the reason says "No templates yet"')
  await shot('templates-menu')
  await page.locator('[data-testid=team-template-save]').click()
  const saveDialog = page.locator('[data-testid=template-save-dialog]')
  await saveDialog.waitFor({ state: 'visible' })
  await saveDialog.locator('[data-testid=template-name]').fill(TEMPLATE)
  await shot('template-save-dialog')
  await saveDialog.locator('[data-testid=template-save-confirm]').click()
  await saveDialog.waitFor({ state: 'detached' })
  const savedNotice = page.locator('[data-testid=template-saved-notice]')
  await savedNotice.waitFor({ state: 'visible' })
  check(clean(await savedNotice.innerText()).includes(`Saved the template ${TEMPLATE}.`), 'saving shows the "Saved the template" notice', clean(await savedNotice.innerText()))
  const listed = await page.evaluate(() => window.orgai.templates.list())
  check(listed.length === 1 && listed[0].name === TEMPLATE && listed[0].roleCount === aRoles.length, 'templates.list has the saved template with A\'s role count', JSON.stringify(listed.map((t) => [t.name, t.roleCount])))

  // Manage templates -> App settings pane.
  await savedNotice.getByRole('button', { name: 'Manage templates' }).click()
  await page.locator('[data-testid=templates-section]').waitFor({ state: 'visible' })
  check((await page.locator('[data-testid=template-row]').count()) === 1 && clean(await page.locator('[data-testid=template-row]').innerText()).includes(TEMPLATE), 'App settings > Templates and kit lists the row')
  const s1 = await windowShift(page)
  check(s1.ok, 'Manage templates deep link did not shift the window', JSON.stringify(s1))
  await shot('templates-section')

  // Same name again: the taken-name error and "Replace it".
  await openProject(page, A)
  await openTeam(page)
  await openTemplatesMenu()
  await page.locator('[data-testid=team-template-save]').click()
  await saveDialog.waitFor({ state: 'visible' })
  await saveDialog.locator('[data-testid=template-name]').fill(TEMPLATE)
  await saveDialog.locator('[data-testid=template-save-confirm]').click()
  await sleep(300)
  check(await saveDialog.isVisible(), 'a taken name keeps the dialog open')
  check(/You already have a template named/.test(await saveDialog.innerText()), 'the taken-name error shows', clean(await saveDialog.innerText()).slice(0, 200))
  check((await saveDialog.locator('[data-testid=template-replace]').count()) === 1, '"Replace it" is offered')
  await shot('template-taken')
  await saveDialog.locator('[data-testid=template-replace]').click()
  await saveDialog.waitFor({ state: 'detached' })
  await page.locator('[data-testid=template-saved-notice]').waitFor({ state: 'visible' })
  const afterReplace = await page.evaluate(() => window.orgai.templates.list())
  check(afterReplace.length === 1 && afterReplace[0].name === TEMPLATE, 'Replace it keeps one template with that name', JSON.stringify(afterReplace.map((t) => t.name)))

  // New project from the template.
  const cProj = await createEngagement({ name: C, dir: wfC, template: true })
  check(!!cProj, 'project created from the template')
  check(JSON.stringify(await roleNames(C)) === JSON.stringify(aRoles), 'the new project\'s roles match the template', `${JSON.stringify(await roleNames(C))} vs ${JSON.stringify(aRoles)}`)

  // Replace the team on B, then Undo.
  await openProject(page, B)
  await openTeam(page)
  await openTemplatesMenu()
  check((await page.locator('[data-testid=team-template-apply]').getAttribute('aria-disabled')) !== 'true', 'Templates menu: Replace the team is enabled once a template exists')
  await page.locator('[data-testid=team-template-apply]').click()
  const applyDialog = page.locator('[data-testid=template-apply-dialog]')
  await applyDialog.waitFor({ state: 'visible' })
  check((await applyDialog.locator('[data-testid=template-option]').count()) === 1, 'the apply dialog lists the template')
  await shot('template-apply-dialog')
  await applyDialog.locator('[data-testid=template-apply-confirm]').click()
  await applyDialog.waitFor({ state: 'detached' })
  await page.locator('[data-testid=template-notice]').waitFor({ state: 'visible' })
  check(await until(async () => JSON.stringify(await roleNames(B)) === JSON.stringify(aRoles)), 'Replace the team gave B the template\'s roles', JSON.stringify(await roleNames(B)))
  await shot('template-notice')
  await page.locator('[data-testid=template-undo]').click()
  await page.locator('[data-testid=template-undone]').waitFor({ state: 'visible' })
  check(await until(async () => JSON.stringify(await roleNames(B)) === JSON.stringify(bRoles0)), 'Undo restored B\'s previous roles', JSON.stringify(await roleNames(B)))

  // Remove the template in App settings.
  await openAppSettings(page)
  await page.getByRole('tab', { name: 'Templates and kit', exact: true }).click()
  await page.locator('[data-testid=template-row]').first().waitFor({ state: 'visible' })
  await page.locator('[data-testid=template-remove]').first().click()
  await page.getByRole('button', { name: 'Remove template', exact: true }).click()
  await page.locator('[data-testid=templates-empty]').waitFor({ state: 'visible' })
  check(true, 'removing the template shows templates-empty')
  check((await page.evaluate(() => window.orgai.templates.list())).length === 0, 'templates.list is empty after removal')

  // Practice kit (native dialogs are not driven).
  if (!(await page.evaluate(() => !!window.orgai.kit))) {
    log_skip('Practice kit: window.orgai.kit is undefined (no runtime side in this build)')
  } else {
    const kitSection = page.locator('[data-testid=kit-section]')
    await kitSection.waitFor({ state: 'visible' })
    check((await kitSection.locator('[data-testid=kit-export]').count()) === 1 && (await kitSection.locator('[data-testid=kit-import]').count()) === 1, 'Practice kit has Export and Import buttons')
    for (const [w, h] of [[1024, 640], [1600, 1000]]) {
      await setSize(w, h)
      await kitSection.locator('[data-testid=kit-export]').click()
      const kitDialog = page.locator('[data-testid=kit-export-dialog]')
      await kitDialog.waitFor({ state: 'visible' })
      await kitDialog.locator('[data-testid=kit-group]').first().waitFor({ state: 'visible' })
      const groups = await kitDialog.locator('[data-testid=kit-group]').evaluateAll((els) => els.map((e) => e.getAttribute('data-group')))
      check(JSON.stringify(groups) === JSON.stringify(['skills', 'servers', 'presets', 'templates']), `kit export dialog lists the four groups at ${w}x${h}`, JSON.stringify(groups))
      const countText = clean(await kitDialog.locator('[data-testid=kit-export-count]').innerText())
      const items = await kitDialog.locator('[data-testid=kit-item]').count()
      check(countText === (items === 0 ? 'Choose at least one item.' : `${items} ${items === 1 ? 'item' : 'items'}`), 'kit export count line matches the ticked items', `${countText} / ${items}`)
      check((await kitDialog.locator('[data-testid=kit-export-save]').isDisabled()) === (items === 0), 'Save kit is disabled only at zero items')
      await shot(`kit-export-${w}`)
      await kitDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await kitDialog.waitFor({ state: 'hidden' })
      check(await kitSection.locator('[data-testid=kit-export]').evaluate((el) => el === document.activeElement), 'Cancel returns focus to Export a kit')
    }
  }

  // ======== 3. Plan ========
  await openProject(page, A)
  await openSettingsPane('General')
  const planSection = page.locator('[data-testid=engagement-plan-section]')
  await planSection.waitFor({ state: 'visible' })
  await page.locator('[data-testid=engagement-plan-write]').click()
  await page.locator('[data-testid=engagement-plan-editor]').fill('# Plan\n\nAudit the Acme ledgers.')
  await page.locator('[data-testid=engagement-plan-save]').click()
  await page.locator('[data-testid=engagement-plan-edit]').waitFor({ state: 'visible' })
  check(/Plan saved\./.test(await page.locator('[data-testid=engagement-plan-status]').innerText()), 'saving the plan says "Plan saved."')
  check((await page.locator('[data-testid=engagement-plan-view]').innerText()).includes('Audit the Acme ledgers'), 'the plan view shows the saved text')
  await shot('plan-saved')
  // Stale: edit, change the stored plan behind the editor, save.
  await page.locator('[data-testid=engagement-plan-edit]').click()
  const editor = page.locator('[data-testid=engagement-plan-editor]')
  await editor.waitFor({ state: 'visible' })
  await editor.fill('# Plan\n\nMy typed text.')
  const changed = await page.evaluate(async (id) => {
    const doc = await window.orgai.engagement.document(id)
    await new Promise((r) => setTimeout(r, 30))
    return window.orgai.engagement.updateDocument({ projectId: id, text: '# Plan\n\nChanged elsewhere.', expectedUpdatedAt: doc.updatedAt })
  }, a.id)
  check(!!changed.updatedAt, 'the stored plan was changed behind the editor')
  await sleep(300)
  await page.locator('[data-testid=engagement-plan-save]').click()
  const stale = page.locator('[data-testid=engagement-plan-stale]')
  await stale.waitFor({ state: 'visible' })
  check(true, 'a save against a changed plan shows engagement-plan-stale')
  check((await editor.inputValue()) === '# Plan\n\nMy typed text.', 'the editor keeps the typed text')
  await shot('plan-stale')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await page.locator('[data-testid=engagement-plan-edit]').waitFor({ state: 'visible' })
  check((await page.locator('[data-testid=engagement-plan-view]').innerText()).includes('Changed elsewhere'), 'after discarding, the view shows the plan that was stored')

  const sPlan = await windowShift(page)
  check(sPlan.ok, 'General pane did not shift the window', JSON.stringify(sPlan))

  // ======== 4. Notes (from the Knowledge tab; docs/design/knowledge.md section 4) ========
  const openKnowledge = async () => {
    await page.locator('[data-testid=tab-knowledge]').click()
    await page.locator('[data-testid=knowledge-view]').waitFor({ state: 'visible' })
  }
  const noteRow = (title) => page.locator('[data-testid=knowledge-row][data-kind=note]', { has: page.locator('[data-testid=knowledge-row-name]', { hasText: title }) }).first()
  const kStatus = async () => clean(await page.locator('[data-testid=knowledge-status]').innerText())
  await openKnowledge()
  await page.locator('[data-testid=knowledge-empty]').waitFor({ state: 'visible' })
  check(true, 'Knowledge starts empty ("Nothing recorded yet")')
  const addNote = async (title, text) => {
    await page.locator('[data-testid=knowledge-toolbar] [data-testid=knowledge-add-note]').click()
    const dlg = page.locator('[data-testid=context-note-dialog]')
    await dlg.waitFor({ state: 'visible' })
    await dlg.locator('[data-testid=context-note-title]').fill(title)
    await dlg.locator('[data-testid=context-note-text]').fill(text)
    await dlg.locator('[data-testid=context-note-save]').click()
    await dlg.waitFor({ state: 'detached' })
  }
  await addNote('Client preferences', 'Prefers email on Tuesdays.')
  await noteRow('Client preferences').waitFor({ state: 'visible' })
  check(await until(async () => (await kStatus()) === 'Note saved.'), 'adding a note announces "Note saved."', await kStatus())
  check(/You · /.test(await noteRow('Client preferences').locator('[data-testid=knowledge-row-prov]').innerText()), 'the note row shows "You · <date>"')
  await addNote('Meeting notes', 'Kickoff on Monday.')
  check(await until(async () => (await page.locator('[data-testid=knowledge-row][data-kind=note]').count()) === 2), 'two note rows')
  await noteRow('Client preferences').click()
  await page.locator('[data-testid=knowledge-note-edit]').click()
  const nd = page.locator('[data-testid=context-note-dialog]')
  await nd.waitFor({ state: 'visible' })
  check((await nd.locator('[data-testid=context-note-text]').inputValue()) === 'Prefers email on Tuesdays.', 'the edit dialog loads the note text')
  await nd.locator('[data-testid=context-note-text]').fill('Prefers phone calls.')
  await nd.locator('[data-testid=context-note-save]').click()
  await nd.waitFor({ state: 'detached' })
  const listedNotes = await page.evaluate((id) => window.orgai.engagement.listNotes(id), a.id)
  const edited = listedNotes.find((n) => n.title === 'Client preferences')
  const editedContent = edited ? await page.evaluate((r) => window.orgai.engagement.getNote(r), { projectId: a.id, noteId: edited.id }) : null
  check(editedContent?.text === 'Prefers phone calls.', 'editing a note saved the new text', JSON.stringify(editedContent))
  await shot('notes')
  await noteRow('Client preferences').click()
  await page.locator('[data-testid=knowledge-delete]').click()
  await page.getByRole('button', { name: 'Remove note', exact: true }).click()
  check(await until(async () => (await page.locator('[data-testid=knowledge-row][data-kind=note]').count()) === 1), 'removing a note leaves one row')
  check(await until(async () => (await kStatus()) === 'Deleted Client preferences.'), 'removing announces "Deleted Client preferences."', await kStatus())
  const sNotes = await windowShift(page)
  check(sNotes.ok, 'Knowledge tab did not shift the window', JSON.stringify(sNotes))

  // ======== 2. Ask ========
  await openProject(page, A)
  await projectTab(page, 'Live').click()
  if (!(await page.locator('.new-run').count())) {
    await page.keyboard.press('Control+t')
  }
  await page.locator('.new-run').waitFor({ timeout: 10_000 })
  await page.locator('[data-testid=new-run-mode] label', { hasText: 'Ask' }).click()
  check(/One assistant answers/.test(await page.locator('[data-testid=new-run-ask-lead]').innerText()), 'Ask mode shows its lead (new-run-ask-lead)')
  const modeBox = await page.locator('[data-testid=new-run-mode]').boundingBox()
  check(!!modeBox && modeBox.height < 40, `the Team / Ask switch is one row (height ${modeBox?.height})`)
  const modeLabelCut = await page.locator('.composer-mode-label').evaluate((el) => el.scrollWidth > el.clientWidth)
  check(!modeLabelCut, 'the Ask mode label is not cut')
  const descCut = await page.locator('[data-testid=new-run-mode-desc]').evaluate((el) => el.scrollWidth > el.clientWidth)
  check(!descCut && /one assistant/.test(await page.locator('[data-testid=new-run-mode-desc]').innerText()), 'the Ask description is whole')
  await shot('ask-new-run')
  await page.locator('.composer textarea').fill('What does the plan say?')
  await page.locator('.composer .btn.primary').click()
  await page.locator('[data-testid=run-conversation]').waitFor({ state: 'visible', timeout: 20_000 })
  check(true, 'an Ask run opens in the conversation layout')
  check(await until(async () => /Mock reply to: What does the plan say\?/.test(await page.locator('[data-testid=conversation-transcript]').innerText()), 20_000), 'the conversation shows the mock reply', clean(await page.locator('[data-testid=conversation-transcript]').innerText().catch(() => '')).slice(0, 200))
  check(/Ask/.test(await page.locator('[data-testid=run-meta-ask]').innerText().catch(() => '')), 'the run meta says Ask · one assistant')
  await fitsWindow('Ask run (1600x1000 dark)')
  await shot('ask-run')
  const end = page.getByRole('button', { name: 'End session' })
  if (await end.count()) {
    await end.first().click().catch(() => {})
    await sleep(1500)
  }
  await projectTab(page, 'History').click()
  await page.locator('[data-testid=run-kind][data-kind=ask]').first().waitFor({ state: 'visible', timeout: 15_000 })
  check(true, 'History shows run-kind[data-kind=ask]')

  // ======== 5. Trends ========
  await page.locator('.seg label', { hasText: 'Trends' }).click()
  await page.locator('[data-testid=usage-trends]').waitFor({ state: 'visible' })
  await page.locator('[data-testid=trends-controls]').waitFor({ state: 'visible' })
  check(await until(async () => await page.locator('[data-testid=trends-copy-csv]').isEnabled()), 'Copy as CSV is enabled once there is a run')
  await page.locator('.trends-controls .seg label', { hasText: 'Month' }).click()
  await page.locator('select[data-testid=trends-month]').waitFor({ state: 'visible' })
  check(/so far/.test(await page.locator('select[data-testid=trends-month] option').first().innerText()), 'the Month picker lists the current month first')
  check(/Every run in this range/.test(await page.locator('[data-testid=trends-scope]').innerText().catch(() => '')), 'trends-scope says every run counts')
  check((await page.locator('[data-testid=trends-kinds] tr[data-kind=Ask]').count()) === 1, 'By kind has an Ask row')
  await page.locator('[data-testid=trends-copy-csv]').click()
  await page.waitForFunction(() => /^Copied \d+ runs? as CSV\.$/.test(document.querySelector('[data-testid=trends-csv-status]')?.textContent?.trim() ?? ''), null, { timeout: 8000 }).catch(() => {})
  const csvStatus = clean(await page.locator('[data-testid=trends-csv-status]').innerText())
  check(/^Copied \d+ runs? as CSV\.$/.test(csvStatus), 'trends-csv-status reads "Copied N runs as CSV."', csvStatus)
  const csv = await page.evaluate((id) => window.orgai.runs.usageCsv({ projectId: id, kinds: ['work', 'setup', 'mcp-assist', 'skill-assist'], range: { month: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}` } }), a.id)
  // Main emits a leading UTF-8 BOM by design (runUsage.ts); the header is checked after it.
  const noBom = (s) => s.replace(/^﻿/, '')
  check(noBom(csv).startsWith('project,client,started,started_utc,ended,kind,status,title,roles'), 'usageCsv has the header row started,ended,kind,...', csv.split(/\r?\n/)[0])
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null))
  if (clip !== null) check(noBom(clip).startsWith('project,client,started,started_utc,ended,kind'), 'the clipboard holds the CSV header row', clip.split(/\r?\n/)[0])
  else log_skip('clipboard not readable in this window; header checked through runs.usageCsv')
  await shot('trends')
  await fitsWindow('Trends (1600x1000 dark)')

  // ======== Layout at every size / theme ========
  for (const [w, h] of [[1600, 1000], [1024, 640]]) {
    for (const theme of ['dark', 'light']) {
      const tag = `${w}x${h} ${theme}`
      await setSize(w, h)
      await setTheme(theme)
      await openProject(page, A)
      await openSettingsPane('General')
      await page.locator('[data-testid=engagement-plan-section]').scrollIntoViewIfNeeded()
      check((await inView('[data-testid=engagement-plan-view]')) === true, `${tag}: the plan view sits inside the window`)
      const sh = await windowShift(page)
      check(sh.ok, `${tag}: General did not shift the window`, JSON.stringify(sh))
      await shot(`settings-general-${w}-${theme}`)
      await openKnowledge()
      await page.locator('[data-testid=knowledge-row][data-kind=note]').first().waitFor({ state: 'visible' })
      check((await inView('[data-testid=knowledge-row][data-kind=note]')) === true, `${tag}: the note row sits inside the window on the Knowledge tab`)
      await fitsWindow(`${tag} Knowledge`)
      await openTeam(page)
      await openTemplatesMenu()
      check((await inView('[data-testid=team-template-save]')) === true && (await inView('[data-testid=team-template-apply]')) === true, `${tag}: the Templates menu items are inside the window`)
      await page.keyboard.press('Escape')
      await projectTab(page, 'History').click()
      await page.locator('[data-testid=usage-trends], .seg label').first().waitFor()
      if (!(await page.locator('[data-testid=usage-trends]').count())) await page.locator('.seg label', { hasText: 'Trends' }).click()
      await page.locator('[data-testid=trends-controls]').waitFor({ state: 'visible' })
      check((await inView('[data-testid=trends-copy-csv]')) === true, `${tag}: Copy as CSV is inside the window`)
      await fitsWindow(`${tag} Trends`)
      await shot(`trends-${w}-${theme}`)
      await projectTab(page, 'Live').click()
      await page.locator('.new-run, [data-testid=run-conversation], .run-body').first().waitFor()
      await fitsWindow(`${tag} Live`)
    }
  }

  // ======== 6. Forget ========
  await setSize(1600, 1000)
  await setTheme('dark')
  await openProject(page, A)
  await openSettingsPane('Maintenance')
  await page.locator('[data-testid=forget-engagement]').click()
  const confirmBody = page.locator('[data-testid=forget-confirm]')
  await confirmBody.waitFor({ state: 'visible' })
  const confirmText = clean(await confirmBody.innerText())
  check(/engagement plan/i.test(confirmText), 'forget confirm lists the plan', confirmText)
  check(/1 context note/.test(confirmText), 'forget confirm lists the note count', confirmText)
  check(/\b1 run\b/.test(confirmText), 'forget confirm lists the run count', confirmText)
  await shot('forget-confirm')
  await page.getByRole('button', { name: 'Forget engagement', exact: true }).click()
  await page.locator('[data-testid=forget-notice]').waitFor({ state: 'visible', timeout: 15_000 })
  check(/Forgot .*E2E2 Acme audit/.test(clean(await page.locator('[data-testid=forget-notice]').innerText())), 'the Dashboard shows forget-notice', clean(await page.locator('[data-testid=forget-notice]').innerText()))
  check(!(await findProject(page, A)), 'the project is gone from projects.list()')
  await shot('forget-notice')
} catch (e) {
  check(false, 'script ran to the end', e.stack ?? e.message)
  await shot('failure').catch(() => {})
} finally {
  for (const n of [B, C, A]) await deleteProject(page, n).catch(() => {})
  await app.close().catch(() => {})
  fs.rmSync(base, { recursive: true, force: true })
  finish('engagement2')
}

function log_skip(msg) {
  console.log(`SKIP ${msg}`)
}
