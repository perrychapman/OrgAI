// Token-free (mock adapter, temp data dir). Team tab, Role pane "What it can use": tools edited in place, connections and
// skills granted from the scoped chooser (this role only), revoke, the node capability line, the "Needs sign in" path and
// the keyboard rules (Escape from the chooser returns focus to "+ Add"). Sections are named so later briefs (the Team
// assistant tray) can add their own below.
import { check, cleanup, createProject, endSession, finish, findProject, launch, log, makeFixtureRepo, openProject, openTeam, removeFixture, sleep, teamPanelTab } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E team (orgai test)'
const repo = makeFixtureRepo('team')
log('fixture at', repo)

const SIZES = [[1024, 640], [1600, 1000]]
const THEMES = ['dark', 'light']

/** Seed one skill and two connections (none granted to any role) straight through the main-process APIs. */
async function seed(page) {
  const project = await findProject(page, NAME)
  await page.evaluate(async (p) => {
    await window.orgai.skills.create({ projectId: p.id, draft: { name: 'review-checklist', description: 'Use when reviewing a change.', body: 'Check tests, naming and error handling.' } })
    const base = { transport: 'http', enabled: true, source: 'user', addedAt: new Date().toISOString(), roles: [] }
    await window.orgai.mcp.upsert({ projectId: p.id, spec: { ...base, id: 'e2e-docs', name: 'docs-server', url: 'https://example.invalid/mcp', description: 'Docs' } })
    await window.orgai.mcp.upsert({
      projectId: p.id,
      spec: { ...base, id: 'e2e-private', name: 'private-api', url: 'https://example.invalid/private', secretHeaders: ['Authorization'], description: 'Private' }
    })
  }, project)
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  await openProject(page, NAME)
  await openTeam(page)
}

/** A short window folds the Team assistant to its Ask bar: unfold the recommendations before driving them. */
async function expandAssistant(page) {
  const more = page.locator('[data-testid=team-assistant-more]')
  await more.waitFor({ timeout: 10_000 })
  if ((await more.getAttribute('aria-expanded')) === 'false') await more.click()
  await page.locator('[data-testid=team-recommend]').waitFor({ state: 'visible', timeout: 5000 })
}

async function selectReviewer(page) {
  await page.locator('.react-flow__node', { hasText: 'Reviewer' }).first().click()
  await teamPanelTab(page, 'Role').waitFor()
  await page.locator('[data-testid=role-capabilities]').waitFor({ timeout: 10_000 })
}

async function reviewer(page) {
  const p = await findProject(page, NAME)
  return { project: p, role: p.roles.find((r) => r.name === 'Reviewer') }
}

async function sectionBlock(page) {
  await selectReviewer(page)
  const block = page.locator('[data-testid=role-capabilities]')
  check((await block.locator('h3', { hasText: 'What it can use' }).count()) === 1, 'the block is titled "What it can use"')
  for (const id of ['role-tools', 'role-services', 'role-skills']) check((await block.locator(`[data-testid=${id}]`).count()) === 1, `the block has ${id}`)
  check(/^Can read files/.test((await block.locator('[data-testid=role-tools-summary]').innerText()).trim()), 'Tools shows a plain-language summary sentence', await block.locator('[data-testid=role-tools-summary]').innerText())
  check((await block.locator('[data-testid=role-add-connection]').count()) === 1, 'an empty Connections group offers "Add"')
  check((await block.locator('[data-testid=role-add-skill]').count()) === 1, 'an empty Skills group offers "Add"')
  check((await block.locator('[data-testid=role-ask-assistant]').count()) === 0, 'no "Ask the Team assistant" links in phase 2')
  // Spec 1.10: a new role's empty Connections and Skills each take one line.
  for (const id of ['role-add-connection', 'role-add-skill']) {
    const add = block.locator(`[data-testid=${id}]`)
    const lineH = await add.evaluate((el) => (el.closest('[data-testid=role-services], [data-testid=role-skills]') ?? el.parentElement).getBoundingClientRect().height)
    check(lineH <= 64, `the empty group of ${id} is about one line high`, String(lineH))
    check(/None yet/.test(await add.evaluate((el) => (el.closest('[data-testid=role-services], [data-testid=role-skills]') ?? el.parentElement).textContent ?? '')), `the empty group of ${id} says "None yet"`)
  }
  check(!/Manage in Tools|MCP/.test(await block.innerText()), 'the block never says "Manage in Tools" or "MCP"')
}

/** Spec 1.6 / 1.10: the role editor's order, Reports to, the placeholder Preview button, delegation and model wording. */
async function sectionEditor(page) {
  await selectReviewer(page)
  const pane = page.locator('.team-panel-pane')
  const order = await pane.evaluate((root) =>
    ['role-section-job', 'role-section-model', 'role-capabilities', 'role-section-does', 'role-section-delegate', 'role-section-who'].map((id) => {
      const el = root.querySelector(`[data-testid=${id}]`)
      return el ? el.getBoundingClientRect().top + root.scrollTop : null
    })
  )
  check(order.every((t) => t !== null) && order.every((t, i) => i === 0 || t > order[i - 1]), 'role editor order: What this role does, Model, What it can use, Instructions, Who it can delegate to, Who it is', JSON.stringify(order))
  const reports = page.locator('[data-testid=role-reports-to]')
  check((await reports.locator('option', { hasText: /Nobody/ }).count()) === 0, 'a non-root Reports to has no Nobody option')
  check(await reports.evaluate((el) => !!el.closest('[data-testid=role-section-who]')), 'Reports to is in Who it is')
  check(/What this role does/.test(await page.locator('[data-testid=role-section-job]').innerText()), 'the description is labelled "What this role does"')
  check(/Cannot edit files|Read files/.test(await page.locator('[data-testid=role-use-chips]').innerText()), 'What it can use shows chips for the tools')
  check(await page.locator('[data-testid=role-model-tiers] input[type=radio]').count() > 0 || (await page.locator('[data-testid=role-model-tiers]').count()) === 0, 'the Model section offers the tiers as one radio group')
  check(/reports to/i.test(await page.locator('[data-testid=role-subline]').innerText()), 'the panel header names the manager', await page.locator('[data-testid=role-subline]').innerText())
  // Review M7: the sub-line is never cut off (it wraps) and does not repeat the role's own name.
  const sub = await page.locator('[data-testid=role-subline]').evaluate((el) => ({ cut: el.scrollWidth > el.clientWidth + 1, text: el.textContent ?? '' }))
  const roleName = (await page.locator('.role-inspector .ri-heading h2').innerText()).trim()
  check(!sub.cut && !new RegExp(`^${roleName}\\b`).test(sub.text), 'the panel header sub-line is not truncated and does not repeat the name', JSON.stringify(sub))
  check((await page.locator('[data-testid=role-model-advanced] > summary').innerText()).trim() === 'Choose an exact model', 'the exact model controls sit behind "Choose an exact model"')
  check((await page.locator('[data-testid=role-section-count] [data-testid=role-concurrency]').count()) === 1, 'How many at once is in the panel (Role.maxConcurrent)')
  const preview = page.locator('[data-testid=role-preview-prompt]')
  check((await preview.getAttribute('aria-disabled')) === 'true' || (await preview.isDisabled()), '"Preview final prompt" is disabled')
  check(/Not available yet\./.test(await page.locator('[data-testid=role-section-does]').innerText({ timeout: 2000 }).catch(() => '')) || (await page.locator('#' + ((await preview.getAttribute('aria-describedby')) ?? 'x')).count()) === 1, '"Preview final prompt" explains "Not available yet."')
  // Model and effort: one sentence, one select; Staffing details closed with the renamed labels.
  check((await page.locator('[data-testid=role-model-sentence]').innerText()).trim().length > 0, 'Model and effort shows its sentence')
  await page.evaluate(() => { const d = document.querySelector('[data-testid=role-model-advanced]'); if (d && !d.open) d.open = true })
  const staffing = page.locator('[data-testid=role-staffing-fold]')
  check(!(await staffing.evaluate((d) => d.open)), 'Staffing details is closed by default')
  await staffing.evaluate((d) => { d.open = true })
  const tabText = await page.locator('.editor').innerText()
  check(!/Tier and effort|Follow the project|Lowest tier|Always as configured|May create subagents/.test(tabText), 'no retired wording remains on the tab')
  check(/How the model is chosen/.test(await staffing.innerText()), 'Staffing details uses the renamed labels')
  await staffing.evaluate((d) => { d.open = false })
  // Delegation on the root: direct reports with "Can delegate to it" and "Always involve"; other branches closed.
  const project = await findProject(page, NAME)
  const root = project.roles.find((r) => r.reportsTo === null)
  await page.locator(`.react-flow__node[data-id="${root.id}"]`).click()
  await teamPanelTab(page, 'Role').waitFor()
  check((await page.locator('[data-testid=role-reports-to-root]').count()) === 1, 'the root shows "Top of the team" instead of a select')
  const del = page.locator('[data-testid=role-section-delegate]')
  const dtext = await del.innerText()
  check(/Can delegate to it/.test(dtext) && /Always involve/.test(dtext), 'direct reports show "Can delegate to it" and "Always involve"', dtext)
  const other = page.locator('[data-testid=role-delegate-other]')
  if ((await other.count()) > 0) {
    check(!(await other.evaluate((d) => d.open)), '"Roles on other branches" is closed by default')
    await other.locator('summary').focus()
    await page.keyboard.press('Space')
    await sleep(150)
    check(await other.evaluate((d) => d.open), 'Space opens "Roles on other branches"')
    check(/Delegating across branches skips the roles in between/.test(await other.innerText()), 'the other-branches warning is shown when opened')
    await page.keyboard.press('Space')
  }
}

/** Delegation enforcement 4.1, 6: a "Required" checkbox per spawnable report, persisted as Role.requiredReports. */
async function sectionRequiredReports(page) {
  const project = await findProject(page, NAME)
  const lead = project.roles.find((r) => r.canSpawn && r.spawnable.length > 0)
  if (!lead) {
    log('SKIP required reports: no role can delegate')
    return
  }
  const reportId = lead.spawnable[0]
  const report = project.roles.find((r) => r.id === reportId)
  await page.locator('.react-flow__node', { hasText: lead.name }).first().click()
  await teamPanelTab(page, 'Role').waitFor()
  const box = page.locator(`[data-testid=role-required-report-${report.slug}]`)
  await box.waitFor({ state: 'attached', timeout: 10_000 })
  check(await box.isEnabled(), 'the Required checkbox is enabled for a spawnable report')
  check(!(await box.isChecked()), 'a report is not required by default')
  await box.check({ force: true })
  let saved
  for (let i = 0; i < 30 && !saved?.requiredReports?.includes(reportId); i++) {
    saved = (await findProject(page, NAME)).roles.find((r) => r.id === lead.id)
    if (!saved?.requiredReports?.includes(reportId)) await sleep(200)
  }
  check(saved?.requiredReports?.includes(reportId) === true, 'ticking Required saves requiredReports on the role', JSON.stringify(saved?.requiredReports))
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  await openProject(page, NAME)
  await openTeam(page)
  await page.locator('.react-flow__node', { hasText: lead.name }).first().click()
  await teamPanelTab(page, 'Role').waitFor()
  const again = page.locator(`[data-testid=role-required-report-${report.slug}]`)
  await again.waitFor({ state: 'attached', timeout: 10_000 })
  check(await again.isChecked(), 'the Required checkbox persists after a reload')
  await again.uncheck({ force: true })
  for (let i = 0; i < 30 && saved?.requiredReports; i++) {
    saved = (await findProject(page, NAME)).roles.find((r) => r.id === lead.id)
    if (saved?.requiredReports) await sleep(200)
  }
  check(!saved?.requiredReports, 'unticking Required clears requiredReports', JSON.stringify(saved?.requiredReports))
}

/** Open the role model fold and its Advanced details, re-opening them if a re-render (project.updated) remounts the panel, until Exact model is visible. */
async function openAdvancedModel(page) {
  await page.waitForFunction(
    () => {
      const fold = document.querySelector('[data-testid=role-section-model]')
      if (fold && !fold.open) fold.open = true
      const adv = document.querySelector('[data-testid=role-model-advanced]')
      if (adv && !adv.open) adv.open = true
      const sel = document.querySelector('[data-testid=role-exact-model]')
      return !!sel && sel.getClientRects().length > 0
    },
    undefined,
    { timeout: 20_000, polling: 100 }
  )
}

/**
 * UI overhaul: the panel's "Every change must pass this role before merging" box is the manager's requiredReports entry
 * (the same fact as the manager's "Always involve"), and the tray's Ask the Architect bar is a labelled input with an Ask
 * button that stays disabled until something is typed. Nothing is submitted (that would start a session).
 */
async function sectionPanelAndAskBar(page) {
  await selectReviewer(page)
  const project = await findProject(page, NAME)
  const rev = project.roles.find((r) => r.name === 'Reviewer')
  const manager = project.roles.find((r) => r.id === rev.reportsTo)
  const box = page.locator('[data-testid=role-must-pass]')
  if (manager.canSpawn && manager.spawnable.includes(rev.id)) {
    await box.waitFor({ state: 'attached', timeout: 10_000 })
    const before = await box.isChecked()
    await box.setChecked(!before, { force: true })
    let saved
    for (let i = 0; i < 30 && (saved?.requiredReports ?? []).includes(rev.id) === before; i++) {
      saved = (await findProject(page, NAME)).roles.find((r) => r.id === manager.id)
      if ((saved?.requiredReports ?? []).includes(rev.id) === before) await sleep(200)
    }
    check((saved?.requiredReports ?? []).includes(rev.id) === !before, 'the panel checkbox patches the manager requiredReports', JSON.stringify(saved?.requiredReports))
    await box.setChecked(before, { force: true })
    await sleep(500)
  } else {
    check((await box.count()) === 0, 'no must-pass box when the manager cannot delegate to the role')
  }
  const root = project.roles.find((r) => r.reportsTo === null)
  await page.locator(`.react-flow__node[data-id="${root.id}"]`).click()
  await teamPanelTab(page, 'Role').waitFor()
  check((await page.locator('[data-testid=role-must-pass]').count()) === 0, 'the root has no must-pass box')
  check(/Leads the team/.test(await page.locator('[data-testid=role-subline]').innerText()), 'the root header says "Leads the team"')
  const ask = page.getByRole('textbox', { name: 'Ask the Architect' })
  check((await ask.count()) === 1, 'the tray has a labelled "Ask the Architect" input')
  check(/add someone who writes docs/.test((await ask.getAttribute('placeholder')) ?? ''), 'the Ask input carries the example placeholder')
  const send = page.locator('[data-testid=team-ask-send]')
  check(await send.isDisabled(), 'Ask is disabled while the input is empty')
  await ask.fill('add someone who writes docs')
  check(await send.isEnabled(), 'Ask is enabled once there is text')
  await ask.fill('')
}

/** ux-review-config-2 N3: a tier role's Exact model reads Not set; Not set on a custom role returns Model to a tier, never Inherit. */
async function sectionExactModel(page) {
  await selectReviewer(page)
  const roleSel = page.locator('[data-testid=role-model]')
  const exactSel = page.locator('[data-testid=role-exact-model]')
  await roleSel.waitFor({ state: 'attached', timeout: 10_000 })
  if (await roleSel.isDisabled()) {
    log('SKIP Exact model checks: no connection connected')
    return
  }
  await openAdvancedModel(page)
  const start = await roleSel.inputValue()
  if (/^(top|deep|everyday|fast)$/.test(start)) check((await exactSel.inputValue()) === '', `a ${start} role's Exact model reads Not set`, await exactSel.inputValue())
  const ids = await exactSel.locator('option:not([disabled])').evaluateAll((os) => os.map((o) => o.value).filter(Boolean))
  let custom = false
  for (const v of ids) {
    await exactSel.selectOption(v)
    await sleep(250)
    if ((await roleSel.inputValue()) === 'custom') {
      custom = true
      break
    }
  }
  check(custom, 'a catalog id outside the tiers makes the role Custom', ids.join(', '))
  if (custom) {
    check((await exactSel.inputValue()) !== '', 'a custom role shows its pinned id in Exact model')
    await exactSel.selectOption('')
    await sleep(400)
    const back = await roleSel.inputValue()
    check(back !== 'inherit' && back !== 'custom', 'Not set on a custom role returns Model to a tier, not Inherit', back)
    check((await exactSel.inputValue()) === '', 'Exact model reads Not set again')
  }
  if (start !== 'custom') {
    await openAdvancedModel(page)
    await roleSel.selectOption(start).catch(() => {})
  }
  await sleep(300)
  await page.evaluate(() => {
    const d = document.querySelector('[data-testid=role-model-advanced]')
    if (d) d.open = false
  })
}

/**
 * A project on a mixed-family proxy: the Exact model select sits in the main role panel (not under Advanced), grouped
 * Claude / GPT / Other with the family in each option, and a GPT model is selectable. The project is moved back and the
 * proxy removed afterwards. Checked at both sizes and themes.
 */
async function sectionProxyExactModel(page, app, shot) {
  const NAME_PX = 'E2E gateway'
  const project = await findProject(page, NAME)
  const proxyId = await page.evaluate(async (name) => {
    const made = await window.orgai.connections.createProxy({ name, anthropicBaseUrl: 'https://mock-proxy.example.com', apiKey: 'whatever' })
    await window.orgai.connections.connect(made.connection.id)
    return made.connection.id
  }, NAME_PX)
  try {
    // A role edit from the earlier sections is saved 350 ms after the last change (the save indicator reads "Saving…"
    // until then); remapping first would let that stale copy overwrite the project's new connection.
    await page.waitForSelector('[data-testid=save-indicator].is-saving', { state: 'detached', timeout: 10_000 })
    await page.evaluate(([pid, id]) => window.orgai.projects.remapModels({ projectId: pid, connection: id }), [project.id, proxyId])
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 30_000 })
    await openProject(page, NAME)
    await openTeam(page)
    await selectReviewer(page)
    await openAdvancedModel(page)
    const exactSel = page.locator('[data-testid=role-exact-model]')
    await exactSel.waitFor({ state: 'visible', timeout: 20_000 })
    check(await exactSel.evaluate((el) => !!el.closest('[data-testid=role-model-advanced]')), 'on a proxy project Exact model is in the "Choose an exact model" reveal beside Model')
    for (const [w, h] of SIZES) {
      await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
      await sleep(500)
      for (const theme of THEMES) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await sleep(250)
        const tag = `at ${w}x${h} ${theme}`
        check(await exactSel.isVisible(), `Exact model is visible ${tag}`)
        const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
        check(m.sw <= m.cw, `no horizontal scroll with the proxy picker ${tag}`, JSON.stringify(m))
        await shot(`proxy-exact-${w}x${h}-${theme}`)
      }
    }
    const groups = await exactSel.evaluate((s) => [...s.querySelectorAll('optgroup')].map((g) => ({ label: g.label, options: [...g.querySelectorAll('option')].map((o) => o.textContent ?? '') })))
    check(groups.map((g) => g.label).join() === 'Claude,GPT,Other', 'Exact model is grouped Claude, GPT, Other', groups.map((g) => g.label).join())
    check(groups.every((g) => g.options.every((o) => o.endsWith(` · ${g.label}`))), 'each option names its family', JSON.stringify(groups))
    check(/Any model E2E gateway serves\./.test(await page.locator('.model-select', { has: exactSel }).innerText()), 'the description names the proxy by its own name')
    await exactSel.selectOption('gpt-6-sol')
    await sleep(900)
    const after = await reviewer(page)
    check(after.role.model === 'gpt-6-sol', 'picking a GPT model pins it on the role', after.role.model)
    check((await page.locator('[data-testid=role-model]').inputValue()) === 'custom', 'the Model select reads as an exact model')
    const chip = await page.locator('.react-flow__node', { hasText: 'Reviewer' }).first().innerText()
    check(/gpt-6-sol/.test(chip), 'the org chart node shows the GPT model', chip)
    await exactSel.selectOption('')
    await sleep(600)
  } finally {
    await page.evaluate(
      async ([pid, id]) => {
        await window.orgai.projects.remapModels({ projectId: pid, connection: 'anthropic' }).catch(() => {})
        await window.orgai.connections.removeProxy(id).catch(() => {})
      },
      [project.id, proxyId]
    )
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 30_000 })
    await openProject(page, NAME)
    await openTeam(page)
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  }
}

async function sectionTools(page) {
  const block = page.locator('[data-testid=role-capabilities]')
  const before = (await reviewer(page)).role.tools
  await block.locator('[data-testid=role-edit-tools]').click()
  // Spec 1.6: five plain-language groups, raw names beside each; the per-tool grid under "Choose individual tools".
  for (const g of ['read', 'change', 'run', 'web', 'plan']) check((await block.locator(`[data-testid=role-tool-group-${g}]`).count()) === 1, `the tools editor has the ${g} group`)
  const individual = block.locator('[data-testid=role-tools-individual]')
  check(!(await individual.evaluate((d) => d.open)), '"Choose individual tools" is closed by default')
  // Space toggles a native disclosure inside the Team page (React Flow's pan key no longer swallows it).
  await individual.locator('summary').focus()
  await page.keyboard.press('Space')
  await sleep(150)
  check(await individual.evaluate((d) => d.open), 'Space on a <summary> in the role editor opens the disclosure')
  check((await individual.locator('[data-testid^=role-tool-]:not([data-testid^=role-tool-group-])').count()) === 12, '"Choose individual tools" lists all 12 tools', String(await individual.locator('[data-testid^=role-tool-]:not([data-testid^=role-tool-group-])').count()))
  await page.keyboard.press('Space')
  await sleep(150)
  check(!(await individual.evaluate((d) => d.open)), 'Space on the <summary> closes it again')
  const run = block.locator('[data-testid=role-tool-group-run]')
  const want = !before.includes('Bash')
  await run.setChecked(want)
  await sleep(1200)
  const after = (await reviewer(page)).role.tools
  check(after.includes('Bash') === want, 'ticking "Run commands" saves Bash on the role', after.join(','))
  if (want) {
    await block.locator('[data-testid=role-edit-tools]').click()
    const summary = block.locator('[data-testid=role-tools-summary]')
    const text = (await summary.innerText()).replace(/\s+/g, ' ').trim()
    check(/run commands/.test(text), 'the collapsed summary names "run commands"', text)
    check((await summary.locator('svg').count()) >= 1, 'the elevated phrase has an icon beside its words')
    await block.locator('[data-testid=role-edit-tools]').click()
  }
  await run.setChecked(!want)
  await block.locator('[data-testid=role-edit-tools]').click()
  await sleep(1200)
}

async function sectionSkills(page) {
  const block = page.locator('[data-testid=role-capabilities]')
  const addBtn = block.locator('[data-testid=role-add-skill]')
  await addBtn.focus()
  await addBtn.click()
  const dlg = page.locator('[data-testid=capability-chooser]')
  await dlg.waitFor({ timeout: 5000 })
  check(await dlg.getByRole('tab', { name: 'Your library' }).isVisible(), 'the skill chooser has Your library')
  check(await dlg.getByRole('tab', { name: 'Found in this repo' }).isVisible(), 'the skill chooser has Found in this repo')
  await page.keyboard.press('Escape')
  await dlg.waitFor({ state: 'detached', timeout: 5000 })
  await sleep(100)
  check(await addBtn.evaluate((el) => el === document.activeElement), 'Escape from the chooser returns focus to "+ Add"', await page.evaluate(() => `${document.activeElement?.tagName} ${document.activeElement?.getAttribute('data-testid') ?? ''} ${document.activeElement?.className ?? ''}`))

  await addBtn.click()
  await dlg.waitFor({ timeout: 5000 })
  await dlg.locator('[data-testid=capability-chooser-item][data-name=review-checklist]').click()
  await dlg.waitFor({ state: 'detached', timeout: 5000 })
  const row = block.locator('[data-testid=role-skill][data-name=review-checklist]')
  await row.waitFor({ timeout: 5000 })
  check(await row.evaluate((el) => el === document.activeElement), 'after an add, focus lands on the added skill row')
  await sleep(1200)
  const { project, role } = await reviewer(page)
  const sk = project.skills.find((s) => s.name === 'review-checklist')
  check(role.skills?.includes(sk.id), 'the skill is granted to Reviewer')
  check(project.roles.filter((r) => r.id !== role.id).every((r) => !(r.skills ?? []).includes(sk.id)), 'no other role got the skill (least privilege)')
  const nodeLine = await page.locator('.react-flow__node', { hasText: 'Reviewer' }).first().locator('[data-testid=role-node-caps]').innerText()
  check(/1\s*skill/.test(nodeLine) || /1/.test(nodeLine), 'the node capability line counts the skill', nodeLine)

  await row.locator('[data-testid=role-skill-remove]').click()
  await row.waitFor({ state: 'detached', timeout: 5000 })
  await sleep(1200)
  check(!((await reviewer(page)).role.skills ?? []).includes(sk.id), 'removing the skill revokes it for Reviewer')
}

async function sectionConnections(page, shot) {
  const block = page.locator('[data-testid=role-capabilities]')
  const addBtn = block.locator('[data-testid=role-add-connection]')
  await addBtn.click()
  const dlg = page.locator('[data-testid=capability-chooser]')
  await dlg.waitFor({ timeout: 5000 })
  check(await dlg.getByRole('tab', { name: 'Browse' }).isVisible(), 'the connection chooser has Browse')
  await dlg.locator('[data-testid=capability-chooser-item][data-name=docs-server]').waitFor({ timeout: 10_000 })
  await shot('chooser')
  await dlg.locator('[data-testid=capability-chooser-item][data-name=docs-server]').click()
  await dlg.waitFor({ state: 'detached', timeout: 5000 })
  const row = block.locator('[data-testid=role-service][data-name=docs-server]')
  await row.waitFor({ timeout: 10_000 })
  check(await row.evaluate((el) => el === document.activeElement), 'after an add, focus lands on the added connection row')
  const { project, role } = await reviewer(page)
  const spec = project.mcpServers.find((s) => s.id === 'e2e-docs')
  check(spec.roles.includes(role.slug) && spec.roles.length === 1, 'the connection is granted to Reviewer only', JSON.stringify(spec.roles))
  check((await block.locator('[data-testid=role-needs-signin]').count()) === 0, 'a connection with nothing missing has no "Needs sign in" badge')

  // The one that needs a secret shows the badge and a way to App settings.
  await block.locator('[data-testid=role-add-connection]').click()
  await dlg.waitFor({ timeout: 5000 })
  await dlg.locator('[data-testid=capability-chooser-item][data-name=private-api]').click()
  await dlg.waitFor({ state: 'detached', timeout: 5000 })
  const priv = block.locator('[data-testid=role-service][data-name=private-api]')
  await priv.waitFor({ timeout: 10_000 })
  check((await priv.locator('[data-testid=role-needs-signin]').count()) === 1, 'a connection missing a secret shows "Needs sign in"')
  await priv.locator('[data-testid=role-signin]').waitFor()
  await shot('role-connections')
  check(true, 'the badge has a Sign in button')

  const nodeLine = await page.locator('.react-flow__node', { hasText: 'Reviewer' }).first().locator('[data-testid=role-node-caps]').innerText()
  check(/2/.test(nodeLine), 'the node capability line counts connections', nodeLine)

  // Revoke both; the explicit lists drop only Reviewer.
  await priv.locator('[data-testid=role-connection-remove]').click()
  await priv.waitFor({ state: 'detached', timeout: 5000 })
  await row.locator('[data-testid=role-connection-remove]').click()
  await row.waitFor({ state: 'detached', timeout: 5000 })
  const after = (await reviewer(page)).project.mcpServers.find((s) => s.id === 'e2e-docs')
  check(!after.roles.includes('reviewer'), 'removing a connection revokes it for Reviewer')
  check(await block.locator('[data-testid=role-add-connection]').evaluate((el) => el === document.activeElement), 'after a revoke, focus returns to "+ Add"')
}

async function sectionAssistant(page, shot) {
  const tray = page.locator('[data-testid=team-assistant]')
  await tray.waitFor({ timeout: 10_000 })
  await expandAssistant(page)
  check((await page.locator('[data-testid=architect-open]').count()) === 0, 'the tray has no Design tab (the Architect is in Start from)')
  check((await page.locator('[data-testid=org-change-start]').count()) === 0, 'no Architect form is mounted until the dialog opens')
  check((await tray.locator('[data-testid=team-include-outside]').count()) === 1, 'the outside-sources opt-in is present')
  check(!(await tray.locator('[data-testid=team-include-outside]').isChecked()), 'outside sources are off by default')
  check((await tray.locator('[data-testid=team-scope] select').count()) === 1, 'the scope chip is present')
  // Outside sources (the mock registry) are opt-in; the local candidates come first either way.
  await tray.locator('[data-testid=team-include-outside]').check()
  await tray.locator('[data-testid=team-scope] select').selectOption('team')
  await tray.locator('[data-testid=team-recommend]').click()
  const cards = tray.locator('[data-testid=capability-card]')
  await cards.first().waitFor({ timeout: 20_000 })
  const n = await cards.count()
  check(n >= 1, 'Recommend shows at least one card', String(n))
  check((await cards.first().locator('[data-testid=capability-source]').innerText()).trim().length > 0, 'a card has a source badge')
  check((await tray.locator('[data-testid=capability-needs]', { hasText: 'GITHUB_TOKEN' }).count()) >= 1, 'a card flags "Needs: GITHUB_TOKEN"')
  check(/\bread\b|can load|can use/i.test(await cards.first().locator('[data-testid=capability-access]').innerText()), 'the access sentence is plain')
  // The full command is what the user approves: wrapped and scrollable, never clamped, with the runs-code badge beside it.
  const cmd = tray.locator('[data-testid=capability-card][data-kind=mcp] [data-testid=capability-command]').first()
  if ((await cmd.count()) > 0) {
    const code = cmd.locator('code')
    const style = await code.evaluate((el) => {
      const c = getComputedStyle(el)
      return { overflow: c.textOverflow, ws: c.whiteSpace, oy: c.overflowY }
    })
    check(style.overflow !== 'ellipsis' && style.ws !== 'nowrap', 'the command is wrapped, not clamped', JSON.stringify(style))
    check(!/\u2026|\.\.\.$/.test((await code.innerText()).trim()), 'the command text is not truncated with an ellipsis')
    const card0 = tray.locator('[data-testid=capability-card][data-kind=mcp]').first()
    if ((await card0.locator('[data-testid=capability-runs-code]').count()) > 0) {
      check((await cmd.locator('[data-testid=capability-runs-code]').count()) === 1, 'the runs-code badge sits beside the command')
    }
    check(/can use/.test(await card0.locator('[data-testid=capability-access]').innerText()), 'a plain connection says "can use", not read or change')
  }
  await shot('assistant-results')
  log('cards', JSON.stringify(await cards.evaluateAll((els) => els.map((e) => [e.dataset.kind, e.dataset.origin, e.dataset.name]))))

  // Apply a skill to the roles it names; the role block shows it; Undo restores.
  // (The mock now also recommends the local code-review skill, so target the local connection by kind.)
  const card = tray.locator("[data-testid=capability-card][data-kind=mcp][data-origin=local]").first()
  if ((await card.count()) > 0) {
    const name = await card.getAttribute('data-name')
    await card.locator('[data-testid=capability-apply]').click()
    const applied = tray.locator('[data-testid=capability-applied]').first()
    await applied.waitFor({ timeout: 10_000 })
    check(await applied.locator('[data-testid=capability-undo]').evaluate((el) => el === document.activeElement), 'after Apply, focus lands on Undo')
    let p = await findProject(page, NAME)
    const spec = p.mcpServers.find((s) => s.name === name)
    check(!!spec && Array.isArray(spec.roles) && spec.roles.length > 0 && spec.roles.length < p.roles.length, 'applying grants it to the named roles only', JSON.stringify(spec?.roles))
    check(/stays off/.test(await applied.innerText()), 'a connection that still needs a secret says it stays off')
    await applied.locator('[data-testid=capability-undo]').click()
    await tray.locator('[data-testid=capability-applied]').waitFor({ state: 'detached', timeout: 10_000 })
    p = await findProject(page, NAME)
    check(!p.mcpServers.some((s) => s.name === name), 'Undo removes it again')
    check((await tray.locator(`[data-testid=capability-card][data-name="${name}"]`).count()) === 1, 'the card comes back after Undo')
  } else {
    check(false, 'the mock offers a local card')
  }

  // Dismiss hides a card and it does not come back on a re-check.
  const before = await cards.count()
  const dname = await cards.first().getAttribute('data-name')
  await cards.first().locator('[data-testid=capability-dismiss]').click()
  await sleep(500)
  check((await cards.count()) === before - 1, 'Dismiss hides the card')
  await tray.locator('[data-testid=team-recheck]').click()
  await page.waitForFunction(() => document.querySelector('[data-testid=team-recommend-pane]')?.getAttribute('data-phase') === 'idle', null, { timeout: 20_000 })
  check((await tray.locator(`[data-testid=capability-card][data-name="${dname}"]`).count()) === 0, 'a dismissed card does not return after Re-check setup')

  // Design mode (the Architect session is an ordinary run in Live) is covered by sectionDesignDecisions and
  // e2e/org-change.mjs; starting one here would end a run before sectionDismiss, which changes its dismissed list.
}

async function startOrgChange(page) {
  // Spec 1.3: the Architect is reached from Start from > Redesign with the Architect.
  await page.locator('[data-testid=team-start-from]').click()
  await page.locator('[data-testid=start-from-architect]').click()
  const dlg = page.locator('[data-testid=architect-dialog]')
  await dlg.waitFor({ timeout: 5000 })
  await dlg.locator('textarea').first().fill('Add a database specialist.')
  await dlg.locator('[data-testid=org-change-start]').click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
}

/** The Architect's permission card shows in the Live tray; the Needs-you pill brings the user back to it from Team. */
async function sectionDesignDecisions(page, shot) {
  const tray = page.locator('[data-testid=team-assistant]')
  await startOrgChange(page)
  check((await page.locator('[data-testid=tab-live]').getAttribute('aria-selected')) === 'true', 'the org change session opens in Live')
  check((await page.locator('.run-tab').count()) >= 1, 'the org change session has its own run tab')
  const card = page.locator('.frame-tray .decision-card').first()
  await card.waitFor({ timeout: 20_000 }).catch(() => {})
  check((await card.count()) === 1 && (await card.isVisible()), 'the Architect permission card shows in the Live tray')
  check(!/R\?/.test(await page.locator('.frame-tray').innerText()), 'the Architect card is not labelled R?')
  await shot('design-permission')
  await openTeam(page)
  check((await tray.locator('[data-testid=org-change-pointer]').count()) === 1, 'the Team tray points at the open session')
  check(/is open/.test(await page.locator('[data-testid=team-notice-row]').innerText()), 'the notice row says the Architect session is open', await page.locator('[data-testid=team-notice-row]').innerText())
  await page.locator('[data-testid=topbar-needs-you]').click()
  await page.locator('.frame-tray .decision-card').first().waitFor({ timeout: 5_000 })
  check((await page.locator('[data-testid=tab-live]').getAttribute('aria-selected')) === 'true', 'the Needs-you pill lands on the Architect card in Live')
  await endSession(page)
  await openTeam(page)
}

/**
 * Walk 3 N3: the first connection for a role with nothing to pick opens the service picker straight away, and the token
 * dialog's success grants that role only (node, + Add, GitHub, token, Add token). N1: with the token cleared, the role
 * row's Sign in lands on the highlighted GitHub tile and "Back to Team" returns to Team with Reviewer selected.
 */
async function sectionFirstConnection(page, shot) {
  await selectReviewer(page)
  const block = page.locator('[data-testid=role-capabilities]')
  await block.locator('[data-testid=role-add-connection]').click()
  const add = page.locator('[data-testid=add-service-dialog]')
  await add.waitFor({ timeout: 10_000 })
  check((await page.locator('[data-testid=capability-chooser]:visible').count()) === 0, 'with nothing to pick, + Add opens the service picker directly')
  // Walk 4 S3: the picker names the role that gets the service.
  const addHead = await add.locator('.dialog-head').innerText()
  check(/Add a service for Reviewer/.test(addHead) && /Only Reviewer gets it/.test(addHead), 'Add a service names the role', addHead)
  await add.locator('[data-testid=add-service-option][data-connector=github]').click()
  const dlg = page.locator('[data-testid=connector-dialog]')
  await dlg.waitFor({ timeout: 10_000 })
  // Walk 4 S2: the token dialog opens on its token field, not on Close dialog.
  await sleep(200)
  check(await dlg.getByLabel('Personal access token', { exact: true }).evaluate((el) => el === document.activeElement), 'the token dialog focuses the token field')
  await dlg.getByLabel('Personal access token', { exact: true }).fill('ghp_e2e_fake_token')
  await shot('first-connection-token')
  await dlg.locator('[data-testid=connector-connect]').click()
  await page.waitForFunction(
    () => !document.querySelector('[data-testid=connector-dialog], [data-testid=add-service-dialog], [data-testid=connector-use-dialog]'),
    null,
    { timeout: 15_000 }
  )
  check(true, 'after Add token every dialog closes (at most 2 dialogs on the path)')
  await sleep(800)
  const { project, role } = await reviewer(page)
  const gh = project.mcpServers.find((s) => s.connectorId === 'github' || /github/i.test(s.name))
  check(!!gh && Array.isArray(gh.roles) && gh.roles.length === 1 && gh.roles[0] === role.slug, 'GitHub is granted to Reviewer only', JSON.stringify(gh?.roles))
  const ghRow = block.locator(`[data-testid=role-service][data-cap-id="${gh?.id}"]`)
  await ghRow.waitFor({ timeout: 10_000 })

  // N1: clear the token; the role row's Sign in goes to the tile, and Back returns to Team with Reviewer selected.
  await page.evaluate(() => window.orgai.connectors.setToken({ connectorId: 'github', token: null }))
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  await openProject(page, NAME)
  await openTeam(page)
  await selectReviewer(page)
  const signin = ghRow.locator('[data-testid=role-signin]')
  await signin.waitFor({ timeout: 10_000 })
  await signin.click()
  const tile = page.locator('[data-testid=connector-tile][data-connector=github]')
  await tile.waitFor({ timeout: 10_000 })
  await sleep(600)
  check((await tile.getAttribute('data-highlight')) !== null, 'role-row Sign in highlights the GitHub tile')
  check(await tile.evaluate((el) => el.contains(document.activeElement)), 'role-row Sign in focuses the tile action')
  const inView = await tile.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return r.top >= 0 && r.bottom <= window.innerHeight
  })
  check(inView, 'the GitHub tile is in view')
  await shot('signin-tile')
  const back = page.locator('[data-testid=back-to-team]')
  check(await back.isVisible(), 'App settings offers Back to Team')
  await back.click()
  await page.locator('.editor [data-testid=team-panel-tabs]').waitFor({ timeout: 10_000 })
  check((await page.locator('[data-testid=tab-team]').getAttribute('aria-selected')) === 'true', 'Back to Team lands on the Team tab')
  check(/Reviewer/.test(await page.locator('.react-flow__node.selected').first().innerText().catch(() => '')), 'Back to Team keeps Reviewer selected')

  // M1: GitHub is still in the project and needs sign in again; Reviewer lost it. + Add -> sign in -> Reviewer is granted
  // through mcp.upsert (linkLibrary would refuse "already linked").
  await page.evaluate(([pid, spec]) => window.orgai.mcp.upsert({ projectId: pid, spec: { ...spec, roles: [] } }), [project.id, gh.spec ?? gh])
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  await openProject(page, NAME)
  await openTeam(page)
  await selectReviewer(page)
  await block.locator('[data-testid=role-add-connection]').click()
  const chooser = page.locator('[data-testid=capability-chooser]:visible')
  if ((await chooser.count()) > 0) {
    await chooser.getByRole('tab', { name: 'Browse' }).click()
    await chooser.locator('[data-testid=chooser-open-gallery]').click()
  }
  const add2 = page.locator('[data-testid=add-service-dialog]')
  await add2.waitFor({ timeout: 10_000 })
  await add2.locator('[data-testid=add-service-option][data-connector=github]').click()
  const dlg2 = page.locator('[data-testid=connector-dialog]')
  await dlg2.waitFor({ timeout: 10_000 })
  await dlg2.getByLabel('Personal access token', { exact: true }).fill('ghp_e2e_fake_token_2')
  await dlg2.locator('[data-testid=connector-connect]').click()
  await page.waitForFunction(
    () => !document.querySelector('[data-testid=connector-dialog], [data-testid=add-service-dialog], [data-testid=connector-use-dialog]'),
    null,
    { timeout: 15_000 }
  )
  await sleep(800)
  const again = await reviewer(page)
  const gh2 = again.project.mcpServers.find((s) => s.id === gh.id)
  check(!!gh2 && gh2.roles?.includes(again.role.slug), 'a linked service that needed sign in again is granted to Reviewer', JSON.stringify(gh2?.roles))
  check(again.project.mcpServers.filter((s) => s.id === gh.id).length === 1, 'still one GitHub server in the project')

  // Leave the later sections a project without GitHub.
  if (gh) await page.evaluate(([pid, id]) => window.orgai.mcp.remove({ projectId: pid, serverId: id }).catch(() => {}), [project.id, gh.id])
}

/** Walk 3 N2 + N7: the skill chooser lands focus on the selected tab, arrows move it, and "On this computer" grants code-review. */
async function sectionLocalSkill(page) {
  const block = page.locator('[data-testid=role-capabilities]')
  await block.locator('[data-testid=role-add-skill]').click()
  const dlg = page.locator('[data-testid=capability-chooser]')
  await dlg.waitFor({ timeout: 5000 })
  await dlg.locator('[data-tab-ready=true]').waitFor({ timeout: 15_000 })
  await sleep(300)
  check(
    await page.evaluate(() => document.activeElement?.getAttribute('role') === 'tab' && document.activeElement.getAttribute('aria-selected') === 'true'),
    'the chooser opens with focus on the selected tab'
  )
  // Walk 4 S1: it opens on the first tab that has something to add (never an empty This project).
  const opened = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
  const listed = await dlg.locator('[data-testid=capability-chooser-item]').count()
  check(listed > 0 || opened === 'chooser-tab-repo' || opened === 'chooser-tab-new', 'the skill chooser opens on a tab with items', `${opened} (${listed})`)
  const first = await page.evaluate(() => document.activeElement?.textContent)
  await page.keyboard.press('ArrowRight')
  const next = await page.evaluate(() => (document.activeElement?.getAttribute('aria-selected') === 'true' ? document.activeElement.textContent : null))
  check(!!next && next !== first, 'ArrowRight moves the selected chooser tab', `${first} -> ${next}`)
  await page.keyboard.press('Home')
  check((await page.evaluate(() => document.activeElement?.textContent)) === 'This project', 'Home goes to the first tab')
  await dlg.locator('[data-testid=chooser-tab-local]').click()
  const item = dlg.locator('[data-testid=capability-chooser-item][data-name=code-review]')
  await item.waitFor({ timeout: 15_000 })
  check(true, 'On this computer lists the local code-review skill')
  await item.click()
  await dlg.waitFor({ state: 'detached', timeout: 10_000 })
  const row = block.locator('[data-testid=role-skill][data-name=code-review]')
  await row.waitFor({ timeout: 10_000 })
  const { project, role } = await reviewer(page)
  const sk = project.skills.find((s) => s.name === 'code-review')
  check(!!sk && (role.skills ?? []).includes(sk.id), 'one click grants code-review to Reviewer')
  check(project.roles.filter((r) => r.id !== role.id).every((r) => !(r.skills ?? []).includes(sk?.id)), 'no other role got code-review')
  await row.locator('[data-testid=role-skill-remove]').click()
  await row.waitFor({ state: 'detached', timeout: 5000 })
  await sleep(800)
}

/** Walk 3 N9 + N10: elevated tools are named and marked; edges are not tab stops; the skip link reaches the panel. */
async function sectionRiskAndKeyboard(page) {
  const block = page.locator('[data-testid=role-capabilities]')
  const setBash = async (on) => {
    await block.locator('[data-testid=role-edit-tools]').click()
    await block.locator('[data-testid=role-tool-group-run]').setChecked(on)
    await block.locator('[data-testid=role-edit-tools]').click()
    await sleep(1200)
  }
  const had = (await reviewer(page)).role.tools.includes('Bash')
  if (!had) await setBash(true)
  check(/run commands/.test(await block.locator('[data-testid=role-tools-summary]').innerText()), 'the Tools summary says it can run commands')
  const node = page.locator('.react-flow__node', { hasText: 'Reviewer' }).first()
  check((await node.locator('[data-testid=role-node-elevated]').count()) === 1, 'the node shows the elevated-tools marker')
  if (!had) await setBash(false)
  check((await page.locator('.react-flow__edge[tabindex="0"]').count()) === 0, 'edges are not tab stops')
  await page.locator('[data-testid=skip-to-role-panel]').focus()
  await page.keyboard.press('Enter')
  await sleep(300)
  check(await page.evaluate(() => !!document.activeElement?.closest('[data-testid=team-panel-tabs]')), 'Skip to role panel moves focus to the panel tabs')
}

/** Walk 3 N4 + N12: the dismiss row with Undo, the announcement, the Dismissed list with Restore, the gap jump. */
async function sectionDismiss(page, shot, app) {
  const tray = page.locator('[data-testid=team-assistant]')
  // Walk 4 M1 is a short-tray problem: dismiss at 1024x640.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 640))
  await sleep(600)
  await expandAssistant(page)
  await tray.locator('[data-testid=team-scope] select').selectOption('team')
  await tray.locator('[data-testid=team-recommend]').click()
  await page.waitForFunction(() => document.querySelector('[data-testid=team-recommend-pane]')?.getAttribute('data-phase') === 'idle', null, { timeout: 20_000 })
  const cards = tray.locator('[data-testid=capability-card]')
  await cards.first().waitFor({ timeout: 20_000 })
  const name = await cards.first().getAttribute('data-name')
  await cards.first().locator('[data-testid=capability-dismiss]').click()
  const row = tray.locator('[data-testid=capability-dismissed]')
  await row.waitFor({ timeout: 5000 })
  check((await row.innerText()).includes(`Dismissed ${name}`), 'Dismiss leaves a "Dismissed <name>" row', await row.innerText())
  check(await row.locator('[data-testid=capability-dismiss-undo]').evaluate((el) => el === document.activeElement), 'focus lands on the row Undo')
  check((await page.locator('[data-testid=team-announce]').innerText()).includes(`Dismissed ${name}`), 'the live region names the dismissed item')
  await sleep(400)
  // Walk 4 M1: the row sits inside the tray's visible box (every scrolling ancestor and the window).
  const vis = await row.evaluate((el) => {
    const r = el.getBoundingClientRect()
    let box = { top: 0, bottom: window.innerHeight }
    for (let p = el.parentElement; p; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) {
        const b = p.getBoundingClientRect()
        box = { top: Math.max(box.top, b.top), bottom: Math.min(box.bottom, b.bottom) }
      }
    }
    return { top: r.top, bottom: r.bottom, boxTop: box.top, boxBottom: box.bottom }
  })
  check(vis.top >= vis.boxTop - 1 && vis.bottom <= vis.boxBottom + 1, 'the Dismissed row is inside the visible tray at 1024x640', JSON.stringify(vis))
  check(await tray.locator('[data-testid=team-results-head]').isVisible(), 'the results head stays after Dismiss')
  await shot('dismissed-row')
  await row.locator('[data-testid=capability-dismiss-undo]').click()
  await tray.locator(`[data-testid=capability-card][data-name="${name}"]`).waitFor({ timeout: 10_000 })
  check(/Restored/.test(await page.locator('[data-testid=team-announce]').innerText()), 'Undo announces the restore')
  await tray.locator(`[data-testid=capability-card][data-name="${name}"] [data-testid=capability-dismiss]`).click()
  await row.waitFor({ timeout: 5000 })
  const toggle = tray.locator('[data-testid=team-dismissed-toggle]')
  await toggle.waitFor({ timeout: 10_000 })
  check(/Dismissed \(\d+\)/.test(await toggle.innerText()), 'a Dismissed (n) disclosure appears', await toggle.innerText())
  await toggle.click()
  const item = tray.locator('[data-testid=team-dismissed-item]', { hasText: name })
  await item.first().waitFor({ timeout: 5000 })
  await item.first().locator('[data-testid=team-dismissed-restore]').click()
  await tray.locator(`[data-testid=capability-card][data-name="${name}"]`).waitFor({ timeout: 10_000 })
  check(true, 'Restore from the Dismissed list brings the card back')
  if ((await tray.locator('[data-testid=team-gaps-jump]').count()) > 0) {
    await tray.locator('[data-testid=team-gaps-jump]').click()
    await sleep(300)
    check(await page.evaluate(() => document.activeElement?.id === 'capability-gaps-title'), 'the gap link focuses the Gaps heading')
  }
}

/** The role node context menu (docs/design/context-menus.md row 9): right click, Shift+F10, Add a report, root guard. */
async function sectionNodeMenu(page) {
  const menu = page.locator('[data-testid=role-node-menu]')
  const node = page.locator('.react-flow__node', { hasText: 'Reviewer' }).first()
  const nodeFocused = () => node.evaluate((el) => el === document.activeElement)
  await node.click({ button: 'right' })
  await menu.waitFor({ timeout: 5000 })
  check((await menu.getAttribute('aria-label')) === 'Actions for Reviewer', 'the node menu is named for the role', await menu.getAttribute('aria-label'))
  check(
    (await menu.locator('[role=menuitem]').allInnerTexts()).map((t) => t.trim()).join('|') === 'Edit role|Add a report|Duplicate role|Remove role',
    'the node menu offers Edit role, Add a report, Duplicate role and Remove role'
  )
  check((await page.locator('[data-testid=role-menu-remove]').getAttribute('aria-disabled')) !== 'true', 'Remove role is enabled on a non-root role')
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached' })
  check(await nodeFocused(), 'Escape returns focus to the node')

  await node.focus()
  await page.keyboard.press('Shift+F10')
  await menu.waitFor({ timeout: 5000 })
  check(true, 'Shift+F10 on a focused node opens the menu')
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached' })

  const before = (await findProject(page, NAME)).roles
  await node.click({ button: 'right' })
  await menu.waitFor({ timeout: 5000 })
  await page.locator('[data-testid=role-menu-add-report]').click()
  // Spec 1.2: "Add a report" opens the Add role popover with that role as the parent.
  const pop = page.locator('[data-testid=add-role-popover]')
  await pop.waitFor({ timeout: 5000 })
  const reviewerId = before.find((r) => r.name === 'Reviewer')?.id
  check((await pop.locator('[data-testid=add-role-parent]').inputValue()) === reviewerId, 'Add a report pre-fills Reports to with that role')
  await pop.locator('[data-testid=add-role-name]').press('Enter')
  await pop.waitFor({ state: 'hidden', timeout: 5000 })
  await sleep(500)
  const after = (await findProject(page, NAME)).roles
  const added = after.filter((r) => !before.some((b) => b.id === r.id))
  check(added.length === 1 && added[0].reportsTo === reviewerId, 'Add a report adds a role reporting to that role', JSON.stringify(added.map((r) => r.reportsTo)))

  // UI overhaul (Team board): the selected role's toolbar. Duplicate adds "{name} copy" beside it; Undo takes it back.
  const reviewer = before.find((r) => r.name === 'Reviewer')
  await node.click()
  const toolbar = page.locator('[data-testid=role-node-toolbar] [role=toolbar]')
  await toolbar.waitFor({ timeout: 5000 })
  check((await toolbar.getAttribute('aria-label')) === 'Actions for Reviewer', 'the selected role shows its action toolbar', await toolbar.getAttribute('aria-label'))
  const beforeDup = (await findProject(page, NAME)).roles
  await page.locator('[data-testid=role-node-duplicate]').click()
  await sleep(500)
  const afterDup = (await findProject(page, NAME)).roles
  const copy = afterDup.find((r) => !beforeDup.some((b) => b.id === r.id))
  check(
    !!copy && copy.name === 'Reviewer copy' && copy.reportsTo === reviewer?.reportsTo && copy.prompt === reviewer?.prompt && copy.slug !== reviewer?.slug,
    'Duplicate adds "Reviewer copy" under the same manager with the same instructions and its own ID',
    JSON.stringify(copy && { name: copy.name, reportsTo: copy.reportsTo, slug: copy.slug })
  )
  // Review H1: the toolbar's click must not re-select the original; the copy is selected and its description has focus.
  const panelTitle = ((await page.locator('aside.side-panel .side-header h2').first().textContent()) ?? '').trim()
  const focusedDesc = await page.evaluate(() => document.activeElement?.id === 'role-description')
  check(panelTitle === 'Reviewer copy' && focusedDesc, 'after Duplicate the copy is selected and its description has focus', `${panelTitle} / ${focusedDesc}`)
  await page.locator('[data-testid=team-notice-undo]').click()
  await sleep(400)
  check((await findProject(page, NAME)).roles.length === beforeDup.length, 'Undo removes the duplicate')

  const rootName = before.find((r) => r.reportsTo === null)?.name
  await page.locator('.react-flow__node', { hasText: rootName }).first().click({ button: 'right' })
  await menu.waitFor({ timeout: 5000 })
  check((await page.locator('[data-testid=role-menu-remove]').getAttribute('aria-disabled')) === 'true', 'Remove role is aria-disabled on the root role')
  await page.keyboard.press('Escape')
}

/** Every node's rect and the stage rect, in viewport pixels. */
async function chartRects(page) {
  return page.evaluate(() => {
    const r = (el) => {
      const b = el.getBoundingClientRect()
      return { x: b.x, y: b.y, w: b.width, h: b.height }
    }
    const opt = (sel) => {
      const el = document.querySelector(sel)
      return el ? r(el) : null
    }
    return {
      stage: r(document.querySelector('.editor .frame-stage')),
      nodes: [...document.querySelectorAll('.editor .react-flow__node')].map((el) => ({ id: el.dataset.id, ...r(el) })),
      // QA S1: what floats over the stage's bottom corners.
      overlays: [opt('.editor .react-flow__controls'), opt('.editor .react-flow__minimap')].filter(Boolean)
    }
  })
}

/** QA S1: the node is clear of the zoom controls and the minimap. */
const clearOfOverlays = (node, rects) => !!node && rects.overlays.every((o) => !rectsOverlap(node, o))

const rectsOverlap = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5

/** Press on a node's source handle, drag over `toId`'s body in steps; leaves the button down unless `release`. */
async function dragReport(page, fromId, toId, { release = true } = {}) {
  const handle = await page.locator(`.react-flow__node[data-id="${fromId}"] .react-flow__handle.source`).boundingBox()
  const to = await page.locator(`.react-flow__node[data-id="${toId}"]`).boundingBox()
  const sx = handle.x + handle.width / 2
  const sy = handle.y + handle.height / 2
  const tx = to.x + to.width / 2
  const ty = to.y + to.height / 2
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  for (let i = 1; i <= 14; i++) await page.mouse.move(sx + ((tx - sx) * i) / 14, sy + ((ty - sy) * i) / 14)
  await sleep(150)
  if (release) await page.mouse.up()
}

/**
 * Team tab phase 1 (ux-review-team-tab-5 flows 2, 3, 9): the toolbar Add role always adds under the root and the note is
 * gone, new roles take free slots beside their siblings and come into view, a role dropped anywhere on another node
 * re-parents it (with a drop highlight) and a refused drop leaves no line and says why, and "leads N" counts delegable reports.
 */
async function sectionAddAndDrag(page, app, shot) {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [1440, 900])
  await sleep(600)
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  const toolbar = page.locator('.editor .frame-toolbar')
  const addBtn = page.locator('[data-testid=team-add-role]')
  const pop = page.locator('[data-testid=add-role-popover]')
  const rolesNow = async () => (await findProject(page, NAME)).roles
  const root = (await rolesNow()).find((r) => r.reportsTo === null)
  /** Header Add role: open the popover, optionally choose the parent, submit with Enter in the name field. */
  const add = {
    click: async (parentId) => {
      await addBtn.click()
      await pop.waitFor({ timeout: 5000 })
      if (parentId) await pop.locator('[data-testid=add-role-parent]').selectOption(parentId)
      await pop.locator('[data-testid=add-role-name]').press('Enter')
      await pop.waitFor({ state: 'hidden', timeout: 5000 })
    }
  }
  // The stage top and the notice row's box. (The stage bottom also follows the Team assistant tray, whose content changes
  // with the selection; that tray becomes a closed drawer in phase 3.)
  const stageEdges = () => page.evaluate(() => {
    const b = document.querySelector('.editor .frame-stage').getBoundingClientRect()
    const n = document.querySelector('[data-testid=team-notice-row]').getBoundingClientRect()
    return { top: Math.round(b.top), rowTop: Math.round(n.top), rowHeight: Math.round(n.height) }
  })

  // (1) Spec 1.2: one primary on the header, the popover's Name selected, Reports to the root with nothing selected and
  // the selected role otherwise; Enter adds under the chosen parent, selects it and focuses "What is this role for?".
  check((await toolbar.locator('.btn.primary').count()) === 1 && /Add role/.test(await toolbar.locator('.btn.primary').innerText()), 'Add role is the only primary button in the header')
  check((await toolbar.locator('.toolbar-note').count()) === 0 && !/New roles report to/.test(await toolbar.innerText()), 'the header has no "New roles report to" note')
  check(!/Canvas style|Templates|Import from other tools|Auto-layout/.test(await toolbar.innerText()), 'no Canvas style, Templates, Import or Auto-layout button in the header')
  await page.locator('.editor .react-flow__pane').click({ position: { x: 5, y: 5 } })
  await addBtn.click()
  await pop.waitFor({ timeout: 5000 })
  // The popover focuses and selects the Name in an effect after it mounts: wait for the focus, then read the selection once.
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'add-role-name', null, { timeout: 3000 }).catch(() => {})
  check(await pop.locator('[data-testid=add-role-name]').evaluate((el) => el === document.activeElement && el.selectionStart === 0 && el.selectionEnd === el.value.length && el.value.length > 0), 'the Name is selected when the popover opens')
  check((await pop.locator('[data-testid=add-role-parent]').inputValue()) === root.id, 'with nothing selected Reports to is the root')
  check((await pop.locator('[data-testid=add-role-parent] option', { hasText: /^Nobody/ }).count()) === 0, 'Reports to has no Nobody option')
  await page.keyboard.press('Escape')
  await pop.waitFor({ state: 'hidden', timeout: 5000 })
  check(await addBtn.evaluate((el) => el === document.activeElement), 'Escape returns focus to Add role')
  const implRole = (await rolesNow()).find((r) => r.name === 'Implementer')
  const revRole = (await rolesNow()).find((r) => r.name === 'Reviewer')
  await page.locator(`.react-flow__node[data-id="${implRole.id}"]`).click()
  await teamPanelTab(page, 'Role').waitFor()
  await addBtn.click()
  await pop.waitFor({ timeout: 5000 })
  check((await pop.locator('[data-testid=add-role-parent]').inputValue()) === implRole.id, 'with Implementer selected Reports to is Implementer')
  await pop.locator('[data-testid=add-role-parent]').selectOption(revRole.id)
  check(/^Reviewer will be able to/.test(await pop.locator('[data-testid=add-role-helper]').innerText()), 'the helper line follows the chosen parent', await pop.locator('[data-testid=add-role-helper]').innerText())
  const edgesBefore = await stageEdges()
  let before = await rolesNow()
  await pop.locator('[data-testid=add-role-name]').press('Enter')
  await pop.waitFor({ state: 'hidden', timeout: 5000 })
  await sleep(700)
  let after = await rolesNow()
  let added = after.filter((r) => !before.some((b) => b.id === r.id))
  check(added.length === 1 && added[0].reportsTo === revRole.id, 'Enter adds the role under the chosen parent', JSON.stringify(added.map((r) => r.reportsTo)))
  check((await page.locator(`.react-flow__node[data-id="${added[0]?.id}"].selected`).count()) === 1, 'the new role is selected')
  check(await page.evaluate(() => document.activeElement?.id === 'role-description'), 'focus goes to "What is this role for?"', await page.evaluate(() => document.activeElement?.id ?? ''))
  const noticeRow = page.locator('[data-testid=team-notice-row]')
  const msg = noticeRow.locator('.team-notice-text')
  check(/^Added .+ under Reviewer\.$/.test((await msg.innerText()).trim()), 'the notice row says "Added ... under Reviewer."', await msg.innerText())
  check((await page.locator('body').innerText()).search(/can now create subagents/) < 0, 'no "can now create subagents" sentence anywhere')
  const edgesMid = await stageEdges()
  await noticeRow.locator('[data-testid=team-notice-undo]').click()
  await sleep(600)
  check(!(await rolesNow()).some((r) => r.id === added[0]?.id), 'Undo removes the added role')
  const edgesAfter = await stageEdges()
  check(JSON.stringify(edgesBefore) === JSON.stringify(edgesMid) && JSON.stringify(edgesMid) === JSON.stringify(edgesAfter), 'the stage top and the notice row do not move or change height during add and Undo', JSON.stringify([edgesBefore, edgesMid, edgesAfter]))
  await sleep(300)

  // D3 (kept for spec 1.2): choosing the root adds under the root, even with another role selected.
  before = await rolesNow()
  await add.click(root.id)
  await sleep(700)
  after = await rolesNow()
  added = after.filter((r) => !before.some((b) => b.id === r.id))
  check(added.length === 1 && added[0].reportsTo === root.id, 'Add role with Reports to the root adds under the root', JSON.stringify(added.map((r) => r.reportsTo)))
  const first = added[0]

  // (2) D2: a second and third add under the same manager sit beside the first, overlap nothing and come into view.
  for (let i = 0; i < 2; i++) {
    await add.click(root.id)
    await sleep(800)
    const r = await chartRects(page)
    const newestNow = (await rolesNow()).at(-1)
    const box = r.nodes.find((n) => n.id === newestNow.id)
    check(clearOfOverlays(box, r), `add ${i + 2} at 1440x900 is clear of the zoom controls and the minimap (QA S1)`, JSON.stringify({ box, overlays: r.overlays }))
  }
  after = await rolesNow()
  const siblings = after.filter((r) => r.reportsTo === root.id)
  const rects = await chartRects(page)
  let overlapping = []
  for (let i = 0; i < rects.nodes.length; i++) for (let j = i + 1; j < rects.nodes.length; j++) if (rectsOverlap(rects.nodes[i], rects.nodes[j])) overlapping.push(`${rects.nodes[i].id}/${rects.nodes[j].id}`)
  check(overlapping.length === 0, 'new roles overlap no other node', overlapping.join(', '))
  const rowY = after.find((r) => r.id === first.id).position.y
  check(siblings.filter((r) => r.position.y === rowY).length >= 4, 'new reports stand in their siblings\' row', JSON.stringify(siblings.map((r) => r.position)))
  const latest = after[after.length - 1]
  const latestRect = rects.nodes.find((n) => n.id === latest.id)
  const inStage = (n, s) => n.x >= s.x - 1 && n.y >= s.y - 1 && n.x + n.w <= s.x + s.w + 1 && n.y + n.h <= s.y + s.h + 1
  check(!!latestRect && inStage(latestRect, rects.stage), 'the newest role is inside the chart stage', JSON.stringify({ latestRect, stage: rects.stage }))
  await shot('add-roles-1440x900-dark')
  // A smaller window: one more add still comes into view.
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [1024, 640])
  await sleep(900)
  await add.click(root.id)
  await sleep(900)
  const small = await chartRects(page)
  const newest = (await rolesNow()).at(-1)
  const smallRect = small.nodes.find((n) => n.id === newest.id)
  check(!!smallRect && inStage(smallRect, small.stage), 'the newest role is inside the chart stage at 1024x640', JSON.stringify({ smallRect, stage: small.stage }))
  check(clearOfOverlays(smallRect, small), 'the newest role is clear of the zoom controls and the minimap at 1024x640 (QA S1)', JSON.stringify({ smallRect, overlays: small.overlays }))
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await sleep(300)
  await shot('add-roles-1024x640-light')
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [1440, 900])
  await sleep(800)
  await page.locator('.editor .react-flow__controls-fitview').click()
  await sleep(700)

  // (3) D5: drop on the middle of another node's body re-parents it, with a highlight while hovering.
  const roles = await rolesNow()
  const impl = roles.find((r) => r.name === 'Implementer')
  const rev = roles.find((r) => r.name === 'Reviewer')
  await dragReport(page, rev.id, impl.id, { release: false })
  check((await page.locator(`.react-flow__node[data-id="${impl.id}"] .role-node[data-drop=valid]`).count()) === 1, 'the node under a dragged line is highlighted')
  const hl = await page.locator(`.react-flow__node[data-id="${impl.id}"] .role-node`).evaluate((el) => getComputedStyle(el).outlineStyle)
  check(hl === 'solid', 'the highlight is a visible outline', hl)
  await shot('drop-highlight-dark')
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await sleep(200)
  await shot('drop-highlight-light')
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.mouse.up()
  await sleep(400)
  check((await page.locator('.react-flow__connection').count()) === 0, 'no connection line remains after a drop on a node body')
  const moved = (await rolesNow()).find((r) => r.id === impl.id)
  check(moved.reportsTo === rev.id, 'dropping on the middle of a node makes it a report', String(moved.reportsTo))

  // Review L1: let the root delegate to Implementer as well, then drop Implementer on the manager it already reports to.
  // That drop must change nothing (it used to strip the root's delegation through setReportsTo).
  // The drops can leave the root under the side panel's edge: fit the chart first so the click lands on the node.
  await page.locator('.editor .react-flow__controls-fitview').click()
  await sleep(400)
  await page.locator(`.react-flow__node[data-id="${root.id}"]`).click()
  await teamPanelTab(page, 'Role').waitFor()
  await page.evaluate(() => document.querySelectorAll('[data-testid=role-delegate-other]').forEach((d) => d.setAttribute('open', '')))
  await page.locator(`[data-testid="role-delegate-${impl.slug}"]`).check()
  await sleep(500)
  const beforeSame = JSON.stringify((await rolesNow()).map((r) => [r.id, r.reportsTo, r.canSpawn, r.spawnable, r.requiredReports ?? null]))
  check(JSON.parse(beforeSame).find((x) => x[0] === root.id)[3].includes(impl.id), 'the root may delegate to Implementer before the same-parent drop')
  await dragReport(page, rev.id, impl.id)
  await sleep(600)
  const afterSame = JSON.stringify((await rolesNow()).map((r) => [r.id, r.reportsTo, r.canSpawn, r.spawnable, r.requiredReports ?? null]))
  check(afterSame === beforeSame, 'a drop on the manager a role already reports to changes nothing (review L1)', afterSame)
  check((await page.locator('.react-flow__connection').count()) === 0, 'a same-parent drop leaves no connection line')

  // A cycle drop: Implementer now reports to Reviewer, so Reviewer cannot report to Implementer.
  await dragReport(page, impl.id, rev.id, { release: false })
  check((await page.locator(`.react-flow__node[data-id="${rev.id}"] .role-node[data-drop=invalid]`).count()) === 1, 'a node that cannot be a report shows the refusal while hovered')
  await page.mouse.up()
  await sleep(400)
  check((await page.locator('.react-flow__connection').count()) === 0, 'a refused drop leaves no connection line')
  const note = page.locator('[data-testid=team-drop-note]')
  await note.waitFor({ timeout: 3000 })
  check(/Reviewer cannot report to Implementer: Implementer already reports to Reviewer\./.test(await note.innerText()), 'a cycle drop says why', await note.innerText())
  check((await rolesNow()).find((r) => r.id === rev.id)?.reportsTo === root.id, 'a refused drop changes nothing')
  await shot('drop-refused-dark')
  // The root takes no drops.
  await dragReport(page, impl.id, root.id)
  await sleep(300)
  check((await rolesNow()).find((r) => r.id === root.id)?.reportsTo === null, 'the root accepts no drop')
  check((await page.locator('.react-flow__connection').count()) === 0, 'a drop on the root leaves no connection line')
  // Clicking a node body still selects it (the drop target takes no pointer events outside a drag).
  await page.locator(`.react-flow__node[data-id="${impl.id}"]`).click()
  check((await page.locator(`.react-flow__node[data-id="${impl.id}"] .role-node.selected`).count()) === 1, 'a click on a node body still selects it')

  // (4) D6: "leads N" counts reports the role may delegate to; none, no chip.
  const final = await rolesNow()
  const chip = (id) => page.locator(`.react-flow__node[data-id="${id}"] [data-testid=role-node-leads]`)
  const delegable = (id) => {
    const m = final.find((r) => r.id === id)
    return m.canSpawn ? final.filter((r) => r.reportsTo === id && m.spawnable.includes(r.id)).length : 0
  }
  check((await chip(first.id).count()) === 0, 'a role with no reports shows no leads chip')
  for (const id of [rev.id, root.id]) {
    const n = delegable(id)
    check(n > 0 && (await chip(id).count()) === 1 && (await chip(id).innerText()).trim() === `Delegates to ${n}`, `a manager's chip counts its delegable direct reports (${final.find((r) => r.id === id).name}: Delegates to ${n})`, await chip(id).innerText().catch(() => ''))
  }
  // Every node without a delegable report shows no chip.
  const wrong = []
  for (const r of final) if (delegable(r.id) === 0 && (await chip(r.id).count()) !== 0) wrong.push(r.name)
  check(wrong.length === 0, 'no role without a delegable report shows "Delegates to"', wrong.join(', '))

  // (5) D1: a report added to a leaf gives it the right to delegate (said before the action, in the popover); removing
  // that report (no reports of its own: no confirm) takes it back, and Undo restores it.
  const menu = page.locator('[data-testid=role-node-menu]')
  await page.locator(`.react-flow__node[data-id="${first.id}"]`).click({ button: 'right' })
  await menu.waitFor({ timeout: 5000 })
  await page.locator('[data-testid=role-menu-add-report]').click()
  await pop.waitFor({ timeout: 5000 })
  check(/will be able to hand work to other roles/.test(await pop.locator('[data-testid=add-role-helper]').innerText()), 'the popover says the leaf will be able to hand work to other roles', await pop.locator('[data-testid=add-role-helper]').innerText())
  await pop.locator('[data-testid=add-role-name]').press('Enter')
  await pop.waitFor({ state: 'hidden', timeout: 5000 })
  await sleep(700)
  const leafNow = (await rolesNow()).find((r) => r.id === first.id)
  const child = (await rolesNow()).find((r) => r.reportsTo === first.id)
  check(!!child && leafNow.canSpawn && leafNow.spawnable.includes(child.id), 'Add a report lets the manager delegate to it')
  check(!/subagent/i.test(await page.locator('.editor').innerText()), 'no "subagent" wording on the Team tab after Add a report')
  await page.locator('.team-panel-pane').getByRole('button', { name: 'Remove', exact: true }).click()
  await sleep(300)
  check((await page.getByRole('button', { name: 'Remove role', exact: true }).count()) === 0, 'removing a role without reports asks nothing')
  const msg2 = page.locator('[data-testid=team-notice-row] .team-notice-text')
  check(/^Removed /.test((await msg2.innerText()).trim()), 'the notice row says "Removed ..."', await msg2.innerText())
  await sleep(600)
  check((await rolesNow()).find((r) => r.id === first.id)?.canSpawn === false, 'removing the only delegable report clears the manager\'s right to delegate')
  await page.locator('[data-testid=team-notice-row] [data-testid=team-notice-undo]').click()
  await sleep(500)
  const back = (await rolesNow()).find((r) => r.id === first.id)
  check(back.canSpawn && back.spawnable.includes(child.id), 'Undo gives the right to delegate back')

  // Removing a role WITH reports asks first, with the new body (spec 1.7).
  await page.locator(`.react-flow__node[data-id="${first.id}"]`).click()
  await teamPanelTab(page, 'Role').waitFor()
  await page.locator('.team-panel-pane').getByRole('button', { name: 'Remove', exact: true }).click()
  const dlgBody = page.locator('dialog[open]', { hasText: 'Remove role' }).last()
  await dlgBody.waitFor({ timeout: 5000 })
  check(/Its 1 report moves up to /.test(await dlgBody.innerText()), 'the confirm says where its report moves', await dlgBody.innerText())
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
}

/**
 * Walk 4 M2: two mock work runs end, the proactive review lands, and opening Team shows "N suggestions since your last
 * run" once; leaving and coming back without a new run does not show it again.
 */
async function sectionRunsEnded(page) {
  const live = async () => {
    await page.locator('[data-testid=tab-live]').click()
    await page.locator('.new-run, [data-testid=run-meta]').first().waitFor({ timeout: 10_000 })
    if ((await page.locator('.new-run').count()) === 0) {
      await page.keyboard.press('Control+t')
      await page.locator('.new-run').waitFor({ timeout: 5000 })
    }
  }
  for (const text of ['First team review task', 'Second team review task']) {
    await live()
    const ta = page.locator('.composer textarea')
    await ta.waitFor({ timeout: 10_000 })
    await ta.fill(text)
    await page.locator('.composer .btn.primary').click()
    await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
    await sleep(2000)
    await endSession(page)
  }
  const lastEndedAt = Date.now()
  // The review runs 3 s after the LAST run ends (the debounce restarts per run). On a slow runner the first run's review
  // can land before the second run ends, so a badge alone proves nothing: wait for a review written after the last end.
  const projectId = (await findProject(page, NAME)).id
  const deadline = Date.now() + 25_000
  let reviewed = false
  while (Date.now() < deadline && !reviewed) {
    const r = await page.evaluate((id) => window.orgai.capabilities.lastReview(id), projectId).catch(() => null)
    const at = r && typeof r.checkedAt === 'string' ? Date.parse(r.checkedAt) : NaN
    reviewed = Number.isFinite(at) && at > lastEndedAt
    if (!reviewed) await sleep(250)
  }
  check(reviewed, 'a review is written after the last run ended')
  await page.locator('[data-testid=team-tab-badge]').waitFor({ timeout: 20_000 })
  await sleep(500)
  await openTeam(page)
  const tray = page.locator('[data-testid=team-assistant]')
  const since = tray.locator('[data-testid=team-since]')
  await since.waitFor({ timeout: 10_000 }).catch(() => {})
  const text = (await since.count()) > 0 ? (await since.innerText()).trim() : ''
  check(/^\d+ suggestions? since your last run$/.test(text), 'after runs end, Team shows "N suggestions since your last run"', text)
  await live()
  await openTeam(page)
  await sleep(1500)
  check((await tray.locator('[data-testid=team-since]').count()) === 0, 'the since line is not repeated without a new run')
}

/**
 * QA follow-up (B1, S1, P1, P4): Add role gives every role its own non-empty ID whatever the name; a very long unbroken
 * name is clipped inside the chart card and keeps the card size; the role editor's header keeps Remove on the name's row;
 * the collapsed tools summary has no double space.
 */
async function sectionAddIdsAndLongName(page, app, shot) {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [1440, 900])
  await sleep(600)
  const addBtn = page.locator('[data-testid=team-add-role]')
  const pop = page.locator('[data-testid=add-role-popover]')
  const rolesNow = async () => (await findProject(page, NAME)).roles
  const addNamed = async (name) => {
    await addBtn.click()
    await pop.waitFor({ timeout: 5000 })
    await pop.locator('[data-testid=add-role-name]').fill(name)
    await pop.locator('[data-testid=add-role-name]').press('Enter')
    await pop.waitFor({ state: 'hidden', timeout: 5000 })
    await sleep(350)
  }
  const names = ['Role 1', 'Role-1', 'Role 1.', 'role_1', '!!!', '???', '经理人员', 'مدير']
  const before = await rolesNow()
  for (const n of names) await addNamed(n)
  const after = await rolesNow()
  const added = after.filter((r) => !before.some((b) => b.id === r.id))
  check(added.length === names.length, `all ${names.length} roles were added`, JSON.stringify(added.map((r) => r.name)))
  const slugs = after.map((r) => r.slug)
  check(slugs.every((s) => typeof s === 'string' && s.length > 0), 'every role ID is non-empty', JSON.stringify(slugs))
  check(new Set(slugs).size === slugs.length, 'every role ID is distinct (QA B1)', JSON.stringify(added.map((r) => [r.name, r.slug])))
  check(new Set(after.map((r) => r.id)).size === after.length, 'every internal role id is distinct')
  // The popover does not show an ID, so a suffixed ID needs no message there.
  await addBtn.click()
  await pop.waitFor({ timeout: 5000 })
  check(!/\bID\b|role-1/.test(await pop.innerText()), 'the Add role popover shows no ID')
  await page.keyboard.press('Escape')
  await pop.waitFor({ state: 'hidden', timeout: 5000 })

  // S1 and P4: a 200-character unbroken name.
  const long = 'W'.repeat(200)
  await addNamed(long)
  const longRole = (await rolesNow()).find((r) => r.name === long)
  check(!!longRole, 'a 200-character name is accepted')
  if (!longRole) return
  const node = page.locator(`.react-flow__node[data-id="${longRole.id}"]`)
  await node.waitFor({ timeout: 5000 })
  const box = await page.evaluate((id) => {
    const wrap = document.querySelector(`.react-flow__node[data-id="${id}"]`)
    const card = wrap.querySelector('.role-node')
    const rect = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom } }
    const nm = card.querySelector('.name')
    const other = [...document.querySelectorAll('.react-flow__node .role-node')].find((c) => c !== card && c.querySelector('.name')?.textContent === 'Implementer')
    return { card: rect(card), name: rect(nm), slug: rect(card.querySelector('.slug')), otherH: other ? other.getBoundingClientRect().height : 0, zoom: card.getBoundingClientRect().width / card.offsetWidth, nameOverflow: getComputedStyle(nm).textOverflow, title: nm.getAttribute('title'), aria: card.querySelector('[data-testid=role-node-caps]')?.getAttribute('aria-label') ?? '' }
  }, longRole.id)
  const inside = (c, p) => c.x >= p.x - 0.5 && c.r <= p.r + 0.5 && c.y >= p.y - 0.5 && c.b <= p.b + 0.5
  check(inside(box.name, box.card) && inside(box.slug, box.card), 'a 200-character name and its ID line stay inside the role card (QA S1)', JSON.stringify(box))
  check(box.nameOverflow === 'ellipsis' && box.title === long, 'the card name clips with an ellipsis and keeps the full name in its tooltip')
  check(box.aria.startsWith(long), 'the card keeps the full name in its accessible name')
  check(Math.abs(box.card.h - box.otherH) <= 1 && Math.abs(box.card.w / box.zoom - 220) <= 1, 'the long-name card keeps the normal card size', JSON.stringify({ h: box.card.h, other: box.otherH, w: box.card.w, zoom: box.zoom }))
  await shot('long-name-card')
  // P4: the editor header stays one row with Remove beside the name.
  await node.click()
  await teamPanelTab(page, 'Role').waitFor()
  const head = await page.evaluate(() => {
    const hd = document.querySelector('aside.side-panel .side-header, .team-panel-pane .side-header') ?? document.querySelector('.side-header')
    const h2 = hd.querySelector('h2')
    const btn = [...hd.querySelectorAll('button')].find((b) => /Remove/.test(b.textContent ?? ''))
    // The name and its "{group} · reports to {manager}" line form one block (.ri-heading); Remove is centred beside it.
    const hb = hd.getBoundingClientRect(), tb = (hd.querySelector('.ri-heading') ?? h2).getBoundingClientRect(), bb = btn.getBoundingClientRect()
    return { headH: hb.height, firstRowMid: tb.top + 22, h2Mid: tb.top + tb.height / 2, btnMid: bb.top + bb.height / 2, btnBottom: bb.bottom, headBottom: hb.bottom, btnRight: bb.right, headRight: hb.right, title: h2.getAttribute('title'), ellipsis: getComputedStyle(h2).textOverflow }
  })
  // A long name wraps (two lines at most), so Remove sits beside its first row, not centred on the block.
  check(Math.abs(head.firstRowMid - head.btnMid) <= 14 && head.btnBottom <= head.headBottom && head.btnRight <= head.headRight + 0.5, 'the role editor header keeps Remove on the name row (QA P4)', JSON.stringify(head))
  check(head.title === long && head.ellipsis === 'ellipsis', 'the long header name truncates and keeps its full text in the title')
  // P1: the collapsed tools summary has no double space.
  const summary = await page.evaluate(() => {
    const els = [...document.querySelectorAll('[data-testid=role-capabilities] *')].filter((e) => /^Can\b/.test((e.textContent ?? '').trim()) && e.children.length > 0 && /files|commands|web/.test(e.textContent ?? ''))
    return els.length ? els[els.length - 1].textContent : ''
  })
  check(summary === '' || !/\s{2}/.test(summary), 'the collapsed tools summary has no double space (QA P1)', JSON.stringify(summary))
  const all = await page.evaluate(() => document.querySelector('[data-testid=role-capabilities]')?.textContent ?? '')
  check(!/Can\s{2,}/.test(all), 'no "Can  " double space in the role capabilities block', JSON.stringify(all.slice(0, 120)))
}

/** A box's distance from each edge of the chart stage (negative: outside). */
const stageGap = (page, selector) =>
  page.evaluate((s) => {
    const el = document.querySelector(s)
    const st = document.querySelector('.editor .frame-stage')
    if (!el || !st) return null
    const b = el.getBoundingClientRect()
    const v = st.getBoundingClientRect()
    return { left: Math.round(b.left - v.left), right: Math.round(v.right - b.right), top: Math.round(b.top - v.top), bottom: Math.round(v.bottom - b.bottom) }
  }, selector)
const insideStage = (g) => !!g && g.left >= 0 && g.right >= 0 && g.top >= 0 && g.bottom >= 0

/**
 * Walkthrough fixes (ux-review-team-overhaul): the role toolbar stays inside the chart, Duplicate brings the copy into
 * view, Add group says what it does, Escape and Tab on a role keep focus where the keyboard user expects it.
 */
async function sectionReviewFixes(page, app, shot) {
  for (const [w, h] of SIZES) {
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
    await sleep(600)
    // Every role in turn: the toolbar is inside the visible chart wherever the role sits (it flips or shifts).
    await page.locator('.react-flow__controls-fitview').click()
    await sleep(500)
    const ids = await page.evaluate(() => [...document.querySelectorAll('.react-flow__node')].map((n) => ({ id: n.dataset.id, x: n.getBoundingClientRect().right })).sort((a, b) => b.x - a.x).map((n) => n.id))
    for (const id of [ids[0], ids[ids.length - 1]]) {
      await page.locator(`.react-flow__node[data-id="${id}"]`).click({ position: { x: 20, y: 20 } })
      await sleep(400)
      // The toolbar's own box (not the node's) must be inside the stage.
      const gap = await page.evaluate(() => {
        const el = document.querySelector('.role-node-toolbar-row')
        const st = document.querySelector('.editor .frame-stage')
        if (!el || !st) return null
        const b = el.getBoundingClientRect(), v = st.getBoundingClientRect()
        return { left: Math.round(b.left - v.left), right: Math.round(v.right - b.right), top: Math.round(b.top - v.top), bottom: Math.round(v.bottom - b.bottom) }
      })
      check(insideStage(gap), `the role toolbar is inside the chart at ${w}x${h} (${id === ids[0] ? 'right-most' : 'left-most'} role)`, JSON.stringify(gap))
    }
  }
  // Add group says what it does.
  await page.locator('[data-testid=team-add-group]').click()
  const pop = page.locator('[data-testid=add-role-popover]')
  await pop.waitFor({ timeout: 5000 })
  check(/Add a group lead/.test(await pop.locator('[data-testid=add-role-title]').innerText()), 'Add group opens a form titled "Add a group lead"')
  check(/lead its own group/i.test(await pop.innerText()), 'the Add group form says the role leads its own group')
  check((await pop.locator('[data-testid=add-role-name]').inputValue()).startsWith('New group'), 'the Add group name starts as "New group"')
  await page.keyboard.press('Escape')
  await pop.waitFor({ state: 'hidden', timeout: 5000 })
  await page.locator('[data-testid=team-add-role]').click()
  await pop.waitFor({ timeout: 5000 })
  check(/Add a role/.test(await pop.locator('[data-testid=add-role-title]').innerText()), 'the plain Add role form keeps its title after Add group')
  await page.keyboard.press('Escape')
  await pop.waitFor({ state: 'hidden', timeout: 5000 })

  // Duplicate the right-most role: the copy comes into view and its description has focus.
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [1024, 640])
  await sleep(600)
  const rightmost = await page.evaluate(() => [...document.querySelectorAll('.react-flow__node')].map((n) => ({ id: n.dataset.id, x: n.getBoundingClientRect().right })).sort((a, b) => b.x - a.x)[0].id)
  const before = (await findProject(page, NAME)).roles.length
  await page.locator(`.react-flow__node[data-id="${rightmost}"]`).click({ position: { x: 20, y: 20 } })
  await page.locator('[data-testid=role-node-duplicate]').click()
  await sleep(1000)
  const after = await findProject(page, NAME)
  check(after.roles.length === before + 1, 'Duplicate adds one role')
  const copy = await page.evaluate(() => document.querySelector('.react-flow__node.selected')?.dataset.id)
  const gap = await stageGap(page, `.react-flow__node[data-id="${copy}"]`)
  check(insideStage(gap), 'the duplicated role is brought into view', JSON.stringify(gap))
  check(await page.evaluate(() => document.activeElement?.id === 'role-description'), 'focus stays on the copy\'s description after Duplicate')
  const tbGap = await page.evaluate(() => {
    const el = document.querySelector('.role-node-toolbar-row'), v = document.querySelector('.editor .frame-stage').getBoundingClientRect()
    const b = el?.getBoundingClientRect()
    return b ? { left: b.left - v.left, right: v.right - b.right, top: b.top - v.top } : null
  })
  check(!!tbGap && tbGap.left >= 0 && tbGap.right >= 0 && tbGap.top >= 0, 'the new role\'s toolbar is inside the chart', JSON.stringify(tbGap))
  await shot('review-fixes-duplicate')

  // Escape on a focused role keeps focus on the role.
  const nodeSel = `.react-flow__node[data-id="${copy}"]`
  await page.locator(nodeSel).focus()
  await page.keyboard.press('Escape')
  await sleep(500)
  check(await page.evaluate((s) => document.activeElement?.matches(s) === true, nodeSel), 'Escape on a focused role keeps focus on the role')

  // Tab order: the selected role, then its actions, then the next role.
  await page.locator(nodeSel).focus()
  await page.keyboard.press('Enter')
  await sleep(400)
  await page.locator(nodeSel).focus()
  await page.keyboard.press('Tab')
  check(await page.evaluate(() => document.activeElement?.closest('.role-node-toolbar-row') !== null), 'Tab from the selected role lands on its actions')
  await page.keyboard.press('Shift+Tab')
  check(await page.evaluate((s) => document.activeElement?.matches(s) === true, nodeSel), 'Shift+Tab from the first action returns to the role')
  await page.keyboard.press('Shift+F10')
  const menuOpen = await page.locator('[data-testid=role-node-menu]').isVisible().catch(() => false)
  check(menuOpen, 'Shift+F10 on the role still opens its menu')
  await page.keyboard.press('Escape')
  await sleep(300)
  // Undo the duplicate through its notice.
  const undo = page.locator('[data-testid=team-notice-undo]')
  if (await undo.count()) await undo.click()
  await sleep(400)
}

const { app, page, shot } = await launch({ shotPrefix: 'team' })
try {
  await createProject(page, { path: repo, name: NAME })
  await openTeam(page)
  for (const [w, h] of SIZES) {
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
    await sleep(500)
    // Review M8: a short window folds the Team assistant to its Ask bar, so the chart keeps its room.
    const more = page.locator('[data-testid=team-assistant-more]')
    const folded = (await more.getAttribute('aria-expanded')) === 'false'
    check(folded === (h <= 760), `the Team assistant is ${h <= 760 ? 'folded to the Ask bar' : 'open'} at ${w}x${h}`, String(folded))
    if (folded) {
      check(!(await page.locator('[data-testid=team-recommend]').isVisible()), 'folded: the recommendations are hidden')
      check((await page.locator('.editor .frame-stage').evaluate((el) => el.getBoundingClientRect().height)) >= 360, `the chart has at least 360 px of height at ${w}x${h}`)
    }
    for (const theme of THEMES) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await teamPanelTab(page, 'Catalog').click()
      await page.locator('[data-testid=team-catalog]').waitFor()
      const scroll = await page.evaluate(() => {
        const pane = document.querySelector('.team-panel-pane')
        const side = pane.closest('.side-panel')
        const tabs = document.querySelector('.team-panel-tabs')
        const top = tabs.getBoundingClientRect().top
        pane.scrollTop = pane.scrollHeight
        return {
          outerScrollable: /auto|scroll/.test(getComputedStyle(side).overflowY),
          moved: pane.scrollTop > 0,
          atBottom: Math.abs(pane.scrollHeight - pane.clientHeight - pane.scrollTop) <= 1,
          tabsFixed: tabs.getBoundingClientRect().top === top
        }
      })
      check(!scroll.outerScrollable, `Team has no outer scrollbar at ${w}x${h} ${theme}`, JSON.stringify(scroll))
      check(scroll.moved && scroll.atBottom && scroll.tabsFixed, `Catalog scrolls to the end with fixed tabs at ${w}x${h} ${theme}`, JSON.stringify(scroll))
      await shot(`catalog-scroll-${w}x${h}-${theme}`)
    }
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await sectionFirstConnection(page, shot)
  await seed(page)
  await sectionBlock(page)
  await sectionEditor(page)
  await selectReviewer(page)
  await sectionTools(page)
  await sectionSkills(page)
  await sectionConnections(page, shot)
  await sectionLocalSkill(page)
  await sectionRiskAndKeyboard(page)
  await sectionRunsEnded(page)
  await sectionAssistant(page, shot)
  await sectionDismiss(page, shot, app)
  await sectionDesignDecisions(page, shot)
  await sectionExactModel(page)
  await sectionPanelAndAskBar(page)
  await sectionProxyExactModel(page, app, shot)
  // Last among the sections: it reloads the page, which would let the Team tray decide its "since your last run" line
  // before sectionRunsEnded's runs end.
  await sectionRequiredReports(page)
  await selectReviewer(page)
  // Screenshots: both sizes in both themes, with the block holding content.
  await page.locator('[data-testid=role-capabilities] [data-testid=role-add-skill]').click()
  await page.locator('[data-testid=capability-chooser]').waitFor()
  await page.locator('[data-testid=capability-chooser-item]').first().click()
  await page.locator('[data-testid=role-skill]').first().waitFor()
  for (const [w, h] of SIZES) {
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
    await sleep(500)
    await expandAssistant(page)
    await page.locator('[data-testid=team-recommend]').click()
    await page.waitForFunction(() => document.querySelector('[data-testid=team-recommend-pane]')?.getAttribute('data-phase') === 'idle', null, { timeout: 20_000 })
    await sleep(400)
    const tg = await page.evaluate(() => ({ tray: document.querySelector('.editor .frame-tray')?.getBoundingClientRect().height ?? 0, frame: document.querySelector('.editor .frame-grid')?.getBoundingClientRect().height ?? 1 }))
    check(tg.tray >= Math.min(260, tg.frame * 0.4), `the tray has room for the results at ${w}x${h}`, JSON.stringify(tg))
    // Walk 3: the skip link lands on the visible panel tabs, or on the railed panel itself when there is no room.
    await page.locator('[data-testid=skip-to-role-panel]').focus()
    await page.keyboard.press('Enter')
    await sleep(300)
    const skip = await page.evaluate(() => {
      const a = document.activeElement
      return { inTabs: !!a?.closest('[data-testid=team-panel-tabs]'), inPanel: !!a?.closest('aside.side-panel') || a?.matches('aside.side-panel') === true }
    })
    check(skip.inTabs || skip.inPanel, `Skip to role panel lands in the panel (tabs or rail) at ${w}x${h}`, JSON.stringify(skip))
    for (const theme of THEMES) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await sleep(300)
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
      check(m.sw <= m.cw, `no horizontal scroll at ${w}x${h} ${theme}`, JSON.stringify(m))
      await shot(`role-block-${w}x${h}-${theme}`)
      await shot(`tray-results-${w}x${h}-${theme}`)
      const g = await page.evaluate(() => ({ stage: document.querySelector('.editor .frame-stage')?.getBoundingClientRect().height ?? 0, stageW: document.querySelector('.editor .frame-stage')?.getBoundingClientRect().width ?? 0 }))
      check(g.stage >= 140 && g.stageW >= 280, `the stage keeps its room beside the open tray at ${w}x${h}`, JSON.stringify(g))
    }
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await sectionReviewFixes(page, app, shot)
  await sectionNodeMenu(page)
  await sectionAddAndDrag(page, app, shot)
  await sectionAddIdsAndLongName(page, app, shot)
} catch (e) {
  check(false, 'team flow ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await cleanup(app, page, NAME)
}
removeFixture(repo)
finish('e2e/team')
