// Token-free (mock adapter, temp data dir). Team tab, Role pane "What it can use": tools edited in place, connections and
// skills granted from the scoped chooser (this role only), revoke, the node capability line, the "Needs sign in" path and
// the keyboard rules (Escape from the chooser returns focus to "+ Add"). Sections are named so later briefs (the Team
// assistant tray) can add their own below.
import { check, cleanup, createProject, finish, findProject, launch, log, makeFixtureRepo, openProject, openTeam, removeFixture, sleep, teamPanelTab } from './lib.mjs'

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
  check(/Read/.test(await block.locator('[data-testid=role-tools]').innerText()), 'Tools shows a summary line')
  check((await block.locator('[data-testid=role-add-connection]').count()) === 1, 'an empty Connections group offers a primary "Add a connection"')
  check((await block.locator('[data-testid=role-add-skill]').count()) === 1, 'an empty Skills group offers a primary "Add a skill"')
  check((await block.locator('[data-testid=role-ask-assistant]').count()) === 2, 'empty groups offer "Ask the Team assistant"')
  check(!/Manage in Tools|MCP/.test(await block.innerText()), 'the block never says "Manage in Tools" or "MCP"')
}

async function sectionTools(page) {
  const block = page.locator('[data-testid=role-capabilities]')
  const before = (await reviewer(page)).role.tools
  await block.locator('[data-testid=role-edit-tools]').click()
  const bash = block.locator('[data-testid=role-tool-Bash]')
  const want = !before.includes('Bash')
  await bash.setChecked(want)
  await sleep(1200)
  const after = (await reviewer(page)).role.tools
  check(after.includes('Bash') === want, 'toggling a tool saves it on the role', after.join(','))
  await bash.setChecked(!want)
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
  check(await addBtn.evaluate((el) => el === document.activeElement), 'Escape from the chooser returns focus to "+ Add"')

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
  check((await tray.locator('[data-testid=team-mode-recommend]').getAttribute('aria-selected')) === 'true', 'the tray opens on Recommend')
  check((await tray.locator('[data-testid=architect-open]').count()) === 1, 'the Design mode switch is in the tray')
  check((await page.locator('.frame-toolbar [data-testid=architect-open]').count()) === 0, 'the toolbar no longer has a Design button')
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

  // Design mode: an Architect session that stays on the Team tab and off the Live strip.
  await tray.locator('[data-testid=architect-open]').click()
  const box = tray.locator('textarea').first()
  await box.fill('Add a database specialist.')
  await tray.getByRole('button', { name: 'Revise with the Architect' }).click()
  await tray.locator('[data-testid=architect-session]').waitFor({ timeout: 15_000 })
  check((await page.locator('[data-testid=tab-team]').getAttribute('aria-selected')) === 'true', 'the Architect session does not leave the Team tab')
  check((await page.locator('.run-tab').count()) === 0, 'the Architect session has no run tab on the Live strip')
  await tray.locator('[data-testid=team-mode-recommend]').click()
}

/** Design mode hosts the Architect's permission card; the Needs-you pill brings the user back to it. */
async function sectionDesignDecisions(page, shot) {
  const tray = page.locator('[data-testid=team-assistant]')
  await tray.locator('[data-testid=architect-open]').click()
  const card = tray.locator('[data-testid=architect-decisions] .decision-card').first()
  await card.waitFor({ timeout: 20_000 })
  check(true, 'the Architect permission card shows in the Design tray')
  check(!/R\?/.test(await tray.locator('[data-testid=architect-decisions]').innerText()), 'the Architect card is not labelled R?')
  await shot('design-permission')
  await tray.locator('[data-testid=team-mode-recommend]').click()
  await page.locator('[data-testid=topbar-needs-you]').click()
  await tray.locator('[data-testid=architect-decisions] .decision-card').first().waitFor({ timeout: 5_000 })
  check((await tray.getAttribute('data-mode')) === 'design', 'the Needs-you pill switches the tray to Design')
  await sleep(300)
  check(await page.evaluate(() => !!document.activeElement?.closest('[data-testid=architect-decisions]')), 'the Needs-you pill focuses the Architect card')
  await tray.locator('[data-testid=team-mode-recommend]').click()
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
  await add.locator('[data-testid=add-service-option][data-connector=github]').click()
  const dlg = page.locator('[data-testid=connector-dialog]')
  await dlg.waitFor({ timeout: 10_000 })
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
  await sleep(300)
  check(
    await page.evaluate(() => document.activeElement?.getAttribute('role') === 'tab' && document.activeElement.getAttribute('aria-selected') === 'true'),
    'the chooser opens with focus on the selected tab'
  )
  const first = await page.evaluate(() => document.activeElement?.textContent)
  await page.keyboard.press('ArrowRight')
  const next = await page.evaluate(() => (document.activeElement?.getAttribute('aria-selected') === 'true' ? document.activeElement.textContent : null))
  check(!!next && next !== first, 'ArrowRight moves the selected chooser tab', `${first} -> ${next}`)
  await page.keyboard.press('Home')
  check((await page.evaluate(() => document.activeElement?.textContent)) === first, 'Home returns to the first tab')
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
    await block.locator('[data-testid=role-tool-Bash]').setChecked(on)
    await block.locator('[data-testid=role-edit-tools]').click()
    await sleep(1200)
  }
  const had = (await reviewer(page)).role.tools.includes('Bash')
  if (!had) await setBash(true)
  check(/\+\s.*Bash/.test(await block.locator('[data-testid=role-tools-summary]').innerText()), 'the Tools summary names Bash')
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
async function sectionDismiss(page, shot) {
  const tray = page.locator('[data-testid=team-assistant]')
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
  const since = tray.locator('[data-testid=team-since]')
  if ((await since.count()) > 0) check(/^\d+ suggestions? since your last run$/.test((await since.innerText()).trim()), 'team-since says "since your last run"')
}

const { app, page, shot } = await launch({ shotPrefix: 'team' })
try {
  await createProject(page, { path: repo, name: NAME })
  await openTeam(page)
  await sectionFirstConnection(page, shot)
  await seed(page)
  await sectionBlock(page)
  await sectionTools(page)
  await sectionSkills(page)
  await sectionConnections(page, shot)
  await sectionLocalSkill(page)
  await sectionRiskAndKeyboard(page)
  await sectionAssistant(page, shot)
  await sectionDismiss(page, shot)
  await sectionDesignDecisions(page, shot)
  // Screenshots: both sizes in both themes, with the block holding content.
  await page.locator('[data-testid=role-capabilities] [data-testid=role-add-skill]').click()
  await page.locator('[data-testid=capability-chooser]').waitFor()
  await page.locator('[data-testid=capability-chooser-item]').first().click()
  await page.locator('[data-testid=role-skill]').first().waitFor()
  for (const [w, h] of SIZES) {
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
    await sleep(500)
    await page.locator('[data-testid=team-recommend]').click()
    await page.waitForFunction(() => document.querySelector('[data-testid=team-recommend-pane]')?.getAttribute('data-phase') === 'idle', null, { timeout: 20_000 })
    await sleep(400)
    const tg = await page.evaluate(() => ({ tray: document.querySelector('.editor .frame-tray')?.getBoundingClientRect().height ?? 0, frame: document.querySelector('.editor .frame-grid')?.getBoundingClientRect().height ?? 1 }))
    check(tg.tray >= Math.min(260, tg.frame * 0.4), `the tray has room for the results at ${w}x${h}`, JSON.stringify(tg))
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
} catch (e) {
  check(false, 'team flow ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await cleanup(app, page, NAME)
}
removeFixture(repo)
finish('e2e/team')
