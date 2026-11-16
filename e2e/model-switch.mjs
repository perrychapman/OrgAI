// Token-free: explicit model changes and recovery retain the conversation.
import { check, finish, launch, log, makeFixtureRepo, removeFixture, setReduceMotion, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const repo = makeFixtureRepo('model-switch')
const { app, page, shot } = await launch({ shotPrefix: 'model-switch' })
let view
let viewRunId
const start = async (kind, projectId, marker) => page.evaluate(async ({ kind, projectId, marker }) => {
  if (kind === 'chat') return window.orgai.runs.startQuick({ prompt: marker })
  if (kind === 'mcp') return window.orgai.mcp.startAssist({ scope: 'library', instruction: marker })
  if (kind === 'skills') return window.orgai.skills.startAssist({ scope: 'library', instruction: marker })
  if (kind === 'setup') return window.orgai.setup.start({ projectId, instruction: marker })
  return window.orgai.runs.start({ projectId, prompt: marker })
}, { kind, projectId, marker })
// Apply refuses with "The session state changed" when the run window's own status (data-run-status, what the component
// compares) differs from main's. The window keeps its own store, so after main reports a state wait until the window shows
// it too before acting on the picker (CI macOS: both Apply failures showed exactly that refusal).
async function viewShowsMainStatus() {
  const status = await page.evaluate(async (id) => (await window.orgai.runs.get(id)).summary.status, viewRunId)
  await view.waitForFunction((want) => document.querySelector('[data-testid=live-model-switch]')?.dataset.runStatus === want, status, { timeout: 15000 })
}
async function open(run) {
  viewRunId = run.id
  if (view && !view.isClosed()) await view.close()
  await page.evaluate((run) => window.orgai.window.openRun({ projectId: run.projectId, runId: run.id }), run)
  for (let i = 0; i < 40; i++) {
    view = app.windows().find((window) => window !== page)
    if (view) break
    await sleep(100)
  }
  if (!view) throw new Error('Run window did not open')
  await view.locator('[data-testid=live-model-change]').waitFor({ timeout: 20000 })
  await view.evaluate(() => {
    window.modelFocusTrace = []
    const record = (event) => {
      const panel = document.querySelector('[data-testid=live-model-picker]')
      window.modelFocusTrace.push({ at: performance.now(), type: event.type, key: event.key, old: event.oldState, next: event.newState, target: event.target?.getAttribute?.('data-testid'), active: document.activeElement?.getAttribute('data-testid'), nativeOpen: panel?.matches(':popover-open'), expanded: document.querySelector('[data-testid=live-model-change]')?.getAttribute('aria-expanded'), inert: panel?.inert })
      if (window.modelFocusTrace.length > 150) window.modelFocusTrace.shift()
    }
    for (const type of ['beforetoggle', 'toggle', 'focusin', 'focusout', 'keydown', 'click']) document.addEventListener(type, record, true)
  })
}
async function choose(connection) {
  await viewShowsMainStatus()
  const before = await view.locator('[data-testid=live-model-change]').getAttribute('title')
  const trigger = view.locator('[data-testid=live-model-change]')
  await trigger.focus()
  await view.keyboard.press('Enter')
  await view.waitForFunction(() => document.activeElement?.matches('[data-testid=live-model-search]'))
  await view.locator('[data-testid=live-model-choice]').first().waitFor({ timeout: 15000 })
  connection ||= await view.evaluate(() => document.querySelector('[data-testid=live-model-choice]:checked')?.dataset.connection)
  const adapter = await view.evaluate(() => document.querySelector('[data-testid=live-model-choice]:checked')?.dataset.adapter)
  const select = view.locator(`[data-testid=live-model-choice]${connection ? `[data-connection="${connection}"]` : ''}${adapter ? `[data-adapter="${adapter}"]` : ''}`)
  await select.first().waitFor({ timeout: 15000 })
  const current = await view.evaluate(() => document.querySelector('[data-testid=live-model-choice]:checked')?.value)
  const values = await select.evaluateAll((options) => options.filter((o) => !o.disabled).map((o) => o.value))
  const next = values.find((value) => value !== current)
  if (!next) throw new Error('Mock catalog needs two selectable models')
  await view.locator(`[data-testid=live-model-choice][value="${next}"]${connection ? `[data-connection="${connection}"]` : ''}`).first().check()
  check((await view.locator('[data-testid=live-model-change]').getAttribute('title')) === before, 'pending choice does not replace applied model')
  check(await view.locator('[data-testid=live-model-pending]').isVisible(), 'pending choice is explicitly labeled')
  return next
}
async function rapidReopen() {
  // One browser task guarantees Chromium coalesces the two native transitions
  // into a single open -> open toggle. Do not wait for React's closed state.
  await view.evaluate(async () => {
    const panel = document.querySelector('[data-testid=live-model-picker]')
    const toggled = new Promise((resolve) => panel.addEventListener('toggle', resolve, { once: true }))
    panel.hidePopover()
    const trigger = document.querySelector('[data-testid=live-model-change]')
    trigger.focus()
    trigger.click()
    await toggled
  })
  await view.waitForFunction(() => document.activeElement?.matches('[data-testid=live-model-search]'))
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
  const { project, primary, alternative } = await page.evaluate(async (repo) => {
    const proxy = await window.orgai.connections.createProxy({ name: 'Switch test gateway', kind: 'litellm', anthropicBaseUrl: 'https://mock-proxy.example.com', apiKey: 'mock-key' })
    await window.orgai.connections.connect(proxy.connection.id)
    await window.orgai.connections.setDefault(proxy.connection.id)
    const other = await window.orgai.connections.createProxy({ name: 'Recovery test gateway', kind: 'openai-compatible', anthropicBaseUrl: 'https://mock-proxy.example.com', apiKey: 'mock-key' })
    await window.orgai.connections.connect(other.connection.id)
    const created = await window.orgai.projects.create({ path: repo, name: 'Model switch test', mock: true })
    const project = await window.orgai.projects.save({ ...created, connection: proxy.connection.id, autoContinue: false })
    return { project, primary: proxy.connection.id, alternative: other.connection.id }
  }, repo)
  check(project.autoContinue === false, 'work fixture saves manual continuation')
  const initialQuick = await start('chat', '', '[mock:model-switch]')
  await page.waitForFunction(async (id) => (await window.orgai.runs.get(id))?.summary.status === 'idle', initialQuick.id)
  await open(initialQuick)
  await view.locator('.composer textarea').fill('Keep initial conversation draft.')
  const initialChoice = await choose(alternative)
  await view.locator('[data-testid=live-model-apply]').click()
  await view.locator('[data-testid=live-model-confirm]').click()
  await page.waitForFunction(async ({ id, connection, model }) => { const record = await window.orgai.runs.get(id); return record.summary.modelSelection?.connection === connection && record.summary.modelSelection?.model === model }, { id: initialQuick.id, connection: alternative, model: initialChoice })
  await sleep(1200)
  const stableQuick = await page.evaluate((id) => window.orgai.runs.get(id), initialQuick.id)
  check(stableQuick.summary.modelSelection.connection === alternative && stableQuick.summary.modelSelection.model === initialChoice, 'initial quick handoff selection survives delayed stop teardown')
  check(await view.locator('.composer textarea').inputValue() === 'Keep initial conversation draft.', 'initial quick handoff restores retained draft')
  for (const kind of ['chat', 'mcp', 'skills', 'setup', 'work']) {
    let run = await start(kind, project.id, '[mock:model-switch]')
    await page.waitForFunction(async (id) => (await window.orgai.runs.get(id))?.summary.status === 'idle', run.id, { timeout: 20000 })
    // Mock starts can retain Anthropic independently of the chosen default. Route
    // through a real saved continuation so the matrix never needs a local login.
    if (run.connection !== primary) {
      run = await page.evaluate(async ({ id, connection }) => {
        await window.orgai.runs.stop(id)
        const models = await window.orgai.models.list({ connection })
        await window.orgai.runs.switchModel({ runId: id, connection, model: models[0].id })
        return window.orgai.runs.continue({ runId: id, text: '[mock:model-switch]' })
      }, { id: run.id, connection: primary })
      await page.waitForFunction(async (id) => (await window.orgai.runs.get(id))?.summary.status === 'idle', run.id, { timeout: 20000 })
    }
    await open(run)
    await view.waitForFunction(() => !document.querySelector('[data-testid=live-model-current]')?.textContent.includes('unavailable'))
    check((await view.locator('[data-testid=live-model-change]').getAttribute('title')).includes(run.modelSelection.model), `${kind} hydrates continued model selection`)
    for (const [width, height] of [[1024, 640], [1600, 1000]]) for (const theme of ['dark', 'light']) {
      await app.evaluate(({ BrowserWindow }, { id, width, height }) => {
        const win = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes(id))
        win.setContentSize(width, height)
      }, { id: run.id, width, height })
      await page.evaluate(async (theme) => { const settings = await window.orgai.settings.get(); await window.orgai.settings.set({ ...settings, appearance: { ...settings.appearance, theme } }) }, theme)
      const draft = view.locator('.composer textarea').first()
      await draft.fill('Keep this unsent message while changing models.')
      const next = await choose(primary)
      const bounds = await view.locator('[data-testid=live-model-picker]').boundingBox()
      check(bounds.y >= 0 && bounds.y + bounds.height <= height, `${kind} expanded picker bounded ${width} ${theme}`)
      await view.screenshot({ path: `e2e/shots/model-switch-picker-${kind}-${width}-${theme}.png` })
      const apply = view.locator('[data-testid=live-model-apply]')
      await apply.focus()
      await view.keyboard.press('Enter')
      await view.locator('[data-testid=live-model-picker]').waitFor({ state: 'hidden' })
      await view.waitForFunction((next) => document.querySelector('[data-testid=live-model-change]')?.title.includes(next), next)
      check((await view.locator('[data-testid=live-model-change]').getAttribute('title')).includes(next), `${kind} applied selection ${width} ${theme}`)
      check(await view.locator('[data-testid=live-model-change]').evaluate((el) => el === document.activeElement), `${kind} returns keyboard focus ${width} ${theme}`)
      const persisted = await page.evaluate((id) => window.orgai.runs.get(id), run.id)
      check(persisted.summary.modelSelection.model === next && persisted.transcript.length > 0, `${kind} persists model and transcript ${width} ${theme}`)
      check((await draft.inputValue()) === 'Keep this unsent message while changing models.', `${kind} retains unsent draft ${width} ${theme}`)
      check(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${kind} no horizontal overflow ${width} ${theme}`)
      await view.screenshot({ path: `e2e/shots/model-switch-${kind}-${width}-${theme}.png` })
    }
    if (kind === 'chat') {
      await view.locator('[data-testid=live-model-change]').click()
      const search = view.locator('[data-testid=live-model-search]')
      await search.waitFor()
      check(await search.evaluate((el) => el === document.activeElement), 'picker opens with focus in search')
      await search.fill('no-model-can-match-this')
      await view.getByText('No models match your search.').waitFor()
      await view.keyboard.press('Escape')
      await view.locator('[data-testid=live-model-picker]').waitFor({ state: 'hidden' })
      check(await view.locator('[data-testid=live-model-change]').evaluate((el) => el === document.activeElement), 'Escape closes search picker and restores trigger')
      for (const [width, height] of [[1024, 640], [1600, 1000]]) for (const theme of ['dark', 'light']) for (const motion of ['system', 'on']) {
        await app.evaluate(({ BrowserWindow }, { id, width, height }) => {
          BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes(id)).setContentSize(width, height)
        }, { id: run.id, width, height })
        await page.evaluate(async (theme) => { const settings = await window.orgai.settings.get(); await window.orgai.settings.set({ ...settings, appearance: { ...settings.appearance, theme } }) }, theme)
        await setReduceMotion(page, motion)
        await view.locator('[data-testid=live-model-change]').click()
        await search.fill('coalesced-reopen-probe')
        await rapidReopen()
        check(await search.inputValue() === '', `coalesced close/reopen focuses and resets search ${width} ${theme} ${motion}`)
        await view.keyboard.press('Escape')
        await view.locator('[data-testid=live-model-picker]').waitFor({ state: 'hidden' })
      }
      await setReduceMotion(page, 'system')
      // Empty fresh catalog must not offer stale cached models, but the current id remains visible.
      await app.evaluate(({ ipcMain }) => {
        globalThis.modelCatalogOriginal = ipcMain._invokeHandlers.get('models:list')
        ipcMain._invokeHandlers.set('models:list', async () => [])
      })
      await view.locator('[data-testid=live-model-change]').click()
      await view.getByText('(not in the available catalog)', { exact: false }).waitFor()
      check(await view.locator('[data-testid=live-model-apply]').isDisabled(), 'empty fresh catalog cannot apply stale cached choice')
      check((await view.locator('[data-testid=live-model-change]').getAttribute('title')).includes(run.modelSelection.model), 'unavailable catalog retains exact current id')
      await view.keyboard.press('Escape')
      await app.evaluate(({ ipcMain }) => ipcMain._invokeHandlers.set('models:list', globalThis.modelCatalogOriginal))
      await choose(primary)
      const radio = view.locator('[data-testid=live-model-choice]:checked')
      const radioBefore = await radio.inputValue()
      await radio.focus()
      await view.keyboard.press('ArrowDown')
      check(await view.locator('[data-testid=live-model-choice]:checked').inputValue() !== radioBefore, 'native radio group responds to arrow keys')
      await view.locator('[data-testid=live-model-cancel]').click()
      // Dismiss and reopen while the pre-action read is pending: the captured operation must cancel.
      for (const dismissal of ['Escape', 'coalesced native close/reopen']) {
        await choose(primary)
        await app.evaluate(({ ipcMain }) => {
          const handlers = ipcMain._invokeHandlers
          const originalGet = handlers.get('runs:get'), originalSwitch = handlers.get('runs:switchModel')
          const gate = globalThis.modelDismissGate = { originalGet, originalSwitch, captured: false, release: null, switches: 0 }
          handlers.set('runs:get', async (...args) => { if (!gate.captured) { gate.captured = true; await new Promise((resolve) => { gate.release = resolve }) }; return originalGet(...args) })
          handlers.set('runs:switchModel', async (...args) => { gate.switches++; return originalSwitch(...args) })
        })
        await view.locator('[data-testid=live-model-apply]').click()
        for (let i = 0; i < 50 && !await app.evaluate(() => globalThis.modelDismissGate.captured); i++) await sleep(20)
        if (dismissal === 'Escape') {
          await view.keyboard.press('Escape')
          await view.locator('[data-testid=live-model-picker]').waitFor({ state: 'hidden' })
          await view.locator('[data-testid=live-model-change]').click()
          await view.locator('[data-testid=live-model-search]').waitFor()
        } else await rapidReopen()
        await app.evaluate(() => globalThis.modelDismissGate.release())
        await view.waitForFunction(() => document.querySelector('[data-testid=live-model-switch]')?.getAttribute('aria-busy') === 'false')
        check(await app.evaluate(() => globalThis.modelDismissGate.switches === 0), `${dismissal}: dismissed pending operation never changes reopened picker selection`)
        check(await view.locator('[data-testid=live-model-error]').textContent() === '', `${dismissal}: dismissed operation does not overwrite reopened picker error`)
        await app.evaluate(({ ipcMain }) => { const gate = globalThis.modelDismissGate; ipcMain._invokeHandlers.set('runs:get', gate.originalGet); ipcMain._invokeHandlers.set('runs:switchModel', gate.originalSwitch) })
        await view.locator('[data-testid=live-model-cancel]').click()
      }
      await choose(primary)
      await page.evaluate((id) => window.orgai.runs.send({ runId: id, text: 'A long reply to interrupt. '.repeat(200) }), run.id)
      const interrupt = view.locator('[data-testid=live-model-apply]')
      await interrupt.filter({ hasText: 'Interrupt and switch' }).waitFor()
      await interrupt.focus()
      await view.keyboard.press('Enter')
      await page.waitForFunction(async (id) => (await window.orgai.runs.get(id))?.summary.status === 'idle', run.id)
      await view.locator('[data-testid=live-model-picker]').waitFor({ state: 'hidden' })
      check(await view.locator('[data-testid=live-model-change]').evaluate((el) => el === document.activeElement), 'busy interrupt then Apply restores keyboard focus')
      check(await view.locator('.composer textarea').inputValue() === 'Keep this unsent message while changing models.', 'busy interrupt retains unsent draft')
    }
    await page.evaluate((id) => window.orgai.runs.send({ runId: id, text: 'Verify the selected model.' }), run.id)
    await page.waitForFunction(async (id) => {
      const record = await window.orgai.runs.get(id)
      return JSON.stringify(record.transcript).includes(`Mock reply (${record.summary.modelSelection.model})`)
    }, run.id, { timeout: 20000 })
    check(true, `${kind} next reply uses selected model`)
    if (kind === 'chat') {
      await page.waitForFunction(async (id) => (await window.orgai.runs.get(id))?.summary.status === 'idle', run.id)
      const before = await page.evaluate((id) => window.orgai.runs.get(id), run.id)
      const next = await choose(alternative)
      check(await view.locator(`[data-testid=live-model-choice][value="${next}"]`).count() >= 2, 'duplicate model ids retain separate connection identities')
      await view.locator('[data-testid=live-model-apply]').focus()
      await view.keyboard.press('Enter')
      await view.locator('[data-testid=live-model-confirm]').waitFor()
      await view.screenshot({ path: 'e2e/shots/model-switch-handoff-confirmation.png' })
      await view.getByRole('button', { name: 'Cancel', exact: true }).click()
      await view.locator('[data-testid=live-model-search]').waitFor()
      await view.waitForFunction(() => document.querySelectorAll('[data-testid=live-model-choice]').length > 0)
      check(await view.locator(`[data-testid=live-model-choice][data-connection="${alternative}"][value="${next}"]`).isChecked(), 'confirmation Cancel retains pending selection')
      check((await page.evaluate((id) => window.orgai.runs.get(id), run.id)).summary.status === 'idle', 'confirmation Cancel leaves session live')
      // Fail apply after a successful stop; recovery must keep selection and never stop twice.
      await app.evaluate(({ ipcMain }) => {
        const handlers = ipcMain._invokeHandlers
        const originalSwitch = handlers.get('runs:switchModel')
        const originalStop = handlers.get('runs:stop')
        globalThis.modelFailureGate = { originalSwitch, originalStop, stops: 0, switches: 0 }
        handlers.set('runs:stop', async (...args) => { globalThis.modelFailureGate.stops++; return originalStop(...args) })
        handlers.set('runs:switchModel', async (...args) => { if (++globalThis.modelFailureGate.switches === 1) throw new Error('Injected apply failure'); return originalSwitch(...args) })
      })
      await view.locator('[data-testid=live-model-apply]').click()
      await view.locator('[data-testid=live-model-confirm]').click()
      await page.waitForFunction(async (id) => (await window.orgai.runs.get(id))?.summary.status === 'finished', run.id)
      await view.getByText('The session ended, but the model was not selected.', { exact: false }).waitFor()
      await view.screenshot({ path: 'e2e/shots/model-switch-partial-failure.png' })
      await view.waitForFunction(() => document.querySelectorAll('[data-testid=live-model-choice]').length > 0)
      check(await view.locator(`[data-testid=live-model-choice][data-connection="${alternative}"][value="${next}"]`).isChecked(), 'partial failure reopens picker retaining pending connection/model')
      await view.locator('[data-testid=live-model-apply]').click()
      await view.locator('[data-testid=live-model-picker]').waitFor({ state: 'hidden' })
      await view.waitForFunction((next) => document.querySelector('[data-testid=live-model-change]')?.title.includes(next), next)
      check(await app.evaluate(() => globalThis.modelFailureGate.stops === 1 && globalThis.modelFailureGate.switches === 2), 'explicit apply recovery does not stop a second time')
      await app.evaluate(({ ipcMain }) => { const gate = globalThis.modelFailureGate; ipcMain._invokeHandlers.set('runs:stop', gate.originalStop); ipcMain._invokeHandlers.set('runs:switchModel', gate.originalSwitch) })
      check(await view.locator('[data-testid=live-model-change]').evaluate((el) => el === document.activeElement), 'handoff success restores trigger focus')
      check((await view.locator('[data-testid=live-model-current]').innerText()).startsWith('Next message:'), 'ended connection selection is staged for next message')
      const draft = view.locator('.composer textarea').first()
      check(await draft.inputValue() === 'Keep this unsent message while changing models.', 'End session and Apply retain draft')
      await draft.focus()
      await view.keyboard.press('Enter')
      await page.waitForFunction(async (id) => (await window.orgai.runs.listLive()).some((item) => item.resumedFrom === id), run.id)
      const successor = await page.evaluate(async (id) => (await window.orgai.runs.listLive()).find((item) => item.resumedFrom === id), run.id)
      check(successor.modelSelection?.connection === alternative && successor.modelSelection?.model === next, 'composer Send uses staged connection and model')
      const after = await page.evaluate((id) => window.orgai.runs.get(id), run.id)
      check(after.transcript.length >= before.transcript.length, 'connection handoff retains earlier transcript')
      await page.evaluate((id) => window.orgai.runs.stop(id), successor.id)
    }
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
    await view.locator('[data-testid=live-model-picker]').waitFor({ state: 'hidden' })
    check((await view.locator('[data-testid=live-model-change]').getAttribute('title')).includes(next), `${marker} selected recovery model`)
    const successor = await page.evaluate(({ id }) => window.orgai.runs.continue({ runId: id, text: 'Continue the same conversation.' }), { id: run.id })
    check(successor.modelSelection?.model === next && successor.modelSelection?.connection === alternative && successor.resumedFrom === run.id, `${marker} continuation retains selected model, connection and chain`)
    const after = await page.evaluate((id) => window.orgai.runs.get(id), run.id)
    check(after.transcript.length >= before.transcript.length, `${marker} earlier transcript retained`)
    await page.evaluate((id) => window.orgai.runs.stop(id), successor.id)
  }
} catch (error) {
  if (view && !view.isClosed()) log('FOCUS TRACE', JSON.stringify(await view.evaluate(() => window.modelFocusTrace)))
  check(false, 'model switch script completes', error.stack || String(error))
  if (view && !view.isClosed()) await view.screenshot({ path: 'e2e/shots/model-switch-failure.png' }).catch(() => {})
  else await shot('failure').catch(() => {})
} finally {
  await app.close().catch(() => {})
  removeFixture(repo)
}
finish('model-switch')
