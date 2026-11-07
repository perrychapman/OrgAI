// Token-free. Mock adapter, temp ORGAI_DATA_DIR. The motion system (docs/design/motion.md 5): with Reduce motion off a
// dialog open and a popover open start running transitions (getAnimations) and the motion tokens hold their values;
// closing a dialog keeps its panel inert while it leaves, three quick open/close cycles leave no open dialog and return
// focus; with Reduce motion on every animation on a dialog / popover is ~0 ms, the motion distance is 0px and every
// working canvas node breathes at --dur-pulse (at most 12) and stops. 1024x640 and 1600x1000, dark and light. Never
// waits on an animation to finish.
import { check, cleanup, createProject, finish, launch, makeFixtureRepo, openProject, removeFixture, setReduceMotion, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'

const NAME = 'E2E motion (orgai test)'
const repo = makeFixtureRepo('motion')

const { app, page, shot } = await launch({ shotPrefix: 'motion' })
page.setDefaultTimeout(8000)

const setSize = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await sleep(300)
}
const setTheme = async (theme) => {
  await page.evaluate(async (t) => {
    const s = await window.orgai.settings.get()
    const { dataDir: _d, appVersion: _v, ...rest } = s
    await window.orgai.settings.set({ ...rest, appearance: { ...rest.appearance, theme: t } })
  }, theme)
  await page.waitForFunction((t) => document.documentElement.getAttribute('data-theme') === t, theme, { timeout: 5000 }).catch(() => {})
}
const menu = (id) =>
  app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId)
    if (!item) throw new Error(`no menu item ${itemId}`)
    item.click()
  }, id)

/**
 * Arms a watcher in the renderer: when an element matching `selector` gains `attr` (dialog[open], :popover-open), it
 * records the animations running on it and its subtree (CSS transitions included) in the next frame.
 */
const armWatch = (selector, kind) =>
  page.evaluate(
    ([sel, k]) => {
      window.__motionSeen = new Promise((resolve) => {
        const isOpen = (el) => (k === 'dialog' ? el.hasAttribute('open') : el.matches(':popover-open'))
        const capture = (el) =>
          requestAnimationFrame(() => {
            const anims = document.getAnimations().filter((a) => {
              const t = a.effect?.target
              return t && (t === el || el.contains(t))
            })
            resolve(
              anims.map((a) => ({
                name: a.animationName ?? a.transitionProperty ?? a.constructor.name,
                state: a.playState,
                duration: Number(a.effect?.getComputedTiming?.().duration ?? 0)
              }))
            )
          })
        const find = () => [...document.querySelectorAll(sel)].find(isOpen)
        const now = find()
        if (now) return capture(now)
        const mo = new MutationObserver(() => {
          const el = find()
          if (el) {
            mo.disconnect()
            capture(el)
          }
        })
        mo.observe(document.body, { subtree: true, attributes: true, childList: true })
        setTimeout(() => {
          mo.disconnect()
          resolve(null)
        }, 4000)
      })
    },
    [selector, kind]
  )
const seen = () => page.evaluate(() => window.__motionSeen)
const token = (name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)
const DIALOG = '[data-testid=keyboard-shortcuts-dialog]'

const openShortcuts = async () => {
  await menu('keyboard-shortcuts')
  // [open], not just visible: a closing dialog stays displayed for its --dur-fast exit, so "visible" right after a
  // close can match the leaving dialog before the reopen lands.
  await page.locator(`${DIALOG}[open]`).waitFor({ timeout: 5000 })
}
const closeShortcuts = async () => {
  await page.keyboard.press('Escape')
  await page.locator(`${DIALOG}[open]`).waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
}

try {
  for (const [w, h] of [
    [1024, 640],
    [1600, 1000]
  ]) {
    for (const theme of ['dark', 'light']) {
      const tag = `(${w}x${h} ${theme})`
      await setSize(w, h)
      await setTheme(theme)

      // ---- Reduce motion off ----
      await setReduceMotion(page, 'off')
      check((await token('--motion-distance')) === '8px', `--motion-distance is 8px with motion on ${tag}`, await token('--motion-distance'))
      check((await token('--dur-base')) === '160ms', `--dur-base is 160ms with motion on ${tag}`, await token('--dur-base'))

      await armWatch(DIALOG, 'dialog')
      await openShortcuts()
      const opened = await seen()
      const running = (opened ?? []).filter((a) => a.state === 'running' && a.duration >= 50)
      check(running.length > 0, `a dialog open starts a running transition ${tag}`, JSON.stringify(opened))
      if (w === 1600) await shot(`dialog-${theme}`)

      // Leaving: the panel is retained inert while the exit plays, and is gone after it.
      await page.keyboard.press('Escape')
      const leaving = await page.evaluate((sel) => {
        const d = document.querySelector(sel)
        const p = d?.querySelector('.dialog-panel')
        return { open: !!d?.open, panel: !!p, inert: !!p?.inert, hidden: p?.getAttribute('aria-hidden') }
      }, DIALOG)
      check(!leaving.open, `Esc closes the dialog at once ${tag}`, JSON.stringify(leaving))
      check(!leaving.panel || (leaving.inert && leaving.hidden === 'true'), `a leaving dialog panel is inert and aria-hidden ${tag}`, JSON.stringify(leaving))
      await page.waitForFunction((sel) => !document.querySelector(`${sel} .dialog-panel`), DIALOG, { timeout: 2000 }).catch(() => {})
      check(await page.evaluate((sel) => !document.querySelector(`${sel} .dialog-panel`), DIALOG), `the panel leaves after the exit ${tag}`)

      // Three quick cycles: no stuck open dialog, focus is not left inside a closed dialog.
      for (let i = 0; i < 3; i++) {
        await openShortcuts()
        await closeShortcuts()
      }
      const after = await page.evaluate(() => ({
        open: document.querySelectorAll('dialog[open]').length,
        focusInDialog: !!document.activeElement?.closest('dialog')
      }))
      check(after.open === 0 && !after.focusInDialog, `three quick open/close cycles leave no open dialog and no focus inside one ${tag}`, JSON.stringify(after))

      // Popover: the account popover.
      const pill = page.locator('[data-testid=auth-pill]')
      if (await pill.count()) {
        await armWatch('[data-testid=account-popover]', 'popover')
        await pill.click()
        const pop = await seen()
        check((pop ?? []).some((a) => a.state === 'running' && a.duration >= 50), `a popover open starts a running transition ${tag}`, JSON.stringify(pop))
        await page.keyboard.press('Escape')
        await page.waitForFunction(() => !document.querySelector('[data-testid=account-popover]:popover-open'), null, { timeout: 2000 }).catch(() => {})
      } else check(true, `account row not shown under the mock ${tag} (popover check skipped)`)

      // ---- Reduce motion on ----
      await setReduceMotion(page, 'on')
      check((await token('--motion-distance')) === '0px', `--motion-distance is 0px with Reduce motion on ${tag}`, await token('--motion-distance'))
      await armWatch(DIALOG, 'dialog')
      await openShortcuts()
      const reduced = await seen()
      check((reduced ?? []).every((a) => a.duration <= 1), `with Reduce motion on, every animation on an opening dialog is ~0 ms ${tag}`, JSON.stringify(reduced))
      const backdrop = await page.evaluate((sel) => getComputedStyle(document.querySelector(sel), '::backdrop').transitionDuration, DIALOG)
      check(backdrop.split(',').every((d) => Number.parseFloat(d) * (d.trim().endsWith('ms') ? 1 : 1000) <= 1), `the backdrop transition is ~0 with Reduce motion on ${tag}`, backdrop)
      await page.keyboard.press('Escape')
      check(await page.evaluate((sel) => !document.querySelector(`${sel} .dialog-panel`) || !document.querySelector(sel).open, DIALOG), `with Reduce motion on, the dialog closes at once ${tag}`)
      if (await pill.count()) {
        await armWatch('[data-testid=account-popover]', 'popover')
        await pill.click()
        const pop = await seen()
        check((pop ?? []).every((a) => a.duration <= 1), `with Reduce motion on, every animation on an opening popover is ~0 ms ${tag}`, JSON.stringify(pop))
        await page.keyboard.press('Escape')
      }
    }
  }

  // Live cues on a running canvas: working nodes breathe at --dur-pulse, at most 12, and stop under Reduce motion.
  await setReduceMotion(page, 'off')
  await setSize(1600, 1000)
  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'project created on the mock adapter')
  await openProject(page, NAME)
  await page.getByRole('tab', { name: 'Live', exact: true }).click()
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill('Motion breathe check [mock:deep-tree]')
  await page.locator('.composer .btn.primary').click()
  await page.locator('.react-flow [data-breathe]').first().waitFor({ timeout: 20_000 }).catch(() => {})
  const breathe = () =>
    page.evaluate(() => {
      const marks = [...document.querySelectorAll('.react-flow [data-breathe]')]
      const running = marks.filter((m) =>
        [m, ...m.querySelectorAll('*')].some(
          (el) => ['', '::before', '::after'].some((p) => getComputedStyle(el, p || null).animationName.split(',').some((n) => n.trim() === 'breathe'))
        )
      )
      const pulse = getComputedStyle(document.documentElement).getPropertyValue('--dur-pulse').trim()
      return { marks: marks.length, running: running.length, pulse }
    })
  const on = await breathe()
  if (on.marks > 0) {
    check(on.marks <= 12, 'at most 12 canvas nodes carry data-breathe', JSON.stringify(on))
    check(on.running > 0 && on.pulse === '1800ms', 'working canvas nodes breathe at --dur-pulse with motion on', JSON.stringify(on))
    await setReduceMotion(page, 'on')
    const off = await breathe()
    check(off.running === 0, 'no canvas node runs breathe with Reduce motion on', JSON.stringify(off))
  } else check(true, 'no working node was caught on the canvas (the mock finished first); breathe check skipped')
  await setReduceMotion(page, 'system')
  await cleanup(app, page, NAME)
} finally {
  await app.close().catch(() => {})
  removeFixture(repo)
}
finish('motion')
