// Revise part (docs/design/outputs-2.md 7, 11.4). Called at the end of e2e/outputs-notes.mjs with a project that has a finished
// run that produced a markdown and a docx output. ctx: { app, page, project, label, size: [w,h], theme, check, sleep }.
import { readFileSync } from 'node:fs'

const mockHasRevise = (() => {
  try {
    return readFileSync(new URL('../src/main/runtime/mock.ts', import.meta.url), 'utf8').includes('The user wrote (request')
  } catch {
    return false
  }
})()

export default async function (ctx) {
  const { page, label, check, sleep } = ctx
  const t = (id) => page.locator(`[data-testid=${id}]`)
  const skip = (what) => console.log(`SKIP ${label}: ${what}`)

  // Open a markdown output's detail (the project tab or the run's side tab, whichever shows rows).
  if (!(await t('output-detail').count())) {
    const row = page.locator('[data-testid=output-row][data-kind=markdown], [data-testid=run-output-row][data-kind=markdown]').first()
    if (await row.count()) {
      const show = row.locator('[data-testid=run-output-show]')
      if (await show.count()) await show.click()
      else await row.click()
      await sleep(400)
    }
  }
  const reviseBtn = t('output-revise')
  if (!(await t('output-detail').count()) || !(await reviseBtn.count())) {
    skip('the detail or its Revise button is not rendered yet')
    return
  }

  await reviseBtn.first().focus()
  await reviseBtn.first().click()
  const dialog = t('output-revise-dialog')
  check(await dialog.waitFor({ timeout: 4000 }).then(() => true, () => false), `${label}: Revise opens its dialog`)
  const heading = await dialog.locator('h2').innerText()
  check(/^Ask the team to revise /.test(heading), `${label}: the heading names the output`, heading)
  check((await t('output-revise-selection').isDisabled()), `${label}: "The part I selected" is disabled without a selection`)
  check((await t('output-revise-whole').isChecked()), `${label}: the whole output is the default scope`)

  // Targets: the ended run reads "continue the conversation"; a new run is offered last.
  await page.waitForFunction(() => document.querySelector('[data-testid=output-revise-target] select'), null, { timeout: 4000 }).catch(() => {})
  const labels = await dialog.locator('[data-testid=output-revise-target] option').allInnerTexts()
  check(labels.some((l) => /continue the conversation|still running/.test(l)), `${label}: a run option is offered`, labels.join(' | '))
  check(labels.includes('A new run'), `${label}: "A new run" is offered`, labels.join(' | '))
  const line = await dialog.innerText()
  check(/The result will be version \d+\. Version \d+ stays\./.test(line), `${label}: the consequence line is shown`)

  // Empty text is refused locally, the dialog stays.
  await t('output-revise-send').click()
  check(await t('output-revise-error').isVisible(), `${label}: an empty instruction shows a plain line`)
  check(await dialog.isVisible(), `${label}: the dialog stays open on a problem`)

  // Send a whole-output request.
  await t('output-revise-text').fill('Tighten the first paragraph.')
  await t('output-revise-send').click()
  await dialog.waitFor({ state: 'detached', timeout: 6000 }).catch(() => {})
  const closed = !(await dialog.count()) || !(await dialog.isVisible())
  check(closed, `${label}: the dialog closes after sending`)
  if (!closed) return
  await sleep(300)
  check(await t('output-revision-pending').first().isVisible().catch(() => false), `${label}: the pending line shows`)
  const pendingText = await t('output-revision-pending').first().innerText().catch(() => '')
  check(/Waiting for the team's new version\. Sent to R\d+ at \d\d:\d\d\./.test(pendingText), `${label}: the pending line reads as the spec says`, pendingText)
  const inFocus = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
  check(inFocus === 'output-revise', `${label}: focus returns to Revise`, String(inFocus))
  const chip = t('run-meta-revision')
  if (await chip.count()) check(/Waiting for the team's version of /.test(await chip.first().innerText()), `${label}: the run chip names the output`)
  else skip('run-meta-revision (the run strip is not on screen here)')

  // Arrival: needs the mock's revise answers.
  if (!mockHasRevise) {
    skip('the mock does not answer revise requests in this build (arrival, answered line and Compare)')
    return
  }
  const answered = await t('output-revision-answered').first().waitFor({ timeout: 25000 }).then(() => true, () => false)
  check(answered, `${label}: the team's new version is announced in the detail`)
  if (answered) {
    const txt = await t('output-revision-answered').first().innerText()
    check(/made version \d+\./.test(txt), `${label}: the answered line names the version`, txt)
    if (await t('output-revision-compare').count()) check(/Compare with version \d+/.test(await t('output-revision-compare').first().innerText()), `${label}: Compare is offered`)
    else skip('output-revision-compare')
  }
  check((await t('run-meta-revision').count()) === 0, `${label}: the run chip is gone once the version landed`)
}
