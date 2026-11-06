// Token- and network-free (ORGAI_MOCK=1). Walks "Your presets" in App settings > Connectors: add a remote preset through
// the form (token sign-in, two access options), see its tile ("Yours") and the Yours filter chip, open its dialog (custom
// note, address), edit it from the dialog and from the section, add a program preset, duplicate, remove, and the refusal
// to remove a preset that is added to the library. Layout and theme checks at 1024x640 and 1600x1000.
// Needs the runtime side (window.orgai.connectorPresets); without it the script prints SKIP and exits 0.
import { check, finish, launch, openAppSettings, sleep, windowShift } from './lib.mjs'

process.env.ORGAI_MOCK = '1'

const { app, page, shot } = await launch({ shotPrefix: 'pre' })
const hasRuntime = await page.evaluate(() => typeof window.orgai.connectorPresets !== 'undefined')
if (!hasRuntime) {
  console.log('SKIP (runtime not merged)')
  await app.close().catch(() => {})
  process.exit(0)
}

const tile = (id) => page.locator(`[data-testid=connector-tile][data-connector=${id}]`)
const row = (id) => page.locator(`[data-testid=preset-row][data-preset=${id}]`)
const dialog = () => page.locator('[data-testid=connector-dialog]')
const form = () => page.locator('[data-testid=preset-form]')
const field = (id) => form().locator(`[data-testid=${id}]`)
const chip = (f) => page.locator(`[data-testid=connector-filter][data-filter=${f}]`)
const noHScroll = async (what) => {
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
  check(ov.sw <= ov.cw, `no horizontal scroll: ${what}`, JSON.stringify(ov))
}
const focused = () => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? '')
/** True once focus is on the element with this test id (bounded wait: focus moves in a timer or frame after the render). The check still fails when it never arrives. */
const focusOn = (testid, ms = 5_000) =>
  page.waitForFunction((t) => document.activeElement?.getAttribute('data-testid') === t, testid, { timeout: ms }).then(
    () => true,
    () => false
  )
async function openPane() {
  await openAppSettings(page)
  await page.getByRole('tab', { name: 'Connectors', exact: true }).click()
  await page.locator('[data-testid=presets-section]').waitFor({ timeout: 10_000 })
}
async function closeFormWithEscape() {
  await page.keyboard.press('Escape')
}
/** Click a button of the topmost ConfirmDialog. */
async function confirmTop(label) {
  const dlg = page.getByRole('dialog').last()
  const text = (await dlg.textContent()) ?? ''
  await dlg.getByRole('button', { name: label, exact: true }).click()
  return text
}
async function removePreset(id) {
  await row(id).locator('[data-testid=preset-more]').click()
  await page.locator('[data-testid=preset-remove]').click()
}

try {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
  await sleep(300)
  await openPane()

  // ---- empty ----
  // The section shows "Loading your presets" until connectorPresets:list answers; wait for it (slow runners).
  await page.locator('[data-testid=presets-empty]').waitFor({ timeout: 10_000 })
  check((await page.locator('[data-testid=presets-empty]').count()) === 1, 'no presets: the section shows its empty state')
  check((await page.locator('[data-testid=preset-row]').count()) === 0, 'no preset rows yet')
  check((await chip('custom').count()) === 0, 'no "Yours" filter chip without a preset')
  const order = await page.evaluate(() => {
    const ids = ['connectors-section', 'presets-section', 'mcp-library-section']
    const tops = ids.map((id) => document.querySelector(`[data-testid=${id}]`)?.getBoundingClientRect().top ?? -1)
    return tops
  })
  check(order[0] >= 0 && order[0] < order[1] && (order[2] < 0 || order[1] < order[2]), 'Your presets sits between the gallery and Custom servers', JSON.stringify(order))

  // ---- add a remote preset ----
  await page.locator('[data-testid=preset-add]').click()
  await form().waitFor({ timeout: 10_000 })
  check(await focusOn('preset-name'), 'the form opens on the Name field', await focused())
  await form().locator('[data-testid=preset-save]').click()
  check((await field('preset-name').getAttribute('aria-invalid')) === 'true', 'saving without a name marks the Name field invalid')
  // The form moves focus in a setTimeout(0) after the render that sets aria-invalid, so wait for it (slow runners).
  await page
    .waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'preset-name', null, { timeout: 5_000 })
    .catch(() => {})
  check(await focusOn('preset-name'), 'focus goes to the first invalid field', await focused())
  await field('preset-name').fill('Acme CRM')
  await field('preset-description').fill('Customer records from the Acme system')
  await form().locator('[data-testid=preset-category] select').selectOption('crm')
  await field('preset-aliases').fill('clients, accounts')
  check((await field('preset-transport').locator('input[type=radio]:checked').count()) === 1, 'How it connects starts on one choice')
  await field('preset-url').fill('http://crm.acme.test/mcp')
  await form().locator('[data-testid=preset-save]').click()
  check(/https/.test((await form().locator('.invalid-text').first().textContent()) ?? ''), 'an address that is not https is explained in the form')
  await field('preset-url').fill('https://crm.acme.test/mcp')
  check((await field('preset-auth').getAttribute('data-auth')) === 'none', 'sign-in starts on "No sign-in needed"')
  await form().getByLabel('Paste a token').check()
  check((await field('preset-auth').getAttribute('data-auth')) === 'token', 'choosing "Paste a token" switches the auth group')
  check((await field('preset-token-name').inputValue()) === 'Authorization', 'the token header defaults to Authorization')
  await field('preset-token-prefix').fill('Bearer')
  await field('preset-token-help').fill('https://crm.acme.test/keys')
  // two access options: a full one and a read-only default
  const variants = form().locator('[data-testid=preset-variant]')
  check((await variants.count()) === 1, 'the form starts with one access option')
  await variants.nth(0).locator('input.input').first().fill('Full access')
  await form().locator('[data-testid=preset-variant-add]').click()
  check((await variants.count()) === 2, 'Add an access option adds a row')
  await variants.nth(1).locator('input.input').first().fill('Read only')
  await variants.nth(1).locator('select').selectOption('read')
  await variants.nth(1).getByLabel('Default: Read only').check()
  check((await variants.nth(0).getByRole('button', { name: /Remove access option/ }).isEnabled()) === true, 'Remove is enabled with two options')
  await shot('form-filled')
  await form().locator('[data-testid=preset-save]').click()
  await form().waitFor({ state: 'detached', timeout: 10_000 })
  check(true, 'saving closes the form')

  // ---- the tile and the section row ----
  await tile('acme-crm').waitFor({ timeout: 10_000 })
  check((await tile('acme-crm').getAttribute('data-custom')) === 'true', 'the tile carries data-custom')
  check((((await tile('acme-crm').locator('[data-testid=connector-custom-badge]').textContent()) ?? '').trim()) === 'Yours', 'the tile says "Yours"')
  check((((await tile('acme-crm').locator('[data-testid=connector-ease]').textContent()) ?? '').trim()) === 'Paste a token', 'a token preset shows the "Paste a token" method badge')
  check((await tile('acme-crm').locator('.connector-logo').count()) === 1, 'the tile has the fallback logo')
  check((await chip('custom').count()) === 1, 'the "Yours" filter chip appears once a preset exists')
  await chip('custom').click()
  const customOnly = await page.locator('[data-testid=connector-tile]').evaluateAll((els) => els.map((e) => e.getAttribute('data-custom')))
  check(customOnly.length === 1 && customOnly[0] === 'true', 'the Yours filter shows only presets', JSON.stringify(customOnly))
  await chip('all').click()
  const search = page.locator('[data-testid=connector-search]')
  await search.fill('accounts')
  check((await tile('acme-crm').count()) === 1, 'search finds a preset by its search words')
  await search.fill('customer records')
  check((await tile('acme-crm').count()) === 1, 'search finds a preset by its description')
  await search.fill('')
  const r = row('acme-crm')
  const rowText = (await r.textContent()) ?? ''
  check(/Acme CRM/.test(rowText) && /Remote/.test(rowText) && /2 access options/.test(rowText) && /Not added/.test(rowText), 'the section row shows name, Remote, access options and Not added', rowText.slice(0, 160))
  check((await r.locator('[data-testid=preset-edit]').count()) === 1 && (await r.locator('[data-testid=preset-more]').count()) === 1, 'the row has Edit and More actions')

  // ---- the dialog ----
  await tile('acme-crm').locator('[data-testid=connector-action]').click()
  await dialog().waitFor({ timeout: 10_000 })
  check(/described this service yourself/.test((await dialog().locator('[data-testid=connector-custom-note]').textContent()) ?? ''), 'the dialog says the user described the service')
  check((await dialog().locator('[data-testid=connector-honesty]').count()) === 0, 'the "not yet tested" note is replaced')
  check((((await dialog().locator('[data-testid=connector-custom-url]').textContent()) ?? '').trim()) === 'https://crm.acme.test/mcp', 'the dialog shows the full address')
  check((await dialog().locator('[data-testid=connector-variant]').count()) === 2, 'the dialog offers both access options')
  check((await dialog().locator('[data-testid=connector-variant][data-variant=read-only] input').isChecked()) === true, 'the default option is preselected')
  check((await dialog().locator('[data-testid=connector-preset-edit]').count()) === 1, 'the dialog footer offers "Edit preset"')

  // ---- edit from the dialog ----
  await dialog().locator('[data-testid=connector-preset-edit]').click()
  await dialog().waitFor({ state: 'detached', timeout: 10_000 })
  await form().waitFor({ timeout: 10_000 })
  check(/Edit Acme CRM/.test((await form().locator('h2').textContent()) ?? ''), 'Edit preset opens the form titled "Edit Acme CRM"')
  check((await field('preset-name').inputValue()) === 'Acme CRM', 'the form is filled from the preset')
  check((await field('preset-token-prefix').inputValue()) === 'Bearer', 'the token prefix round trips')
  await field('preset-description').fill('Customer records, edited')
  await form().locator('[data-testid=preset-save]').click()
  await form().waitFor({ state: 'detached', timeout: 10_000 })
  await sleep(300)
  check(((await tile('acme-crm').locator('.connector-desc').textContent()) ?? '').includes('edited'), 'the tile shows the edited description')
  check(await focusOn('connector-action'), 'focus returns to the tile button after the form closes', await focused())

  // ---- edit from the section: unsaved changes ask first ----
  await r.locator('[data-testid=preset-edit]').click()
  await form().waitFor({ timeout: 10_000 })
  await field('preset-name').fill('Acme CRM changed')
  await closeFormWithEscape()
  const discard = await confirmTop('Discard changes')
  check(/Discard your changes/.test(discard), 'closing a changed form asks first', discard.slice(0, 120))
  await form().waitFor({ state: 'detached', timeout: 10_000 })
  check(/Acme CRM$/.test(((await r.locator('.preset-item-title').textContent()) ?? '').trim()), 'discarding leaves the name as it was')

  // ---- a program preset ----
  await page.locator('[data-testid=preset-add]').click()
  await form().waitFor({ timeout: 10_000 })
  await field('preset-name').fill('Local Notes')
  await form().getByLabel('Program on this computer').check()
  check((await form().getByLabel('Sign in with the browser').isDisabled()) === true, 'browser sign-in is disabled for a program')
  check(/remote address/.test((await field('preset-oauth-why').textContent()) ?? ''), 'the reason is visible next to it')
  await field('preset-command').fill('npx')
  await field('preset-args').fill('-y\n@acme/notes-mcp@1.2.3')
  await form().locator('[data-testid=preset-save]').click()
  await form().waitFor({ state: 'detached', timeout: 10_000 })
  await tile('local-notes').waitFor({ timeout: 10_000 })
  check(/Program/.test((await row('local-notes').textContent()) ?? ''), 'the row says Program')
  await tile('local-notes').locator('[data-testid=connector-action]').click()
  await dialog().waitFor({ timeout: 10_000 })
  check((((await dialog().locator('[data-testid=connector-custom-command]').textContent()) ?? '').trim()) === 'npx -y @acme/notes-mcp@1.2.3', 'the dialog shows the full command')
  check(/Runs this program on this computer/.test((await dialog().locator('.connector-custom-target').textContent()) ?? ''), 'the command block says what it does')
  await page.keyboard.press('Escape')
  await dialog().waitFor({ state: 'detached', timeout: 10_000 })

  // ---- duplicate, then remove the copy ----
  await row('acme-crm').locator('[data-testid=preset-more]').click()
  await page.locator('[data-testid=preset-duplicate]').click()
  await form().waitFor({ timeout: 10_000 })
  check((await field('preset-name').inputValue()) === 'Acme CRM copy', 'Duplicate starts from a copy name')
  await form().locator('[data-testid=preset-save]').click()
  await form().waitFor({ state: 'detached', timeout: 10_000 })
  await row('acme-crm-copy').waitFor({ timeout: 10_000 })
  check((await page.locator('[data-testid=preset-row]').count()) === 3, 'the section lists three presets')
  await removePreset('acme-crm-copy')
  const rm = await confirmTop('Remove preset')
  check(/Remove the preset Acme CRM copy/.test(rm), 'Remove asks with the preset name', rm.slice(0, 120))
  await row('acme-crm-copy').waitFor({ state: 'detached', timeout: 10_000 })
  check(true, 'the removed preset leaves the list')

  // ---- an added preset cannot be removed until it leaves the library ----
  await tile('acme-crm').locator('[data-testid=connector-action]').click()
  await dialog().waitFor({ timeout: 10_000 })
  await dialog().getByLabel('Access token').or(dialog().locator('input[type=password]')).first().fill('abc123')
  await dialog().locator('[data-testid=connector-connect]').click()
  await dialog().locator('[data-testid=connector-status]').waitFor({ timeout: 10_000 })
  check(true, 'a token preset connects in the mock')
  await page.keyboard.press('Escape')
  await dialog().waitFor({ state: 'detached', timeout: 10_000 })
  await removePreset('acme-crm')
  await page.locator('[data-testid=presets-error]').waitFor({ timeout: 10_000 })
  check(/MCP library first/.test((await page.locator('[data-testid=presets-error]').textContent()) ?? ''), 'removing an added preset says to remove it from the library first')
  await r.locator('[data-testid=preset-edit]').click()
  await form().waitFor({ timeout: 10_000 })
  check((await form().locator('[data-testid=preset-added-note]').count()) === 1, 'editing an added preset says changes apply the next time it is added')
  await closeFormWithEscape()
  await form().waitFor({ state: 'detached', timeout: 10_000 })

  // ---- both sizes and themes ----
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
    await sleep(400)
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await sleep(150)
      await noHScroll(`pane ${w}x${h} ${theme}`)
      const rowBox = await row('local-notes').boundingBox()
      check(!!rowBox && rowBox.height < 140, `a preset row stays compact at ${w}x${h} ${theme}`, JSON.stringify(rowBox))
      await row('local-notes').locator('[data-testid=preset-edit]').click()
      await form().waitFor({ timeout: 10_000 })
      await noHScroll(`form ${w}x${h} ${theme}`)
      const foot = await form().locator('[data-testid=preset-save]').boundingBox()
      check(!!foot && foot.y + foot.height <= h && foot.x + foot.width <= w, `the Save button stays on screen at ${w}x${h} ${theme}`, JSON.stringify(foot))
      await shot(`form-${w}-${theme}`)
      await closeFormWithEscape()
      await form().waitFor({ state: 'detached', timeout: 10_000 })
    }
    check((await windowShift(page)).ok, `the window did not shift at ${w}x${h}`)
  }

  // ---- keyboard: Tab order starts at the name, Esc closes ----
  await row('local-notes').locator('[data-testid=preset-edit]').focus()
  await page.keyboard.press('Enter')
  await form().waitFor({ timeout: 10_000 })
  check(await focusOn('preset-name'), 'Enter on Edit opens the form on the Name field', await focused())
  await page.keyboard.press('Tab')
  check(await focusOn('preset-description'), 'Tab moves to What it does', await focused())
  await closeFormWithEscape()
  await form().waitFor({ state: 'detached', timeout: 10_000 })
  check(await focusOn('preset-edit'), 'focus returns to Edit after the form closes', await focused())

  // ---- clean up: remove the added service, then the presets ----
  await tile('acme-crm').locator('[data-testid=connector-action]').click()
  await dialog().waitFor({ timeout: 10_000 })
  await dialog().locator('[data-testid=connector-remove]').click()
  await confirmTop('Remove service')
  await dialog().waitFor({ state: 'detached', timeout: 10_000 })
  await removePreset('acme-crm')
  await confirmTop('Remove preset')
  await row('acme-crm').waitFor({ state: 'detached', timeout: 10_000 })
  check(true, 'after removing the service the preset can be removed')
  check(await focusOn('preset-edit'), 'focus lands on the next row\'s Edit after a removal', await focused())
  await removePreset('local-notes')
  await confirmTop('Remove preset')
  await page.locator('[data-testid=presets-empty]').waitFor({ timeout: 10_000 })
  check(await focusOn('preset-add'), 'focus lands on "Add a preset" when none are left', await focused())
  check((await chip('custom').count()) === 0, 'the Yours chip goes with the last preset')
} catch (e) {
  check(false, 'presets flow ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await app?.close().catch(() => {})
}
finish('e2e/presets')
