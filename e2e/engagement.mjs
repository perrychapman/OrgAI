// Token-free. Mock adapter, temp ORGAI_DATA_DIR. The engagement project kind (docs/design/engagement.md), renderer
// phase 1: the New project form's kind cards and initial focus, creating an engagement with a client and a reference
// folder (typed paths, real temp folders), Project settings (kind line, client field, reference folders moved to
// Allowed and back, summary count, Maintenance), and the sidebar / dashboard / topbar client display (headers with two
// clients, collapse state, rail dividers, tile and topbar client). Run at 1600x1000 and 1024x640, dark and light.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, createProject, findProject, finish, gotoProjects, launch, makeFixtureRepo, openProject, openProjectForm, projectTab, sleep, windowShift } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-eng-'))
const mk = (name) => {
  const dir = path.join(base, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
const wfAudit = mk('acme-audit')
const wfTax = mk('acme-tax')
const wfBirch = mk('birch-review')
const refFolder = mk('acme-shared-docs')
const refBirch = mk('birch-docs')
const repo = path.join(base, 'notes-app')
makeFixtureRepo('eng', { at: repo })

const AUDIT = 'E2E Acme audit (orgai test)'
const TAX = 'E2E Acme tax (orgai test)'
const BIRCH = 'E2E Birch review (orgai test)'
const CODE = 'E2E code (orgai test)'

const { app, page, shot } = await launch({ shotPrefix: 'engagement' })
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

/** Create an engagement through the form (first launch inline form or the dialog). Setup interview is switched off (token-free). */
async function createEngagement({ name, client, dir, refs = [] }) {
  await gotoProjects(page)
  const form = await openProjectForm(page)
  await form.locator('[data-testid=project-kind-option][data-kind=engagement] input[type=radio]').check({ force: true })
  await form.getByLabel('Name', { exact: true }).fill(name)
  if (client) await form.locator('[data-testid=new-project-client]').fill(client)
  await form.getByLabel('Working folder', { exact: true }).fill(dir)
  for (const r of refs) {
    await form.locator('[data-testid=new-project-ref-input]').fill(r)
    await form.locator('[data-testid=new-project-ref-add]').click()
  }
  const arch = form.locator('[data-testid=architect-setup]')
  if (await arch.isChecked()) await form.locator('label.checkbox', { hasText: 'Start with the setup interview' }).click()
  await form.getByRole('button', { name: 'Create project', exact: true }).click()
  await page.waitForSelector('[data-testid=dashboard]', { state: 'detached', timeout: 60_000 })
  return findProject(page, name)
}
const openSettingsPane = async (pane) => {
  await projectTab(page, 'Settings').click()
  await page.getByRole('tab', { name: pane, exact: true }).click()
  await sleep(300)
}
const openSummary = async () => {
  const toggle = page.locator('[data-testid=permissions-summary-toggle]')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await page.locator('[data-testid=reference-folder-input]').waitFor({ state: 'visible' })
}

try {
  // ---- First launch: the kind choice is empty and the submit explains it ----
  {
    const form = await openProjectForm(page)
    const checkedKinds = await form.locator('[data-testid=project-kind-option] input[type=radio]:checked').count()
    check((await form.locator('[data-testid=project-kind-option]').count()) === 2 && checkedKinds === 0, 'first launch: two kind cards, none chosen')
    check(await form.locator('button[type=submit]').isDisabled(), 'first launch: submit is disabled until a kind is chosen')
    check(/Choose what this project is for\./.test(await form.innerText()), 'first launch: the submit says why it is disabled')
    check(clean(await form.locator('fieldset.project-kind legend').innerText()) === 'What is this project for?', 'the kind fieldset is named "What is this project for?"')
    check((await form.getByLabel('Name', { exact: true }).count()) === 0, 'first launch: no name or folder fields before a kind is chosen')
    await shot('first-launch')
    await form.locator('[data-testid=project-kind-option][data-kind=engagement] input[type=radio]').check({ force: true })
    check((await form.getByLabel('Name', { exact: true }).getAttribute('placeholder')) === 'Client or case name', 'engagement: Name placeholder is "Client or case name"')
    check(clean(await form.locator('label[for$="-path"]').innerText()) === 'Working folder' && !/\bgit\b/i.test(await form.locator('label[for$="-path"]').locator('xpath=..').innerText()), 'engagement: "Working folder" label with no git wording')
    check((await form.getByRole('button', { name: 'Create and start interview' }).count()) === 1, 'engagement: submit reads "Create and start interview" with the interview on')
    check((await form.getByText('What is the engagement about? (optional)').count()) === 1, 'engagement: brief label is "What is the engagement about? (optional)"')
    // Reference folder errors: relative path and the working folder itself.
    await form.getByLabel('Working folder', { exact: true }).fill(wfAudit)
    await form.locator('[data-testid=new-project-ref-input]').fill('relative/dir')
    await form.locator('[data-testid=new-project-ref-add]').click()
    check((await form.locator('[data-testid=new-project-ref-error]').count()) === 1, 'a relative reference path shows an error')
    await form.locator('[data-testid=new-project-ref-input]').fill(wfAudit)
    await form.locator('[data-testid=new-project-ref-add]').click()
    check(/working folder/.test(await form.locator('[data-testid=new-project-ref-error]').innerText().catch(() => '')), 'the working folder is refused as a reference folder')
    await form.locator('[data-testid=new-project-ref-input]').fill('')
    // Switching to Code swaps the fields back.
    await form.locator('[data-testid=project-kind-option][data-kind=code] input[type=radio]').check({ force: true })
    check((await form.getByRole('radio', { name: 'Existing code', exact: true }).count()) === 1 && (await form.getByRole('radio', { name: 'New idea', exact: true }).count()) === 1, 'code: the sub-switch reads New idea / Existing code')
    check((await form.locator('[data-testid=new-project-client]').count()) === 0, 'code: no client field')
  }

  // ---- Create the engagements ----
  const audit = await createEngagement({ name: AUDIT, client: 'Acme Corp', dir: wfAudit, refs: [refFolder] })
  check(!!audit && audit.kind === 'engagement' && audit.client === 'Acme Corp', 'engagement created with its client', JSON.stringify({ kind: audit?.kind, client: audit?.client }))
  check(audit && (audit.referenceDirectories ?? []).length === 1, 'the reference folder was saved with the project', JSON.stringify(audit?.referenceDirectories))
  await shot('created-first')

  // ---- New project dialog: initial focus and arrow keys ----
  {
    await gotoProjects(page)
    await page.locator('[data-testid=new-project]').click()
    const form = page.locator('[data-testid=new-project-dialog] form')
    await form.waitFor()
    await sleep(300)
    const focus = await page.evaluate(() => {
      const a = document.activeElement
      return { type: a?.getAttribute('type'), kind: a?.closest('[data-testid=project-kind-option]')?.getAttribute('data-kind'), checked: a?.checked }
    })
    check(focus.type === 'radio' && focus.kind === 'engagement' && focus.checked === true, 'dialog opens with focus on the checked (last used) kind radio', JSON.stringify(focus))
    await page.keyboard.press('ArrowRight')
    const afterRight = await page.evaluate(() => document.querySelector('[data-testid=project-kind-option] input:checked')?.closest('[data-testid=project-kind-option]')?.getAttribute('data-kind'))
    await page.keyboard.press('ArrowLeft')
    const afterLeft = await page.evaluate(() => document.querySelector('[data-testid=project-kind-option] input:checked')?.closest('[data-testid=project-kind-option]')?.getAttribute('data-kind'))
    check(afterRight !== afterLeft && afterLeft === 'engagement', 'ArrowRight / ArrowLeft move the kind choice', `${afterRight} / ${afterLeft}`)
    await page.keyboard.press('Escape')
    await page.locator('[data-testid=new-project-dialog] form').waitFor({ state: 'hidden' }).catch(() => {})
  }

  const tax = await createEngagement({ name: TAX, client: 'acme corp', dir: wfTax })
  check(!!tax && tax.client === 'acme corp', 'a second engagement for the same client (different case)')
  const birch = await createEngagement({ name: BIRCH, client: 'Birch LLC', dir: wfBirch, refs: [refBirch] })
  check(!!birch, 'a third engagement for another client')
  const code = await createProject(page, { mode: 'existing', path: repo, name: CODE })
  check(!!code && (code.kind ?? 'code') === 'code', 'a code project through the Code kind card')

  // ---- Project settings: General ----
  await setSize(1600, 1000)
  await setTheme('dark')
  await openProject(page, AUDIT)
  check(clean(await page.locator('[data-testid=project-client]').first().innerText()) === 'Acme Corp', 'topbar shows the client after the name')
  await openSettingsPane('General')
  const kindLine = page.locator('[data-testid=project-kind-line]')
  check(clean(await kindLine.innerText()) === 'Kind: Engagement' && (await kindLine.getAttribute('data-kind')) === 'engagement', 'General: "Kind: Engagement"')
  const clientInput = page.locator('[data-testid=project-client-input]')
  check((await clientInput.inputValue()) === 'Acme Corp', 'General: the client field holds the saved client')
  await clientInput.fill('Acme Corporation')
  await clientInput.press('Tab')
  await sleep(600)
  check((await findProject(page, AUDIT))?.client === 'Acme Corporation', 'editing the client saves it')
  check(clean(await page.locator('[data-testid=project-client]').first().innerText()) === 'Acme Corporation', 'the topbar follows the edited client')
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  await openProject(page, AUDIT)
  await openSettingsPane('General')
  check((await page.locator('[data-testid=project-client-input]').inputValue()) === 'Acme Corporation', 'the edited client survives a reload')
  await page.locator('[data-testid=project-client-input]').fill('Acme Corp')
  await page.locator('[data-testid=project-client-input]').press('Tab')
  await sleep(600)
  check((await findProject(page, AUDIT))?.client === 'Acme Corp', 'the client is set back')
  check(clean(await page.locator('[data-testid=project-path]').innerText()) !== '', 'General: working directory still shown')
  const shift0 = await windowShift(page)
  check(shift0.ok, 'General pane did not shift the window', JSON.stringify(shift0))

  // ---- Permissions: reference folders ----
  await openSettingsPane('Permissions')
  await openSummary()
  const shift1 = await windowShift(page)
  check(shift1.ok, 'Permissions pane did not shift the window', JSON.stringify(shift1))
  check((await page.locator('[data-testid=reference-folders-section]').count()) === 1, 'Permissions: Reference folders card present')
  const refCardTop = await page.evaluate(() => document.querySelector('[data-testid=reference-folders-section]').getBoundingClientRect().top)
  const allowedCardTop = await page.evaluate(() => document.querySelector('[data-testid=allowed-folders-section]').getBoundingClientRect().top)
  check(refCardTop < allowedCardTop, 'Reference folders sits above Allowed folders')
  const row = page.locator('[data-testid=reference-folder-row]').first()
  await row.waitFor()
  check(clean(await row.locator('[data-testid=reference-folder-access]').innerText()) === 'Read only', 'the reference folder row says Read only')
  check(clean(await row.innerText()).includes('acme-shared-docs'), 'the reference folder created with the project is listed')
  check(/1 reference folder\b/.test(clean(await page.locator('[data-testid=permissions-summary]').innerText())), 'summary counts 1 reference folder')
  check(/Saved in OrgAI for this project\./.test(await page.locator('#settings-section-permissions').innerText()), 'rules panel says "Saved in OrgAI for this project."')
  await shot('settings-permissions-dark')
  await page.locator('[data-testid=reference-folder-allow-changes]').first().click()
  await page.locator('[data-testid=allowed-folder-row]').first().waitFor()
  const moved = await findProject(page, AUDIT)
  check((moved.referenceDirectories ?? []).length === 0 && (moved.allowedDirectories ?? []).length === 1, 'Allow changes moves the folder to Allowed')
  check(clean(await page.locator('[data-testid=allowed-folder-row] [data-testid=allowed-folder-access]').first().innerText()) === 'Can change', 'the moved row says Can change')
  const summaryMoved = clean(await page.locator('[data-testid=permissions-summary]').innerText())
  check(/1 folder you allowed/.test(summaryMoved) && !/reference folder/.test(summaryMoved), 'summary counts the allowed folder only', summaryMoved)
  await page.locator('[data-testid=allowed-folder-make-readonly]').first().click()
  await page.locator('[data-testid=reference-folder-row]').first().waitFor()
  const back = await findProject(page, AUDIT)
  check((back.referenceDirectories ?? []).length === 1 && (back.allowedDirectories ?? []).length === 0, 'Make read only moves it back')
  check(/1 reference folder\b/.test(clean(await page.locator('[data-testid=permissions-summary]').innerText())), 'summary is back to 1 reference folder')

  // ---- Maintenance ----
  await openSettingsPane('Maintenance')
  const mline = page.locator('[data-testid=maintenance-engagement-line]')
  check(clean(await mline.innerText().catch(() => '')) === 'OrgAI keeps its notes for this engagement in its own data folder. Nothing is written to your working folder.', 'Maintenance: the engagement line')
  check((await page.getByRole('button', { name: 'Remove OrgAI files from repository' }).count()) === 0, 'Maintenance: no "Remove OrgAI files" row for an engagement')

  // ---- A code project keeps its old surfaces ----
  await openProject(page, CODE)
  check((await page.locator('[data-testid=project-client]').count()) === 0, 'code: no topbar client')
  await openSettingsPane('General')
  check(clean(await page.locator('[data-testid=project-kind-line]').innerText()) === 'Kind: Code project', 'General: "Kind: Code project"')
  check((await page.locator('[data-testid=project-client-input]').count()) === 0, 'code: no client field')
  await openSettingsPane('Maintenance')
  check((await page.locator('[data-testid=maintenance-engagement-line]').count()) === 0 && (await page.getByRole('button', { name: 'Remove OrgAI files from repository' }).count()) === 1, 'code: Maintenance keeps Remove OrgAI files and has no engagement line')

  // ---- Sidebar grouping, wide ----
  await gotoProjects(page)
  const groups = page.locator('.sidebar [data-testid=nav-client-group]')
  check((await groups.count()) === 2, 'sidebar: two client headers for two clients (case-insensitive merge)', String(await groups.count()))
  const acme = page.locator('.sidebar [data-testid=nav-client-group][data-client="Acme Corp"]')
  check(clean(await acme.innerText()).startsWith('Acme Corp (2)'), 'the header reads "<Client> (N)"', clean(await acme.innerText().catch(() => '')))
  check((await acme.getAttribute('aria-expanded')) === 'true', 'headers start expanded')
  check(clean(await page.locator('.sidebar [data-testid=nav-client-code-label]').innerText().catch(() => '')) === 'Code', 'code projects sit under a quiet "Code" label')
  const auditRow = page.locator(`.sidebar [data-testid=nav-project][data-name="${AUDIT}"]`)
  const taxRow = page.locator(`.sidebar [data-testid=nav-project][data-name="${TAX}"]`)
  check((await auditRow.isVisible()) && (await taxRow.isVisible()), 'rows under an expanded header are visible')
  await shot('sidebar-grouped-dark')
  await acme.click()
  await sleep(200)
  check((await acme.getAttribute('aria-expanded')) === 'false' && !(await auditRow.isVisible()) && !(await taxRow.isVisible()), 'collapsing hides the rows and flips aria-expanded')
  await shot('sidebar-collapsed-dark')
  const stored = await page.evaluate(() => localStorage.getItem('orgai.sidebarClientGroups'))
  check(!!stored && stored.includes('acme corp'), 'collapse state is stored in orgai.sidebarClientGroups', String(stored))
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  check((await page.locator('.sidebar [data-testid=nav-client-group][data-client="Acme Corp"]').getAttribute('aria-expanded')) === 'false', 'collapse state survives a reload')
  await page.locator('.sidebar [data-testid=nav-client-group][data-client="Acme Corp"]').focus()
  await page.keyboard.press('Enter')
  await sleep(200)
  check((await page.locator('.sidebar [data-testid=nav-client-group][data-client="Acme Corp"]').getAttribute('aria-expanded')) === 'true' && (await auditRow.isVisible()), 'Enter on a focused header expands it again')

  // ---- Dashboard tile ----
  await gotoProjects(page)
  const tileClient = page.locator(`[data-testid=project-tile][data-name="${AUDIT}"] [data-testid=tile-client]`)
  check(clean(await tileClient.innerText().catch(() => '')) === 'Acme Corp', 'dashboard tile shows the client')
  check((await page.locator(`[data-testid=project-tile][data-name="${CODE}"] [data-testid=tile-client]`).count()) === 0, 'a code tile has no client line')

  // ---- Both sizes, both themes: layout and screenshots ----
  for (const [w, h] of [[1600, 1000], [1024, 640]]) {
    for (const theme of ['dark', 'light']) {
      const tag = `${w}-${theme}`
      await setSize(w, h)
      await setTheme(theme)
      await gotoProjects(page)
      const rail = w < 1180
      const headerCount = await page.locator('.sidebar [data-testid=nav-client-group]').count()
      const dividers = await page.locator('.sidebar hr.nav-client-divider').count()
      check(rail ? headerCount === 0 && dividers >= 1 : headerCount === 2 && dividers === 0, `${tag}: sidebar ${rail ? 'rail has dividers and no headers' : 'shows client headers'}`, `headers ${headerCount}, dividers ${dividers}`)
      const tileBox = await page.evaluate((n) => {
        const t = document.querySelector(`[data-testid=project-tile][data-name="${n}"]`)
        const c = t?.querySelector('[data-testid=tile-client]')
        if (!t || !c) return null
        const tr = t.getBoundingClientRect()
        const cr = c.getBoundingClientRect()
        return cr.left >= tr.left - 1 && cr.right <= tr.right + 1 && cr.height > 0
      }, AUDIT)
      check(tileBox === true, `${tag}: tile client line sits inside its tile`)
      await shot(`dashboard-${tag}`)

      await page.locator('[data-testid=new-project]').click()
      const form = page.locator('[data-testid=new-project-dialog] form')
      await form.waitFor()
      await sleep(300)
      await form.locator('[data-testid=project-kind-option][data-kind=engagement] input[type=radio]').check({ force: true })
      await form.locator('[data-testid=new-project-ref-input]').fill(refFolder)
      await form.locator('[data-testid=new-project-ref-add]').click()
      await sleep(200)
      const fit = await page.evaluate(() => {
        const d = document.querySelector('[data-testid=new-project-dialog]')
        const f = d?.querySelector('form')
        const submit = f?.querySelector('button[type=submit]')
        const sr = submit?.getBoundingClientRect()
        return { overflowX: (f?.scrollWidth ?? 0) > (f?.clientWidth ?? 0) + 1, submitInView: !!sr && sr.bottom <= window.innerHeight + 1 && sr.top >= 0, scrollable: !!d && [d, ...d.querySelectorAll('*')].some((e) => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1) }
      })
      check(!fit.overflowX, `${tag}: the engagement form has no horizontal overflow`)
      check(fit.submitInView || fit.scrollable, `${tag}: the submit is reachable (in view or the dialog scrolls)`, JSON.stringify(fit))
      await shot(`new-engagement-${tag}`)
      await page.keyboard.press('Escape')
      await form.waitFor({ state: 'hidden' }).catch(() => {})

      if (!rail) await openProject(page, AUDIT)
      else await page.locator(`.sidebar [data-testid=nav-project][data-name="${AUDIT}"]`).first().click()
      await page.waitForSelector('[data-testid=dashboard]', { state: 'detached', timeout: 10_000 })
      const topbar = await page.evaluate(() => {
        const c = document.querySelector('[data-testid=project-client]')
        const bar = document.querySelector('.project-topbar')
        if (!c || !bar) return null
        const cr = c.getBoundingClientRect()
        const br = bar.getBoundingClientRect()
        return { inside: cr.right <= br.right + 1 && cr.left >= br.left - 1, h: cr.height }
      })
      check(!!topbar && topbar.inside && topbar.h > 0, `${tag}: the topbar client is inside the topbar`, JSON.stringify(topbar))
      await openSettingsPane('Permissions')
      await openSummary()
      await shot(`settings-permissions-${tag}`)
      const shiftN = await windowShift(page)
      check(shiftN.ok, `${tag}: no window shift in Permissions`, JSON.stringify(shiftN))
    }
  }
} catch (e) {
  check(false, 'script ran to the end', e.stack ?? e.message)
  await shot('failure').catch(() => {})
} finally {
  await app.close().catch(() => {})
  fs.rmSync(base, { recursive: true, force: true })
  finish('engagement')
}
