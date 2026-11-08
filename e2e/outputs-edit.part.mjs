// Token-free part of the Outputs 2 e2e, called by e2e/outputs-versions.mjs while a project with markdown, csv, json and mermaid
// outputs (two versions each) is open on the Outputs tab or the run's Outputs side tab (docs/design/outputs-2.md section 9).
// Drives the in-app editors: markdown edit + Save, the CSV cell grid by keyboard, invalid JSON blocking Save, a stale save, the
// dirty guard and that no page scrolls. A step logs SKIP when the shell's testid it needs is not rendered yet.
//   export default async function (ctx) with ctx = { app, page, project, label, size: [w, h], theme, check, sleep }

const ROW = '[data-testid=output-row], [data-testid=run-output-row]'
const DETAIL = '[data-testid=output-detail]'

/** Selects the output of a kind (the first row) and waits for its detail. Returns the row's id, or null when there is none. */
async function openKind(page, kind) {
  const row = page.locator(`:is(${ROW})[data-kind="${kind}"]`).first()
  if ((await row.count()) === 0) return null
  const id = await row.getAttribute('data-id')
  // Rows in the run tab have a Show button; the project list selects on a click.
  const show = row.locator('[data-testid=run-output-show]')
  if ((await show.count()) > 0) await show.click()
  else await row.click()
  await page.waitForSelector(DETAIL, { timeout: 8000 }).catch(() => undefined)
  return id
}

async function startEdit(page) {
  const btn = page.locator('[data-testid=output-edit]').first()
  if ((await btn.count()) === 0) return false
  await btn.click()
  await page.waitForSelector('[data-testid=output-editor]', { timeout: 8000 }).catch(() => undefined)
  return (await page.locator('[data-testid=output-editor]').count()) > 0
}

async function noPageScroll(page) {
  return page.evaluate(() => {
    const d = document.documentElement
    return d.scrollHeight <= d.clientHeight + 1 && d.scrollWidth <= d.clientWidth + 1
  })
}

async function spoken(page, re, timeout = 6000) {
  return page
    .waitForFunction((src) => new RegExp(src).test(document.body.textContent ?? ''), re.source, { timeout })
    .then(() => true)
    .catch(() => false)
}

async function leaveEditor(page) {
  const close = page.locator('[data-testid=output-edit-close]').first()
  if ((await close.count()) === 0) return
  await close.click()
  // A dirty editor asks first: answer Don't save when a dialog appears.
  const dont = page.getByRole('button', { name: /Don.t save|Discard/i }).first()
  if (await dont.isVisible().catch(() => false)) await dont.click()
  await page.waitForSelector('[data-testid=output-editor]', { state: 'detached', timeout: 4000 }).catch(() => undefined)
}

export default async function (ctx) {
  const { app, page, label, check, sleep } = ctx
  const log = (s) => console.log(`  [outputs-edit ${label}] ${s}`)
  const skip = (why) => log(`SKIP ${why}`)

  // ---------- markdown: edit, Save makes a version ----------
  const mdId = await openKind(page, 'markdown')
  if (!mdId) return skip('no markdown output')
  if (!(await startEdit(page))) return skip('output-edit is not rendered yet (shell testid)')
  check((await page.locator('[data-testid=output-editor][data-kind=markdown]').count()) === 1, `${label}: markdown editor opens`)
  check(
    await page.evaluate(() => document.activeElement?.matches('[data-testid=output-edit-area]') ?? false),
    `${label}: focus is in the markdown source`
  )
  check((await page.locator('[data-testid=output-edit-dirty]').textContent())?.trim() === 'No changes', `${label}: bar says No changes at first`)
  check((await page.locator('[data-testid=output-save]').getAttribute('aria-disabled')) === 'true', `${label}: Save is inert with no changes`)
  const area = page.locator('[data-testid=output-edit-area]')
  const before = await area.inputValue()
  await area.fill(`${before}\n\nAdded in the editor.\n`)
  await sleep(350)
  check((await page.locator('[data-testid=output-edit-rendered]').textContent())?.includes('Added in the editor.') === true, `${label}: rendered side follows the source`)
  check((await page.locator('[data-testid=output-edit-dirty]').textContent())?.trim() === 'Unsaved changes', `${label}: bar says Unsaved changes`)
  check(await noPageScroll(page), `${label}: no page scroll while editing markdown`)
  // Hold the first IPC request after capture, then type a newer draft before it completes.
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers.get('outputs:saveEdit')
    if (!original) throw new Error('outputs:saveEdit handler missing')
    globalThis.outputSaveGate = { original, captured: null, release: null, result: null }
    handlers.set('outputs:saveEdit', async (...args) => {
      const gate = globalThis.outputSaveGate
      const wait = new Promise((resolve) => { gate.release = resolve })
      gate.captured = args[1]
      await wait
      const result = await original(...args)
      gate.result = result
      return result
    })
  })
  await page.keyboard.press('Control+s')
  let captured = null
  try {
    for (let i = 0; i < 100 && !captured; i++) {
      captured = await app.evaluate(() => globalThis.outputSaveGate.captured)
      if (!captured) await sleep(100)
    }
    if (!captured) throw new Error('first save did not reach the delayed IPC handler')
    await area.focus()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('Newer draft while saving.')
  } finally {
    await app.evaluate(({ ipcMain }) => {
      const gate = globalThis.outputSaveGate
      ipcMain._invokeHandlers.set('outputs:saveEdit', gate.original)
      gate.release?.()
    })
  }
  check(await spoken(page, /Newer changes are not saved\./), `${label}: delayed save announces newer changes`)
  const result = await app.evaluate(() => globalThis.outputSaveGate.result)
  if (!result?.ok) throw new Error('first save did not complete')
  const persisted = await page.evaluate(async ({ input, result }) => window.orgai.outputs.readSource({ projectId: input.projectId, outputId: input.outputId, version: result.version }), { input: captured, result })
  check(persisted.text === captured.text, `${label}: first save persists the captured text`)
  check((await page.locator('[data-testid=output-editor]').count()) === 1, `${label}: newer draft stays open`)
  check((await area.inputValue()).endsWith('Newer draft while saving.'), `${label}: newer typed draft is preserved`)
  check((await page.locator('[data-testid=output-edit-dirty]').textContent())?.trim() === 'Unsaved changes', `${label}: newer draft remains dirty`)
  await page.locator('[data-testid=output-save]').click()
  const savedMd = await spoken(page, /Saved as version \d+\./)
  check(savedMd, `${label}: Ctrl+S saves and says "Saved as version N."`)
  await page.waitForSelector('[data-testid=output-editor]', { state: 'detached', timeout: 6000 }).catch(() => undefined)
  check((await page.locator('[data-testid=output-editor]').count()) === 0, `${label}: back to the preview after Save`)
  const latest = await page.evaluate(async (input) => {
    const output = (await window.orgai.outputs.list(input.projectId)).find((item) => item.id === input.outputId)
    return output ? window.orgai.outputs.readSource({ projectId: input.projectId, outputId: input.outputId, version: output.version }) : null
  }, captured)
  check(latest?.text?.endsWith('Newer draft while saving.') === true, `${label}: second save persists the newer draft`)

  // ---------- csv: the grid by keyboard ----------
  const csvId = await openKind(page, 'csv')
  if (!csvId) skip('no csv output')
  else if (await startEdit(page)) {
    const grid = page.locator('[data-testid=output-grid-editor]')
    if ((await grid.count()) === 0) skip('csv opened as text (grid not offered for this file)')
    else {
      check((await grid.getAttribute('role')) === 'grid', `${label}: csv grid has role=grid`)
      check(Number(await grid.getAttribute('aria-rowcount')) > 1 && Number(await grid.getAttribute('aria-colcount')) > 1, `${label}: grid names its row and column counts`)
      check(await page.evaluate(() => document.activeElement?.matches('[data-testid=output-grid-editor] [data-active=true]') ?? false), `${label}: focus is on the active cell`)
      const active = () => page.evaluate(() => {
        const el = document.querySelector('[data-testid=output-grid-editor] [data-active=true]')
        return el ? `${el.getAttribute('data-r')},${el.getAttribute('data-c')}` : ''
      })
      const tabStops = await page.locator('[data-testid=output-grid-editor] [tabindex="0"]').count()
      check(tabStops === 1, `${label}: the grid is one Tab stop`, `found ${tabStops}`)
      check((await active()) === '0,0', `${label}: starts at A1`)
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowDown')
      check((await active()) === '1,1', `${label}: arrows move the active cell`, await active())
      await page.keyboard.press('Control+Home')
      check((await active()) === '0,0', `${label}: Ctrl+Home goes to A1`)
      await page.keyboard.press('End')
      const endC = Number((await active()).split(',')[1])
      check(endC > 0, `${label}: End goes to the last column`)
      await page.keyboard.press('Home')
      await page.keyboard.press('Shift+ArrowDown')
      check((await page.locator('[data-testid=output-grid-editor] [aria-selected=true]').count()) >= 2, `${label}: Shift+arrow extends a range with aria-selected`)
      await page.keyboard.press('ArrowDown')
      const r1 = (await active()).split(',')[0]
      // Enter edits, Esc cancels.
      const cellAt = (r, c) => page.locator(`[data-testid=output-grid-editor] [data-r="${r}"][data-c="${c}"]`)
      const [cr, cc] = (await active()).split(',')
      const was = (await cellAt(cr, cc).textContent()) ?? ''
      await page.keyboard.press('Enter')
      check((await page.locator('[data-testid=output-grid-input]').count()) === 1, `${label}: Enter opens the one cell input`)
      await page.keyboard.type('cancelled')
      await page.keyboard.press('Escape')
      check((await page.locator('[data-testid=output-grid-input]').count()) === 0, `${label}: Esc closes the input`)
      check(((await cellAt(cr, cc).textContent()) ?? '') === was, `${label}: Esc leaves the cell as it was`)
      check((await page.locator('[data-testid=output-editor]').count()) === 1, `${label}: Esc in a cell does not close the editor`)
      // Typing edits; Enter commits and moves down.
      // A value unique to this pass: an earlier size / theme pass saved its own into the same cell.
      const typed = `z${Date.now() % 100000}`
      await page.keyboard.type(typed)
      await page.keyboard.press('Enter')
      check(((await cellAt(cr, cc).textContent()) ?? '') === typed, `${label}: typing then Enter commits the cell`)
      // On the last row Enter commits and stays (there is no row below). aria-rowcount also counts the letters row.
      const lastRow = await page.evaluate(() => Math.max(...Array.from(document.querySelectorAll('[data-testid=output-grid-editor] [data-r]')).map((e) => Number(e.getAttribute('data-r')))))
      const downRow = Math.min(Number(cr) + 1, lastRow)
      check((await active()) === `${downRow},${cc}`, `${label}: Enter commits down`, `${await active()}, last row ${lastRow}`)
      check((await page.locator('[data-testid=output-edit-dirty]').textContent())?.trim() === 'Unsaved changes', `${label}: a cell edit makes the bar dirty`)
      // Undo.
      await page.keyboard.press('Control+z')
      check(((await cellAt(cr, cc).textContent()) ?? '') === was, `${label}: Ctrl+Z puts the cell back`)
      await page.keyboard.press('Control+y')
      check(((await cellAt(cr, cc).textContent()) ?? '') === typed, `${label}: Ctrl+Y redoes it`)
      // Tools.
      const rows0 = Number(await grid.getAttribute('data-rows'))
      await page.locator('[data-testid=output-grid-add-row]').click()
      check(Number(await grid.getAttribute('data-rows')) === rows0 + 1, `${label}: Add row adds one`)
      await page.locator('[data-testid=output-grid-undo]').click()
      check(Number(await grid.getAttribute('data-rows')) === rows0, `${label}: Undo button removes it again`)
      void r1
      check(await noPageScroll(page), `${label}: no page scroll in the grid`)
      await page.locator('[data-testid=output-save]').click()
      check(await spoken(page, /Saved as version \d+\./), `${label}: csv saves a version`)
      await page.waitForSelector('[data-testid=output-editor]', { state: 'detached', timeout: 6000 }).catch(() => undefined)
    }
  } else skip('csv editor did not open')

  // ---------- json: invalid text blocks Save with its reason ----------
  const jsonId = await openKind(page, 'json')
  if (!jsonId) skip('no json output')
  else if (await startEdit(page)) {
    const area2 = page.locator('[data-testid=output-edit-area]')
    await area2.fill('{\n  "a": 1\n  "b": 2\n}')
    const status = page.locator('[data-testid=output-json-status]')
    check((await status.getAttribute('data-valid')) === 'false' && /^Line \d+: /.test((await status.textContent()) ?? ''), `${label}: invalid JSON says which line`, await status.textContent())
    check((await page.locator('[data-testid=output-save]').getAttribute('aria-disabled')) === 'true', `${label}: invalid JSON blocks Save`)
    check(((await page.locator('[data-testid=output-edit-reason]').textContent()) ?? '').length > 0, `${label}: the reason is visible text`)
    // Unique per pass, so the formatted text is never what an earlier pass saved (else the editor is not dirty).
    await area2.fill(JSON.stringify({ a: 1, b: [2, 3], pass: label }))
    check((await status.textContent())?.trim() === 'Valid JSON.', `${label}: valid JSON says Valid JSON.`)
    await page.locator('[data-testid=output-json-format]').click()
    check(((await area2.inputValue()).includes('\n  "a": 1')), `${label}: Format uses 2 spaces`)

    // ---------- dirty guard: leaving by tab asks first ----------
    const versionsTab = page.getByRole('tab', { name: /Versions/i }).first()
    if ((await versionsTab.count()) === 0) skip('no Versions tab yet (dirty guard)')
    else {
      await versionsTab.click()
      const dlg = page.getByRole('dialog').first()
      const asked = await dlg.isVisible().catch(() => false)
      check(asked, `${label}: leaving a dirty editor by tab asks first`)
      if (asked) {
        await page.getByRole('button', { name: /^Cancel$/ }).first().click()
        check((await page.locator('[data-testid=output-editor]').count()) === 1, `${label}: Cancel keeps the editor and its changes`)
      }
    }

    // ---------- stale save: a version is made behind the editor's back ----------
    const made = await page.evaluate(async (outputId) => {
      const api = window.orgai.outputs
      const projects = await window.orgai.projects.list()
      for (const p of projects) {
        try {
          const list = await api.list(p.id)
          const hit = list.find((o) => o.id === outputId)
          if (!hit) continue
          const ref = { projectId: p.id, outputId }
          const src = await api.readSource({ ...ref, version: hit.version ?? 1 })
          if (!('text' in src)) return 'no-source'
          const r = await api.saveEdit({ ...ref, baseVersion: hit.version ?? 1, text: '{"made":"behind your back"}\n' })
          return 'ok' in r ? 'ok' : 'refused'
        } catch {
          // Try the next project.
        }
      }
      return 'no-project'
    }, jsonId)
    if (made !== 'ok') skip(`could not make a version behind the editor (${made})`)
    else {
      await sleep(400)
      check((await page.locator('[data-testid=output-editor]').count()) === 1, `${label}: a new version does not reset the open editor`)
      await page.locator('[data-testid=output-save]').click()
      await page.waitForSelector('[data-testid=output-edit-stale]', { timeout: 6000 }).catch(() => undefined)
      const stale = page.locator('[data-testid=output-edit-stale]')
      check((await stale.count()) === 1 && /was made while you were editing\. Your changes are still here\./.test((await stale.textContent()) ?? ''), `${label}: stale save shows its sentence`)
      check(/Save as version \d+ anyway/.test((await page.locator('[data-testid=output-save-anyway]').textContent()) ?? ''), `${label}: offers "Save as version N anyway"`)
      check((await area2.inputValue()).includes('"b"'), `${label}: the changes are still in the editor`)
      check(await noPageScroll(page), `${label}: no page scroll with the stale bar`)
      await page.locator('[data-testid=output-save-anyway]').click()
      check(await spoken(page, /Saved as version \d+\./), `${label}: Save anyway makes the next version`)
    }
    await leaveEditor(page)
  } else skip('json editor did not open')

  // ---------- mermaid: Split edit goes through the editor bar ----------
  const mmId = await openKind(page, 'mermaid')
  if (!mmId) skip('no mermaid output')
  else if (await startEdit(page)) {
    check((await page.locator('[data-testid=output-editor][data-kind=mermaid]').count()) === 1, `${label}: diagram editor opens`)
    const src = page.locator('[data-testid=diagram-source]')
    await src.waitFor({ timeout: 8000 }).catch(() => undefined)
    if ((await src.count()) === 0) skip('diagram source not shown')
    else {
      check((await page.locator('[data-testid=diagram-scratch-note]').count()) === 0, `${label}: no scratch note in the real editor`)
      await src.fill(`${await src.inputValue()}\n`)
      await src.press('End')
      check((await page.locator('[data-testid=output-edit-dirty]').textContent())?.trim() === 'Unsaved changes', `${label}: diagram edit makes the bar dirty`)
      check(await noPageScroll(page), `${label}: no page scroll in the diagram editor`)
      await page.locator('[data-testid=output-discard]').click()
      const confirm = page.locator('[data-testid=output-discard-confirm]')
      if (await confirm.isVisible().catch(() => false)) await confirm.click()
      await sleep(200)
      check((await page.locator('[data-testid=output-edit-dirty]').textContent())?.trim() === 'No changes', `${label}: Discard returns to No changes`)
    }
    await leaveEditor(page)
  } else skip('diagram editor did not open')
}
