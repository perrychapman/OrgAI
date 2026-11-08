// Token-free mock transcript media walkthrough. Run npm run build first.
import { check, endSession, finish, launch, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const { app, page, shot } = await launch({ shotPrefix: 'transcript-media' })
page.setDefaultTimeout(5000)

try {
  await page.locator('[data-testid=nav-assistant][data-id=quick]').click()
  const composer = page.locator('[data-testid=assistant-start-quick] .composer textarea')
  await page.locator('[data-testid=assistant-start-quick] input[type=file]').setInputFiles({ name: 'user-image.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aX8AAAAASUVORK5CYII=', 'base64') })
  await page.locator('[data-testid=assistant-start-quick] .attach-thumb').waitFor()
  await composer.fill('[mock:media] Show the media fixture')
  await composer.press('Enter')
  await page.getByText('MOCK_MEDIA_DONE', { exact: false }).first().waitFor({ timeout: 30000 })

  for (const [width, height] of [[1024, 640], [1600, 1000]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height])
    for (const theme of ['dark', 'light']) {
      await page.evaluate(async (theme) => {
        const settings = await window.orgai.settings.get()
        await window.orgai.settings.set({ ...settings, appearance: { ...settings.appearance, theme } })
      }, theme)
      await sleep(500)
      const tag = `${width}x${height} ${theme}`
      check(await page.evaluate(() => document.documentElement.dataset.theme) === theme, `theme applied ${tag}`)
      const transcript = page.locator('[data-testid=conversation-transcript]').first()
      check(await transcript.isVisible(), `conversation visible ${tag}`)
      check(await transcript.locator('.entry.user img[alt="user-image.png"]').count() === 1, `original user image remains visible ${tag}`)
      const media = transcript.locator('[data-testid=transcript-media]')
      check(await media.count() >= 1, `assistant media present ${tag}`)
      const summaries = transcript.locator('details > summary').filter({ hasText: /media item/i })
      check(await summaries.count() >= 2, `collapsed tool outputs disclose images ${tag}`)
      check(await summaries.filter({ hasText: /unavailable/i }).count() >= 1, `unavailable media is disclosed while collapsed ${tag}`)
      for (let i = 0; i < await summaries.count(); i++) {
        const summary = summaries.nth(i)
        if (!(await summary.locator('..').evaluate((el) => el.open))) await summary.click()
      }
      const before = transcript.getByText('Before the image.', { exact: true }).first()
      const after = transcript.getByText('After the image.', { exact: true }).first()
      check(await before.count() === 1 && await after.count() === 1, `mixed text is present ${tag}`)
      if (await before.count() && await after.count()) {
        const order = await before.evaluate((el, afterText) => {
          const after = [...document.querySelectorAll('*')].find((node) => node.textContent === afterText && node.children.length === 0)
          const media = el.parentElement?.querySelector('[data-testid=transcript-media]')
          return !!after && !!media && !!(el.compareDocumentPosition(media) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(media.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING)
        }, 'After the image.')
        check(order, `mixed text and image remain ordered ${tag}`)
      }
      check(await transcript.locator('[data-testid=transcript-image-unavailable]').count() >= 3, `unsupported, missing and unsafe sources have fallbacks ${tag}`)
      const trigger = transcript.locator('.entry-thumb:not(.unavailable)').first()
      check(await trigger.count() === 1 && /expand image/i.test(await trigger.getAttribute('aria-label') ?? ''), `image preview has a named button ${tag}`)
      if (await trigger.count()) {
        await trigger.focus()
        await page.keyboard.press('Enter')
        await trigger.locator(':scope[aria-expanded=true]').waitFor()
        check(await trigger.getAttribute('aria-expanded') === 'true', `keyboard opens preview ${tag}`)
        check(await trigger.locator('xpath=../..').locator('.entry-image-large').isVisible(), `expanded image is visible ${tag}`)
        await page.keyboard.press('Escape')
        await trigger.locator(':scope[aria-expanded=false]').waitFor()
        check(await trigger.getAttribute('aria-expanded') === 'false', `Escape closes preview ${tag}`)
        check(await trigger.evaluate((el) => document.activeElement === el), `focus returns to image trigger ${tag}`)
      }
      await shot(`${width}x${height}-${theme}`)
      for (let i = 0; i < await summaries.count(); i++) {
        const summary = summaries.nth(i)
        if (await summary.locator('..').evaluate((el) => el.open)) await summary.click()
      }
    }
  }
  await endSession(page)
  await page.locator('[data-testid=tab-history]').click()
  await page.locator('.run-row .run-open').first().click()
  await page.getByText('MOCK_MEDIA_DONE', { exact: false }).first().waitFor({ timeout: 20000 })
  const historicalUserImage = page.locator('.entry.user img[alt="user-image.png"]')
  await historicalUserImage.first().waitFor({ timeout: 10000 }).catch(() => {})
  check(await historicalUserImage.count() >= 1, 'user image survives history reopen')
  check(await page.locator('[data-testid=transcript-media]').count() >= 1, 'assistant media survives history reopen')
  check(await page.locator('details > summary').filter({ hasText: /media item/i }).count() >= 2, 'paired tool media remains discoverable in history')
} catch (error) {
  check(false, 'transcript media walkthrough completed', error.stack ?? String(error))
  await shot('failure').catch(() => {})
} finally {
  await app.close().catch(() => {})
}
finish('e2e/transcript-media')
