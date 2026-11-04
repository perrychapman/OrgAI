// Token-free (mock adapter). Per-project MCP values: a library entry with perProjectSecrets and a per-project env name,
// linked to a project; the row's "For this project" block, the Needs values badge, filling the value, and the
// "Make a project-only copy" dialog. Needs the runtime side (window.orgai.mcpProject); skips without it.
import { check, cleanup, createProject, finish, launch, makeFixtureRepo, openTeam, removeFixture, sleep, teamPanelTab } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E per-project (orgai test)'
const repo = makeFixtureRepo('per-project')
const { app, page, shot } = await launch({ shotPrefix: 'per-project' })
page.setDefaultTimeout(5000)
const setSize = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await sleep(400)
}

try {
  if (!(await page.evaluate(() => typeof window.orgai.mcpProject !== 'undefined'))) {
    console.log('SKIP (runtime not merged)')
    await cleanup(app, page, NAME).catch(() => {})
    removeFixture(repo)
    process.exit(0)
  }
  await createProject(page, { mode: 'existing', path: repo, name: NAME })
  const pid = await page.evaluate(async (n) => (await window.orgai.projects.list()).find((p) => p.name === n)?.id, NAME)
  check(!!pid, 'project created')
  const libId = await page.evaluate(async () => {
    const list = await window.orgai.mcpLibrary.upsert({
      id: 'lib-per-project',
      name: 'client-idp-admin',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@acme/idp-mcp@1.2.0'],
      secretEnv: ['API_TOKEN'],
      perProjectSecrets: true,
      perProjectEnv: ['TENANT_URL'],
      source: 'user',
      addedAt: new Date().toISOString()
    })
    return list.find((i) => i.entry.name === 'client-idp-admin')?.entry.id
  })
  check(!!libId, 'library entry saved')
  await page.evaluate(([projectId, libraryId]) => window.orgai.mcp.linkLibrary({ projectId, libraryId, enabled: true }), [pid, libId])

  for (const [w, h, tag] of [[1024, 640, 'small'], [1600, 1000, 'large']]) {
    await setSize(w, h)
    await openTeam(page)
    await teamPanelTab(page, 'Catalog').click()
    await page.waitForSelector('[data-testid=catalog-connections]', { timeout: 10_000 })
    const row = page.locator('[data-testid=mcp-row][data-server=client-idp-admin]')
    await row.waitFor()
    const block = row.locator('[data-testid=mcp-per-project]')
    check((await block.count()) === 1, `row has the per-project block ${tag}`)
    check(/^For this (project|engagement)/.test((await block.innerText()).trim()), `block heading names the project ${tag}`)
    check((await row.locator('[data-testid=mcp-per-project-badge]').count()) === 1, `Needs values badge shows while empty ${tag}`)
    check(/Needs 2 values/.test((await row.locator('[data-testid=mcp-per-project-missing]').innerText().catch(() => '')) ?? ''), `missing line counts two values ${tag}`)
    await shot(`row-${tag}`)
  }

  const row = page.locator('[data-testid=mcp-row][data-server=client-idp-admin]')
  const field = row.getByLabel('TENANT_URL')
  await field.fill('https://acme.example.com')
  await field.press('Enter')
  await page.locator('[data-testid=mcp-per-project-status]').filter({ hasText: 'Saved' }).waitFor()
  check(true, 'Saved status after Enter')
  check((await row.locator('[data-testid=mcp-per-project-missing]').innerText()).includes('Needs 1 value'), 'missing line drops to one value')
  await row.locator('[data-testid=secret-field] input').fill('tok-123')
  await row.locator('[data-testid=secret-field]').getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('[data-testid=mcp-per-project-badge]'))
  check(true, 'badge gone once every value is set')

  // Copy dialog.
  await row.getByRole('button', { name: 'More actions for client-idp-admin' }).click()
  await row.locator('[data-testid=mcp-copy-from-library]').click()
  const dlg = page.locator('[data-testid=mcp-copy-dialog]')
  await dlg.waitFor()
  check((await dlg.locator('[data-testid=mcp-copy-secrets]').isChecked()) === false, 'copy secrets is off by default')
  await dlg.locator('[data-testid=mcp-copy-confirm]').click()
  await page.locator('[data-testid=mcp-group-local] [data-testid=mcp-row][data-server=client-idp-admin]').waitFor()
  check(true, 'the copy appears under Only in this project')
  check(/Made a project-only copy of client-idp-admin/.test((await page.locator('[data-testid=mcp-section-status]').innerText()) ?? ''), 'section status announces the copy')
  await sleep(200)
  const focusedName = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')
  check(focusedName === 'More actions for client-idp-admin', 'focus lands on the new row\'s More actions button', focusedName)
} finally {
  await cleanup(app, page, NAME).catch(() => {})
  removeFixture(repo)
}
finish('e2e/per-project')
