// Token-free: explicit model changes and recovery retain the conversation.
import { check, finish, launch, log, makeFixtureRepo, removeFixture, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const repo = makeFixtureRepo('model-switch')
const { app, page, shot } = await launch({ shotPrefix: 'model-switch' })
let view
const start = async (kind, projectId, marker) => page.evaluate(async ({ kind, projectId, marker }) => {
  if (kind === 'chat') return window.orgai.runs.startQuick({ prompt: marker })
  if (kind === 'mcp') return window.orgai.mcp.startAssist({ scope: 'library', instruction: marker })
  if (kind === 'skills') return window.orgai.skills.startAssist({ scope: 'library', instruction: marker })
  if (kind === 'setup') return window.orgai.setup.start({ projectId, instruction: marker })
  return window.orgai.runs.start({ projectId, prompt: marker })
}, { kind, projectId, marker })
async function open(run) {
  if (view && !view.isClosed()) await view.close()
  await page.evaluate((run) => window.orgai.window.openRun({ projectId: run.projectId, runId: run.id }), run)
  for (let i = 0; i < 40; i++) {
    view = app.windows().find((window) => window !== page)
    if (view) break
    await sleep(100)
  }
  if (!view) throw new Error('Run window did not open')
  await view.locator('[data-testid=live-model-change]').waitFor({ timeout: 20000 })
}
async function choose(connection) {
  const before = await view.locator('[data-testid=live-model-current]').innerText()
  const trigger = view.locator('[data-testid=live-model-change]')
  await trigger.focus()
  await view.keyboard.press('Enter')
  if (connection) await view.locator('[data-testid=live-model-connection] select').selectOption(connection)
  const select = view.locator('[data-testid=live-model-choice]')
  await view.waitForFunction(() => {
    const el = document.querySelector('[data-testid=live-model-choice]')
    return el && !el.disabled && el.options.length > 1
  }, null, { timeout: 15000 })
  const values = await select.locator('option').evaluateAll((options) => options.filter((o) => !o.disabled && o.value).map((o) => o.value))
  const current = await select.inputValue()
  const next = values.find((value) => value !== current)
  if (!next) throw new Error('Mock catalog needs two selectable models')
  await select.selectOption(next)
  check((await view.locator('[data-testid=live-model-current]').innerText()) === before, 'pending choice does not replace applied model')
  check(await view.locator('[data-testid=live-model-pending]').isVisible(), 'pending choice is explicitly labeled')
  return next
}
try {
  const initialConnections = await page.evaluate(() => window.orgai.connections.list())
  if (!initialConnections.some((item) => item.status.state === 'connected')) {
    const offline = await start('chat', '', '[mock:model-switch]')
    await open(offline)
    await view.locator('[data-testid=live-model-change]').click()
    await view.getByText('No connection is connected.', { exact: false }).waitFor()
    check(await view.locator('[data-testid=live-model-apply]').isDisabled(), 'offline selection explains unavailable connection and disables Apply')
    await page.evaluate((id) => window.orgai.runs.stop(id), offline.id)
  } else log('SKIP offline-only feedback: an initial connection is connected')
  const { project, alternative } = await page.evaluate(async (repo) => {
    const proxy = await window.orgai.connections.createProxy({ name: 'Switch test gateway', kind: 'litellm', anthropicBaseUrl: 'https://mock-proxy.example.com', apiKey: 'mock-key' })
    await window.orgai.connections.connect(proxy.connection.id)
    await window.orgai.connections.setDefault(proxy.connection.id)
    const other = await window.orgai.connections.createProxy({ name: 'Recovery test gateway', kind: 'openai-compatible', anthropicBaseUrl: 'https://mock-proxy.example.com', apiKey: 'mock-key' })
    await window.orgai.connections.connect(other.connection.id)
    return { project: await window.orgai.projects.create({ path: repo, name: 'Model switch test', mock: true }), alternative: other.connection.id }
  }, repo)
  for (const kind of ['chat', 'mcp', 'skills', 'setup', 'work']) {
    const run = await start(kind, project.id, '[mock:model-switch]')
    await page.waitForFunction(async (id) => (await window.orgai.runs.get(id))?.summary.status === 'idle', run.id, { timeout: 20000 })
    await open(run)
    for (const [width, height] of [[1024, 640], [1600, 1000]]) for (const theme of ['dark', 'light']) {
      await app.evaluate(({ BrowserWindow }, { id, width, height }) => {
        const win = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes(id))
        win.setContentSize(width, height)
      }, { id: run.id, width, height })
      await page.evaluate(async (theme) => { const settings = await window.orgai.settings.get(); await window.orgai.settings.set({ ...settings, appearance: { ...settings.appearance, theme } }) }, theme)
      const draft = view.locator('.composer textarea').first()
      await draft.fill('Keep this unsent message while changing models.')
      const next = await choose()
      const apply = view.locator('[data-testid=live-model-apply]')
      await apply.focus()
      await view.keyboard.press('Enter')
      await view.locator('[data-testid=live-model-change]').waitFor()
      check((await view.locator('[data-testid=live-model-current]').innerText()).includes(next), `${kind} applied selection ${width} ${theme}`)
      check(await view.locator('[data-testid=live-model-change]').evaluate((el) => el === document.activeElement), `${kind} returns keyboard focus ${width} ${theme}`)
      const persisted = await page.evaluate((id) => window.orgai.runs.get(id), run.id)
      check(persisted.summary.modelSelection.model === next && persisted.transcript.length > 0, `${kind} persists model and transcript ${width} ${theme}`)
      check((await draft.inputValue()) === 'Keep this unsent message while changing models.', `${kind} retains unsent draft ${width} ${theme}`)
      check(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${kind} no horizontal overflow ${width} ${theme}`)
      await view.screenshot({ path: `e2e/shots/model-switch-${kind}-${width}-${theme}.png` })
    }
    await page.evaluate((id) => window.orgai.runs.send({ runId: id, text: 'Verify the selected model.' }), run.id)
    await page.waitForFunction(async (id) => {
      const record = await window.orgai.runs.get(id)
      return JSON.stringify(record.transcript).includes(`Mock reply (${record.summary.modelSelection.model})`)
    }, run.id, { timeout: 20000 })
    check(true, `${kind} next reply uses selected model`)
    await page.evaluate((id) => window.orgai.runs.stop(id), run.id)
  }
  for (const marker of ['[mock:model-switch-limit]', '[mock:model-switch-error]']) {
    const run = await start('chat', project.id, marker)
    await page.waitForFunction(async (id) => ['paused', 'error'].includes((await window.orgai.runs.get(id))?.summary.status), run.id, { timeout: 20000 })
    await page.evaluate((id) => window.orgai.runs.cancelAutoResume(id), run.id)
    await open(run)
    const before = await page.evaluate((id) => window.orgai.runs.get(id), run.id)
    const next = await choose(alternative)
    await view.locator('[data-testid=live-model-apply]').click()
    await view.locator('[data-testid=live-model-change]').waitFor()
    check((await view.locator('[data-testid=live-model-current]').innerText()).includes(next), `${marker} selected recovery model`)
    const successor = await page.evaluate(({ id }) => window.orgai.runs.continue({ runId: id, text: 'Continue the same conversation.' }), { id: run.id })
    check(successor.modelSelection?.model === next && successor.modelSelection?.connection === alternative && successor.resumedFrom === run.id, `${marker} continuation retains selected model, connection and chain`)
    const after = await page.evaluate((id) => window.orgai.runs.get(id), run.id)
    check(after.transcript.length >= before.transcript.length, `${marker} earlier transcript retained`)
    await page.evaluate((id) => window.orgai.runs.stop(id), successor.id)
  }
} catch (error) {
  check(false, 'model switch script completes', error.stack || String(error))
  if (view && !view.isClosed()) await view.screenshot({ path: 'e2e/shots/model-switch-failure.png' }).catch(() => {})
  else await shot('failure').catch(() => {})
} finally {
  await app.close().catch(() => {})
  removeFixture(repo)
}
finish('model-switch')
