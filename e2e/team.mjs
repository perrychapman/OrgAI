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

const { app, page, shot } = await launch({ shotPrefix: 'team' })
try {
  await createProject(page, { path: repo, name: NAME })
  await seed(page)
  await sectionBlock(page)
  await sectionTools(page)
  await sectionSkills(page)
  await sectionConnections(page, shot)
  // Screenshots: both sizes in both themes, with the block holding content.
  await page.locator('[data-testid=role-capabilities] [data-testid=role-add-skill]').click()
  await page.locator('[data-testid=capability-chooser]').waitFor()
  await page.locator('[data-testid=capability-chooser-item]').first().click()
  await page.locator('[data-testid=role-skill]').first().waitFor()
  for (const [w, h] of SIZES) {
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
    await sleep(500)
    for (const theme of THEMES) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await sleep(300)
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
      check(m.sw <= m.cw, `no horizontal scroll at ${w}x${h} ${theme}`, JSON.stringify(m))
      await shot(`role-block-${w}x${h}-${theme}`)
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
