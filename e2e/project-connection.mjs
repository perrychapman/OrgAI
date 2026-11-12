// Token-free (mock). Two connections connected (Anthropic plus a mock proxy): the New project form offers a Connection
// Select, a project created on the proxy shows it in Project settings, the radio list has one entry per connection,
// a not-connected proxy is marked and inert, the mapping dialog lists a line per tier. 1024x640 and 1600x1000, both
// themes, no page scroll. Keyboard: the Select and the radio list.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, cleanup, deleteProject, finish, gotoProjects, launch, makeFixtureRepo, openProjectForm, projectTab, removeFixture, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const A = 'E2E proxy project A (orgai test)'
const B = 'E2E default project B (orgai test)'
const PROXY = 'E2E mock gateway'
const IDLE = 'E2E idle gateway'
const ALT = 'E2E alt gateway' // stands in for Anthropic where no Claude login exists (CI)
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-pconn-'))
const repoA = path.join(base, 'repo-a')
const repoB = path.join(base, 'repo-b')
makeFixtureRepo('pconn-a', { at: repoA })
makeFixtureRepo('pconn-b', { at: repoB })

const { app, page, shot } = await launch({ shotPrefix: 'pconn' })
const noOverflow = async (what) => {
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight }))
  check(ov.sw <= ov.cw && ov.sh <= ov.ch + 1, `no page scroll or overflow: ${what}`, JSON.stringify(ov))
}

/** Create a code project through the form, choosing a connection in the Select when asked. Returns the saved project. */
async function makeProject(name, dir) {
  await gotoProjects(page)
  const form = await openProjectForm(page)
  await form.locator('[data-testid=project-kind-option][data-kind=code] input[type=radio]').check({ force: true })
  await form.getByRole('radio', { name: 'Existing code', exact: true }).check({ force: true })
  await form.locator('input[placeholder*="repo"]').fill(dir)
  await form.locator('input[placeholder*="Defaults to the folder name"]').fill(name)
  const arch = form.locator('[data-testid=architect-setup]')
  if (await arch.isChecked()) await form.locator('label.checkbox', { hasText: 'Set up with the Architect' }).click()
  const mock = form.locator('[data-testid=use-mock]')
  if ((await mock.count()) && (await mock.isChecked())) await form.locator('label.checkbox', { hasText: 'Use the mock adapter' }).click()
  return { form, select: form.locator('[data-testid=new-project-connection-select]') }
}

try {
  // Two proxies: one connected, one left not connected. Keys and URLs are made up and on the mock host.
  const ids = await page.evaluate(async ([a, b, c]) => {
    const one = await window.orgai.connections.createProxy({ name: a, kind: 'openai-compatible', anthropicBaseUrl: 'https://mock-proxy.example.com', apiKey: 'any-key' })
    await window.orgai.connections.connect(one.connection.id)
    const two = await window.orgai.connections.createProxy({ name: b, kind: 'litellm', anthropicBaseUrl: 'https://mock-proxy.example.com', apiKey: 'any-key' })
    const alt = (await window.orgai.connections.list()).some((x) => x.connection.id === 'anthropic' && x.status.state === 'connected')
      ? null
      : await window.orgai.connections.createProxy({ name: c, kind: 'openai-compatible', anthropicBaseUrl: 'https://mock-proxy.example.com', apiKey: 'any-key' })
    if (alt) await window.orgai.connections.connect(alt.connection.id)
    return [one.connection.id, two.connection.id, alt ? alt.connection.id : null]
  }, [PROXY, IDLE, ALT])
  const [proxyId, idleId, altId] = ids
  check(!!proxyId && !!idleId, 'two proxies created', ids.join(', '))
  await sleep(800)
  const listed = await page.evaluate(() => window.orgai.connections.list())
  const connected = listed.filter((c) => c.status.state === 'connected').map((c) => c.connection.id)
  check(connected.includes(proxyId) && !connected.includes(idleId) && connected.length >= 2, 'the mock proxy is connected, the idle one is not', connected.join(', '))

  // --- New project form: Select with both options; project A on the proxy, project B on the default
  const { form } = await makeProject(A, repoA)
  const select = form.locator('[data-testid=new-project-connection-select]')
  await select.waitFor({ timeout: 10_000 })
  const optionTexts = (await select.locator('option').allTextContents()).map((t) => t.trim())
  check(optionTexts.some((t) => /^Anthropic/.test(t) || (altId && t.startsWith(ALT))) && optionTexts.some((t) => t.startsWith(PROXY)), 'Connection Select lists Anthropic and the proxy', optionTexts.join(' | '))
  check(!optionTexts.some((t) => t.startsWith(IDLE)), 'a not-connected proxy is not offered in the Select')
  check((await form.locator('label[for]', { hasText: /^Connection$/ }).count()) === 1, 'the Select has a visible label "Connection"')
  check((await form.locator('[data-testid=new-project-connection-change]').count()) === 1, 'Manage connections link present beside the Select')
  // Keyboard: the Select is a native select; ArrowDown on a focused select moves the value.
  await select.focus()
  if (process.platform === 'darwin') {
    // On macOS arrow keys on a focused native select open the popup menu instead of changing the value,
    // so prove reachability only and skip the value change.
    const state = await select.evaluate((el) => ({
      focused: document.activeElement === el,
      enabled: !el.disabled,
      inert: !!el.closest('[inert]') || el.getAttribute('aria-disabled') === 'true',
      options: el.options.length,
    }))
    console.log('NOTE darwin: native select opens its menu on arrow keys; checking focus and options only', JSON.stringify(state))
    check(state.focused && state.enabled && !state.inert && state.options > 1, 'the Connection Select is focusable, enabled, not inert and has several options', JSON.stringify(state))
  } else {
    const before = await select.inputValue()
    await page.keyboard.press('ArrowDown')
    let after = await select.inputValue()
    if (after === before) {
      // The value was already the last option (without a Claude login the default is the last proxy): go up instead.
      await page.keyboard.press('ArrowUp')
      after = await select.inputValue()
    }
    check(before !== after || optionTexts.length < 2, 'ArrowDown changes the Connection Select value', `${before} -> ${after}`)
  }
  await select.selectOption(proxyId)
  check(/tier models/.test((await form.locator('[data-testid=new-project-connection-hint]').textContent()) ?? ''), 'a proxy pick shows the tier-mapping note')
  await shot('form-select')
  await noOverflow('New project form with the Select')
  await form.getByRole('button', { name: 'Create project', exact: true }).click()
  await page.waitForSelector('[data-testid=dashboard]', { state: 'detached', timeout: 30_000 })
  await sleep(800)
  const projA = await page.evaluate((n) => window.orgai.projects.list().then((l) => l.find((p) => p.name === n)), A)
  check(projA?.provider?.connection === proxyId, 'project A was created on the proxy', String(projA?.provider?.connection))

  // Project B on the default connection
  const second = await makeProject(B, repoB)
  await second.select.waitFor({ timeout: 10_000 })
  if (altId) await second.select.selectOption(altId)
  await second.form.getByRole('button', { name: 'Create project', exact: true }).click()
  await page.waitForSelector('[data-testid=dashboard]', { state: 'detached', timeout: 30_000 })
  await sleep(800)
  const projB = await page.evaluate((n) => window.orgai.projects.list().then((l) => l.find((p) => p.name === n)), B)
  const defaultId = altId ?? listed.find((c) => c.isDefault)?.connection.id
  check(projB?.provider?.connection === defaultId, 'project B (Select left on the default) is on the default connection', `${projB?.provider?.connection} vs ${defaultId}`)

  // --- Project settings > General > Connection at both sizes and themes
  const sizes = [[1024, 640], [1600, 1000]]
  for (const [w, h] of sizes) {
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
    await sleep(300)
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      const tag = `${w}x${h} ${theme}`

      // New project form at this size/theme
      await gotoProjects(page)
      const f = await openProjectForm(page)
      // The Select is hidden while the mock adapter is ticked (it is by default).
      const mockBox = f.locator('[data-testid=use-mock]')
      if ((await mockBox.count()) && (await mockBox.isChecked())) await f.locator('label.checkbox', { hasText: 'Use the mock adapter' }).click()
      await f.locator('[data-testid=new-project-connection-select]').waitFor({ timeout: 10_000 })
      await noOverflow(`New project form ${tag}`)
      await shot(`form-${w}x${h}-${theme}`)
      await page.keyboard.press('Escape')
      await page.locator('[data-testid=new-project-dialog]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})

      // Project A (on the proxy)
      await page.locator(`.sidebar [data-testid=nav-project][data-name="${A}"]`).first().click()
      await projectTab(page, 'Settings').click()
      await page.getByRole('tab', { name: 'General', exact: true }).click()
      await page.waitForSelector('#settings-section-connection', { timeout: 10_000 })
      await page.locator('#settings-section-connection').scrollIntoViewIfNeeded()
      const rows = page.locator('[data-testid=project-connection-option]')
      await rows.first().waitFor({ timeout: 10_000 })
      const all = await page.evaluate(() => window.orgai.connections.list())
      check((await rows.count()) === all.length, `radio list has one entry per connection (${all.length}) at ${tag}`, String(await rows.count()))
      const checkedRow = page.locator(`[data-testid=project-connection-option][data-id="${proxyId}"] input`)
      check(await checkedRow.isChecked(), `project A shows the proxy as its connection at ${tag}`)
      check(((await page.locator(`[data-testid=project-connection-option][data-id="${proxyId}"]`).textContent()) ?? '').includes(PROXY), 'the row names the proxy by its own name')
      const idleRow = page.locator(`[data-testid=project-connection-option][data-id="${idleId}"]`)
      check(await idleRow.locator('input').isDisabled(), `the not-connected proxy radio is inert at ${tag}`)
      check(/Not connected\. Connect it in App settings > Connections\./.test((await idleRow.locator('[data-testid=project-connection-why]').textContent()) ?? ''), 'the not-connected row says why')
      check((await page.locator('#settings-section-connection').getByText('This project cannot start as configured').count()) === 0, 'no mixed-family danger banner')
      await noOverflow(`Project settings > Connection ${tag}`)
      await shot(`settings-${w}x${h}-${theme}`)

      // Keyboard: arrows move between the enabled radios and skip the inert one
      await checkedRow.focus()
      const enabled = await page.evaluate(() => [...document.querySelectorAll('[data-testid=project-connection-option] input')].filter((i) => !i.disabled).map((i) => i.closest('[data-testid=project-connection-option]').dataset.id))
      await page.keyboard.press('ArrowDown')
      const nowChecked = await page.evaluate(() => document.querySelector('[data-testid=project-connection-option] input:checked')?.closest('[data-testid=project-connection-option]').dataset.id)
      check(nowChecked !== idleId && enabled.includes(nowChecked) && nowChecked !== proxyId, `ArrowDown moves the radio to another connected connection at ${tag}`, `${nowChecked}`)
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      check(await checkedRow.isChecked(), 'Cancel returns the radio to the project’s own connection')

      // Project B (on the default, usually Anthropic): pick the proxy, review the mapping
      await page.locator(`.sidebar [data-testid=nav-project][data-name="${B}"]`).first().click()
      await projectTab(page, 'Settings').click()
      await page.getByRole('tab', { name: 'General', exact: true }).click()
      await page.waitForSelector('#settings-section-connection', { timeout: 10_000 })
      await page.locator(`[data-testid=project-connection-option][data-id="${proxyId}"]`).click()
      await page.getByRole('button', { name: 'Review changes', exact: true }).click()
      const dlg = page.locator('[data-testid=remap-preview]')
      await dlg.waitFor({ timeout: 5000 })
      check((await dlg.locator('[data-testid=remap-tier-line]').count()) === 4, `the mapping dialog has a line per tier at ${tag}`)
      check(((await dlg.locator('[data-testid=remap-mapping]').textContent()) ?? '').includes(`On ${PROXY}`), 'the mapping names the target connection')
      const routeText = (await dlg.locator('[data-testid=remap-routes]').textContent().catch(() => '')) ?? ''
      check(/Anthropic URL|OpenAI URL/.test(routeText), 'the mapping says which route models take on a proxy', routeText)
      await noOverflow(`mapping dialog ${tag}`)
      await shot(`mapping-${w}x${h}-${theme}`)
      await page.keyboard.press('Escape')
      await dlg.waitFor({ state: 'hidden', timeout: 5000 })
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    }
  }
} finally {
  try {
    await deleteProject(page, B)
    await deleteProject(page, A)
    await page.evaluate(async () => {
      for (const c of await window.orgai.connections.list()) if (c.connection.name?.startsWith('E2E ')) await window.orgai.connections.removeProxy(c.connection.id).catch(() => {})
    })
  } catch {
    /* best effort */
  }
  await cleanup(app, page, A).catch(() => {})
  removeFixture(base)
}
finish('project-connection')
