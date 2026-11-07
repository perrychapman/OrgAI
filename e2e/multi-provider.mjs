// Token-free (mock). Multi-provider org charts in the renderer (docs/design/multi-provider.md "Renderer"):
// - Team: the Reviewer is pinned to a mock proxy through "Runs on" (role-runs-on); the node chip names the provider
//   (role-model-chip[data-connection]) and the Model fold summary too.
// - Project settings: project-connection-roles-line counts the pinned role; a connection switch preview lists it under
//   "Not changed (own connection)" (remap-kept).
// - A [mock:bridged] run on the mock project shows the bridged agent with its provider tag (agent-connection) and it
//   finishes.
// - With the proxy turned off: project-start-refusal, new-run-start-refusal (Start stays enabled) and
//   role-runs-on-problem name the role and the proxy.
// Static checks run at 1024x640 and 1600x1000 in dark and light, with no page scroll.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, cleanup, createProject, deleteProject, endSession, finish, findProject, gotoProjects, launch, makeFixtureRepo, openProject, openTeam, projectTab, removeFixture, runRecordsDir, sleep, teamPanelTab } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const M = 'E2E multi mock (orgai test)'
const R = 'E2E multi real (orgai test)'
const PROXY = 'E2E pinned gateway'
const OTHER = 'E2E switch gateway'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-multi-'))
const repoM = path.join(base, 'repo-m')
const repoR = path.join(base, 'repo-r')
makeFixtureRepo('multi-m', { at: repoM })
makeFixtureRepo('multi-r', { at: repoR })

const { app, page, shot } = await launch({ shotPrefix: 'multi' })
const noOverflow = async (what) => {
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight }))
  check(ov.sw <= ov.cw && ov.sh <= ov.ch + 1, `no page scroll or overflow: ${what}`, JSON.stringify(ov))
}
const resize = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await sleep(400)
}

async function selectReviewer() {
  await page.locator('.react-flow__node', { hasText: 'Reviewer' }).first().click()
  await teamPanelTab(page, 'Role').waitFor()
  // The Model fold starts closed on short windows; re-open it if a re-render remounts the panel.
  await page.waitForFunction(
    () => {
      const fold = document.querySelector('[data-testid=role-model-fold]')
      if (fold && !fold.open) fold.open = true
      const sel = document.querySelector('[data-testid=role-runs-on]')
      return !!sel && sel.getClientRects().length > 0
    },
    undefined,
    { timeout: 20_000, polling: 100 }
  )
}

/** Pin the Reviewer of `name` to `id` through the Runs on select; returns the stored role. */
async function pinReviewer(name, id) {
  await openProject(page, name)
  await openTeam(page)
  await selectReviewer()
  const sel = page.locator('[data-testid=role-runs-on]')
  const labels = (await sel.locator('option').allTextContents()).map((t) => t.trim())
  check(/^Project default \(/.test(labels[0] ?? ''), `Runs on starts with "Project default (...)" on ${name}`, labels.join(' | '))
  check(labels.some((l) => l.startsWith(PROXY)), 'Runs on lists the proxy by its own name', labels.join(' | '))
  const order = await page.evaluate(() => {
    const fold = document.querySelector('[data-testid=role-model-fold]')
    const runs = fold?.querySelector('[data-testid=role-runs-on]')
    const model = fold?.querySelector('[data-testid=role-model]')
    return !!runs && !!model && !!(runs.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING)
  })
  check(order, 'Runs on is the first control in the Model fold, above Model')
  await sel.selectOption(id)
  await sleep(900)
  const p = await findProject(page, name)
  return p.roles.find((r) => r.name === 'Reviewer')
}

let proxyId = null
try {
  // --- Projects first, so both land on the built-in default (never on a proxy made below): one on the mock adapter
  // (for the run), one on a real adapter (for the switch preview and the refusals).
  const projM = await createProject(page, { mode: 'existing', path: repoM, name: M })
  check(projM?.provider?.id === 'mock', 'mock project created')
  const projR = await createProject(page, { mode: 'existing', path: repoR, name: R, useMock: false })
  check(!!projR && projR.provider.id !== 'mock', 'real-adapter project created', String(projR?.provider?.id))

  // Two connected mock proxies (made-up keys on the mock host): one to pin to, one to switch the project to.
  const ids = await page.evaluate(async ([a, b]) => {
    const one = await window.orgai.connections.createProxy({ name: a, kind: 'litellm', anthropicBaseUrl: 'https://mock-proxy.example.com', apiKey: 'any-key' })
    await window.orgai.connections.connect(one.connection.id)
    const two = await window.orgai.connections.createProxy({ name: b, kind: 'openai-compatible', anthropicBaseUrl: 'https://mock-proxy.example.com', apiKey: 'any-key' })
    await window.orgai.connections.connect(two.connection.id)
    return [one.connection.id, two.connection.id]
  }, [PROXY, OTHER])
  proxyId = ids[0]
  const otherId = ids[1]
  await sleep(800)
  const listed = await page.evaluate(() => window.orgai.connections.list())
  check(listed.filter((c) => c.status.state === 'connected').some((c) => c.connection.id === proxyId), 'the pinned proxy is connected')

  check(![proxyId, otherId].includes(projM.provider.connection) && ![proxyId, otherId].includes(projR.provider.connection), 'neither project is on a test proxy')
  // The proxies appear in the open views once the store reloads its connection list.
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 30_000 })

  const pinnedM = await pinReviewer(M, proxyId)
  check(pinnedM?.connection === proxyId, 'picking the proxy in Runs on stores Role.connection', String(pinnedM?.connection))
  const chip = page.locator(`[data-testid=role-model-chip][data-connection="${proxyId}"]`)
  await chip.waitFor({ timeout: 10_000 })
  check(((await chip.textContent()) ?? '').includes(PROXY), 'the node chip adds the provider ("Everyday · <proxy>")', (await chip.textContent()) ?? '')
  check(/^Runs on /.test((await chip.getAttribute('title')) ?? ''), 'the chip tooltip names the provider in full', (await chip.getAttribute('title')) ?? '')
  const summary = (await page.locator('[data-testid=role-model-fold] > summary').innerText()).replace(/\s+/g, ' ')
  check(summary.includes(`Runs on ${PROXY}`), 'the Model fold summary reads "<tier> · Runs on <name>" when pinned', summary)
  const hint = ((await page.locator('[data-testid=role-runs-on-hint]').textContent()) ?? '').replace(/\s+/g, ' ')
  check(hint.includes('its own session') && hint.includes('answers its lead once and cannot be messaged') && hint.includes('not bridged'), 'the Runs on hint states the bridged limits', hint)
  check(!hint.includes('no worktree'), 'a read-only role gets no worktree line', hint)
  const describedBy = await page.locator('[data-testid=role-runs-on]').getAttribute('aria-describedby')
  check(!!describedBy && (await page.locator(`[id="${describedBy}"]`).count()) === 1, 'Runs on keeps aria-describedby on the hint', String(describedBy))
  check((await page.locator('[data-testid=role-model-fold] .role-fold-summary').count()) === 1, 'one fold summary')
  // Keyboard: Runs on is a focusable native select.
  await page.locator('[data-testid=role-runs-on]').focus()
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'role-runs-on'), 'Runs on takes keyboard focus')
  await shot('team-pinned')

  // Project default clears the pin, then pin again.
  await page.locator('[data-testid=role-runs-on]').selectOption('')
  await sleep(900)
  const said = await page.evaluate(() => [...document.querySelectorAll('[role=status]')].map((e) => e.textContent).join(' | '))
  check(/Runs on the project default/.test(said), 'changing Runs on is announced through a polite status region', said.slice(0, 200))
  check((await findProject(page, M)).roles.find((r) => r.name === 'Reviewer')?.connection === undefined, '"Project default" clears Role.connection')
  await page.locator('[data-testid=role-runs-on]').selectOption(proxyId)
  await sleep(900)

  // The root has no Runs on; its Model section says where it runs.
  await page.locator('.react-flow__node', { hasText: 'Orchestrator' }).first().click()
  await page.waitForFunction(() => !!document.querySelector('[data-testid=role-model-fold]'), undefined, { timeout: 10_000 })
  await page.evaluate(() => { const f = document.querySelector('[data-testid=role-model-fold]'); if (f) f.open = true })
  const rootLine = page.locator('[data-testid=role-runs-on-root]')
  await rootLine.waitFor({ timeout: 10_000 })
  check(/The orchestrator runs on the project's connection \(.+\); change it in Project settings > Connection\./.test((await rootLine.textContent()) ?? ''), 'the root role shows its one quiet "runs on" line', (await rootLine.textContent()) ?? '')
  check((await page.locator('[data-testid=role-runs-on]').count()) === 0, 'the root has no Runs on select')

  // --- Bridged run: the Reviewer runs as a bridged report on the proxy
  await projectTab(page, 'Live').click()
  await page.locator('.new-run').waitFor({ timeout: 10_000 })
  const ta = page.locator('.composer textarea')
  await ta.fill('Bridged check [mock:bridged]')
  await page.locator('.composer .btn.primary').click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
  const tag = page.locator(`.agent-node [data-testid=agent-connection][data-connection="${proxyId}"]`).first()
  await tag.waitFor({ timeout: 30_000 }).catch(() => {})
  check((await tag.count()) === 1 && ((await tag.textContent()) ?? '').includes(PROXY), 'the bridged agent shows its provider tag on the canvas')
  check(((await tag.getAttribute('title')) ?? '').includes(PROXY), 'the agent tag title names the provider in full')
  const handleW = await tag.evaluate((t) => t.parentElement?.firstElementChild?.getBoundingClientRect().width ?? 0)
  check(handleW >= 40, 'the handle stays readable beside the provider tag', String(handleW))
  const bridgedNode =page.locator('.agent-node', { has: page.locator('[data-testid=agent-connection]') }).first()
  await page.waitForFunction(() => {
    const n = [...document.querySelectorAll('.agent-node')].find((e) => e.querySelector('[data-testid=agent-connection]'))
    return !!n && n.classList.contains('state-done')
  }, undefined, { timeout: 30_000 }).catch(() => {})
  check(/state-done/.test((await bridgedNode.getAttribute('class')) ?? ''), 'the bridged report finishes', (await bridgedNode.getAttribute('class')) ?? '')
  // The child's answer reaches the run record (the bridged agent's transcript and the root's delegate_agent result).
  let answered = false
  for (let i = 0; i < 20 && !answered; i++) {
    const dir = runRecordsDir()
    answered = fs.existsSync(dir) && fs.readdirSync(dir).some((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes('Mock bridged report done.'))
    if (!answered) await sleep(500)
  }
  check(answered, 'the bridged report\'s answer ("Mock bridged report done.") is in the run record')
  // The side panel inspector of the bridged agent says where it runs.
  await bridgedNode.click()
  const meta = page.locator('[data-testid=agent-meta] [data-testid=agent-connection], .side-panel [data-testid=agent-connection]').first()
  await meta.waitFor({ timeout: 5000 }).catch(() => {})
  check((await meta.count()) === 1, 'the agent inspector names the provider')
  await shot('bridged-run')
  await endSession(page)

  // --- Project settings of the mock project: roles line
  await projectTab(page, 'Settings').click()
  await page.getByRole('tab', { name: 'General', exact: true }).click()
  const rolesLine = page.locator('[data-testid=project-connection-roles-line]')
  await rolesLine.waitFor({ timeout: 10_000 })
  check(/1 runs on its own connection/.test((await rolesLine.textContent()) ?? ''), 'the roles line counts the pinned role', (await rolesLine.textContent()) ?? '')
  const note = page.locator('[data-testid=project-connection-bridged-note]')
  check((await note.count()) === 1 && /cannot be messaged/.test((await note.textContent()) ?? ''), 'the bridged limit note sits beside the roles line')

  // --- Real project: pin, then preview a connection switch
  const pinnedR = await pinReviewer(R, proxyId)
  check(pinnedR?.connection === proxyId, 'Reviewer pinned on the real-adapter project')
  await projectTab(page, 'Settings').click()
  await page.getByRole('tab', { name: 'General', exact: true }).click()
  await page.waitForSelector('#settings-section-connection', { timeout: 10_000 })
  await page.locator(`[data-testid=project-connection-option][data-id="${otherId}"]`).click()
  await page.getByRole('button', { name: 'Review changes', exact: true }).click()
  const dlg = page.locator('[data-testid=remap-preview]')
  await dlg.waitFor({ timeout: 5000 })
  const kept = dlg.locator('[data-testid=remap-kept-role]')
  check((await dlg.locator('[data-testid=remap-kept]').count()) === 1 && /Reviewer stays on/.test((await kept.first().textContent()) ?? ''), 'the switch preview lists the pinned role under "Not changed (own connection)"', (await kept.first().textContent().catch(() => '')) ?? '')
  check(((await kept.first().textContent()) ?? '').includes(PROXY), 'the kept row names the role\'s own provider')
  await shot('remap-kept')
  await page.keyboard.press('Escape')
  await dlg.waitFor({ state: 'hidden', timeout: 5000 })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()

  // --- Turn the pinned proxy off: the refusal shows before Start, Start stays enabled
  await page.evaluate(async (id) => {
    const c = (await window.orgai.connections.list()).find((x) => x.connection.id === id)
    await window.orgai.connections.update({ ...c.connection, enabled: false })
  }, proxyId)
  await sleep(1200)

  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await resize(w, h)
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      const at = `${w}x${h} ${theme}`

      await openProject(page, R)
      await projectTab(page, 'Settings').click()
      await page.getByRole('tab', { name: 'General', exact: true }).click()
      const refusal = page.locator('[data-testid=project-start-refusal]')
      await refusal.waitFor({ timeout: 10_000 }).catch(() => {})
      const rt = (await refusal.textContent().catch(() => '')) ?? ''
      check(/Reviewer runs on/.test(rt) && rt.includes(PROXY), `Project settings shows the role's connection refusal at ${at}`, rt)
      await noOverflow(`Project settings ${at}`)
      await shot(`settings-${w}x${h}-${theme}`)

      await projectTab(page, 'Live').click()
      await page.locator('.new-run').waitFor({ timeout: 10_000 })
      const nr = page.locator('[data-testid=new-run-start-refusal]')
      await nr.waitFor({ timeout: 10_000 }).catch(() => {})
      check(((await nr.textContent().catch(() => '')) ?? '').includes('Reviewer'), `New run shows the refusal before Start at ${at}`)
      // Start stays enabled once there is a prompt (the run's own refusal is the truth); nothing is started here.
      await page.locator('.composer textarea').fill('Not started')
      check(await page.locator('.composer .btn.primary').isEnabled(), `Start stays enabled at ${at}`)
      await page.locator('.composer textarea').fill('')
      await noOverflow(`New run ${at}`)
      await shot(`newrun-${w}x${h}-${theme}`)

      await openTeam(page)
      await selectReviewer()
      const prob = page.locator('[data-testid=role-runs-on-problem]')
      check(((await prob.textContent().catch(() => '')) ?? '').includes(PROXY), `the role panel explains the problem under Runs on at ${at}`)
      const runsOnVal = await page.locator('[data-testid=role-runs-on]').inputValue()
      check(runsOnVal === proxyId, `the turned-off pin stays visible in Runs on at ${at}`, runsOnVal)
      check(((await page.locator(`[data-testid=role-model-chip][data-connection="${proxyId}"]`).textContent().catch(() => '')) ?? '').includes(PROXY), `the chip still names the provider at ${at}`)
      await noOverflow(`Team role panel ${at}`)
      await shot(`team-${w}x${h}-${theme}`)
    }
  }
} finally {
  try {
    await endSession(page).catch(() => {})
    await deleteProject(page, R)
    await deleteProject(page, M)
    await page.evaluate(async () => {
      for (const c of await window.orgai.connections.list()) if (c.connection.name?.startsWith('E2E ')) await window.orgai.connections.removeProxy(c.connection.id).catch(() => {})
    })
  } catch {
    /* best effort */
  }
  await gotoProjects(page).catch(() => {})
  await cleanup(app, page, M).catch(() => {})
  removeFixture(base)
}
finish('multi-provider')
