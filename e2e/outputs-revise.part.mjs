// Revise part (docs/design/outputs-2.md 7, 11.4). Called at the end of e2e/outputs-notes.mjs with a project that has a finished
// run that produced a markdown and a docx output. ctx: { app, page, project, label, size: [w,h], theme, check, sleep }.
import { readFileSync } from 'node:fs'
import { t as scaled, until as untilReady } from './lib.mjs'

const mockSource = (() => {
  try {
    return readFileSync(new URL('../src/main/runtime/mock.ts', import.meta.url), 'utf8')
  } catch {
    return ''
  }
})()
const mockHasRevise = mockSource.includes('The user wrote (request')
const REVISE_HOLD_TOKEN = '[mock:revise-hold]'
const mockHasReviseHold = mockSource.includes(REVISE_HOLD_TOKEN)

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
  // Revise is not the primary action of a markdown output: it lives in the More menu (output-more > output-revise).
  const more = t('output-detail').locator('[data-testid=output-more]').first()
  if (!(await t('output-detail').count()) || !(await more.count())) {
    skip('the detail or its More button is not rendered yet')
    return
  }

  await more.focus()
  await more.click()
  await t('output-revise').waitFor({ state: 'visible', timeout: scaled(4000) }).catch(() => undefined)
  check((await t('output-revise').count()) === 1, `${label}: one "Ask the team to revise" item in More (and none in the toolbar)`)
  await t('output-revise').first().click()
  const dialog = t('output-revise-dialog')
  check(await dialog.waitFor({ timeout: scaled(4000) }).then(() => true, () => false), `${label}: Revise opens its dialog`)
  const heading = await dialog.locator('h2').innerText()
  check(/^Ask the team to revise /.test(heading), `${label}: the heading names the output`, heading)
  check((await t('output-revise-selection').isDisabled()), `${label}: "The part I selected" is disabled without a selection`)
  check((await t('output-revise-whole').isChecked()), `${label}: the whole output is the default scope`)

  // Targets: the ended run reads "continue the conversation"; a new run is offered last.
  await page.waitForFunction(() => document.querySelector('[data-testid=output-revise-target] select'), null, { timeout: scaled(4000) }).catch(() => {})
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
  // The mock answers on its own clock, so the pending line used to come and go between any two reads, and on a slow renderer
  // the answer was applied in the same paint as the request, so the line was never drawn (CI macOS: seen false in three of
  // four passes). REVISE_HOLD_TOKEN makes the mock ask one permission card before it revises: the request stays pending, the
  // line is a standing state, and this script releases the answer by answering that card. (Without a mock that knows the
  // token the request is answered on the mock's own clock and the old read is all there is.)
  const held = mockHasReviseHold
  await t('output-revise-text').fill(held ? `Tighten the first paragraph. ${REVISE_HOLD_TOKEN}` : 'Tighten the first paragraph.')
  await page.evaluate(() => {
    window.__reviseFocusLog = []
    window.__reviseFocusFn = (e) => window.__reviseFocusLog.push(e.target?.getAttribute?.('data-testid') || e.target?.tagName || '')
    document.addEventListener('focusin', window.__reviseFocusFn, true)
  })
  await t('output-revise-send').click()
  await dialog.waitFor({ state: 'detached', timeout: scaled(6000) }).catch(() => {})
  const closed = !(await dialog.count()) || !(await dialog.isVisible())
  check(closed, `${label}: the dialog closes after sending`)
  if (!closed) return
  // The pending line stays up while the card is open. The run tag reads "R?" for a moment before the run index has it, so
  // wait for the settled text, not just for the line.
  const pendingText = async () => ((await t('output-revision-pending').first().innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
  const settled = await untilReady(async () => /Sent to R\d+ at \d\d:\d\d\./.test(await pendingText()), 15_000)
  const pending = { seen: (await t('output-revision-pending').count()) > 0, visible: await t('output-revision-pending').first().isVisible().catch(() => false), text: await pendingText() }
  check(pending.seen && pending.visible, `${label}: the pending line shows`, JSON.stringify(pending))
  check(settled && /Waiting for the team's new version\. Sent to R\d+ at \d\d:\d\d\./.test(pending.text), `${label}: the pending line reads as the spec says`, pending.text)
  // The hand-back happens when the dialog has left. Read from the log kept since before Send (a focusin listener), not from
  // where focus is a while later: with the hold the run's permission card arrives meanwhile and may take focus on its own.
  const focusLog = await page.evaluate(() => {
    document.removeEventListener('focusin', window.__reviseFocusFn, true)
    return window.__reviseFocusLog ?? []
  })
  check(focusLog.includes('output-more'), `${label}: focus returns to the More button that opened Revise`, JSON.stringify(focusLog))
  const chip = t('run-meta-revision')
  if (await chip.count()) check(/Waiting for the team's version of /.test(await chip.first().innerText()), `${label}: the run chip names the output`)
  else skip('run-meta-revision (the run strip is not on screen here)')

  // Arrival: needs the mock's revise answers.
  if (!mockHasRevise) {
    skip('the mock does not answer revise requests in this build (arrival, answered line and Compare)')
    return
  }
  if (held) {
    // Release: answer the card the hold asked for (the run is live; its pending permission is the Bash `npm test`).
    const released = await untilReady(
      () =>
        page.evaluate(async () => {
          for (const r of await window.orgai.runs.listLive()) {
            const card = (await window.orgai.runs.pendingCards(r.id)).permissions.find((c) => c.toolName === 'Bash')
            if (card) {
              await window.orgai.runs.decide({ runId: r.id, requestId: card.id, decision: { behavior: 'allow', scope: 'once' } })
              return true
            }
          }
          return false
        }),
      30_000
    )
    check(released, `${label}: the mock's hold card was there to answer`)
  }
  const answered = await t('output-revision-answered').first().waitFor({ timeout: scaled(25000) }).then(() => true, () => false)
  check(answered, `${label}: the team's new version is announced in the detail`)
  if (answered) {
    const txt = await t('output-revision-answered').first().innerText()
    check(/made version \d+\./.test(txt), `${label}: the answered line names the version`, txt)
    if (await t('output-revision-compare').count()) check(/Compare with version \d+/.test(await t('output-revision-compare').first().innerText()), `${label}: Compare is offered`)
    else skip('output-revision-compare')
  }
  check((await t('run-meta-revision').count()) === 0, `${label}: the run chip is gone once the version landed`)
}
