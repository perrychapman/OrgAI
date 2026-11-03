// Token-free. Mock adapter, temp ORGAI_DATA_DIR. Permission cards and Project settings > Permissions > Permissions
// (docs/design/permissions.md): at 1024x640 and 1600x1000, dark and light, a scripted work run raises a plain Bash
// card, a compound `cd <worktree> && git add && git commit` card and an Edit outside the project. Each card shows its
// location line, the effect sentence and the rule chips without opening Details; the compound title names the real
// action; the "Fewer prompts" link opens the Permissions section. Settings: the mode trade-off and note, an allowed
// folder added by typed path survives a reload, a relative path gets the "was not saved" notice, and the rules panel
// refuses `Edit` and accepts both prefix forms. A guarded [mock:fatigue] section SKIPs when the runtime has no such
// marker yet (no card within 10 s).
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, cleanup, createProject, findProject, finish, launch, log, makeFixtureRepo, openProject, projectTab, sleep, windowShift } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E permissions (orgai test)'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-perm-'))
const repo = path.join(base, 'notes-app')
const sibling = path.join(base, 'shared-lib')
const extra = path.join(base, 'extra-folder')
fs.mkdirSync(sibling, { recursive: true })
fs.mkdirSync(extra, { recursive: true })
makeFixtureRepo('perm', { at: repo })
const worktree = path.join(repo, '.claude', 'worktrees', 'agent-e2e1')

const scriptFile = path.join(base, 'script.json')
const CARDS_SCRIPT = {
  delayMs: 250,
  work: [
    { type: 'text', text: 'Checking the tree first.' },
    { type: 'tool', name: 'Bash', input: { command: 'git status --short' }, ask: true, result: '' },
    { type: 'tool', name: 'Bash', input: { command: `cd ${worktree} && git add -A && git commit -m e2e` }, ask: true, result: '' },
    { type: 'tool', name: 'Edit', input: { file_path: path.join(sibling, 'index.js'), old_string: 'a', new_string: 'b' }, ask: true, result: 'File updated.' },
    { type: 'text', text: 'All done.' }
  ]
}
const writeScript = (s) => fs.writeFileSync(scriptFile, JSON.stringify(s))
writeScript(CARDS_SCRIPT)
process.env.ORGAI_MOCK_SCRIPT = scriptFile

const { app, page, shot } = await launch({ shotPrefix: 'permissions' })
page.setDefaultTimeout(8000)

const setSize = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await page.waitForFunction((cw) => Math.abs(window.innerWidth - cw) <= 1, w, { timeout: 10_000 }).catch(() => {})
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await sleep(600)
}
const setTheme = async (theme) => {
  await page.evaluate(async (t) => {
    const s = await window.orgai.settings.get()
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, theme: t } })
  }, theme)
  await sleep(500)
}
const CARD = 'section.frame-tray article.decision-card[data-kind="permission"]'
const cardLabel = () => page.evaluate((sel) => document.querySelector(sel)?.getAttribute('aria-label') ?? '', CARD)
/** Wait for a permission card whose label differs from `prev` (or any card). Returns its label, '' on timeout. */
const nextCard = async (prev = '', timeout = 15_000) => {
  try {
    await page.waitForFunction(([sel, p]) => {
      const l = document.querySelector(sel)?.getAttribute('aria-label') ?? ''
      return l !== '' && l !== p
    }, [CARD, prev], { timeout })
  } catch {
    return ''
  }
  await sleep(300)
  return cardLabel()
}
/** True when the element is rendered and the top-most thing at its centre (not clipped, scrolled away or covered). */
const reallyVisible = (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return false
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2 || r.bottom > window.innerHeight || r.top < 0) return false
    const hit = document.elementFromPoint(r.left + Math.min(r.width / 2, 20), r.top + r.height / 2)
    return !!hit && (el === hit || el.contains(hit))
  }, sel)
const answer = async (name) => {
  await page.locator(CARD).first().getByRole('button', { name, exact: true }).click()
  await sleep(400)
}
const startRun = async (text) => {
  await projectTab(page, 'Live').click()
  if (!(await page.locator('.new-run').count())) {
    await page.keyboard.press('Control+t')
    await page.locator('.new-run').waitFor({ timeout: 8000 })
  }
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill(text)
  await page.locator('.composer .btn.primary').click()
}
const endRun = async () => {
  const end = page.getByRole('button', { name: 'End session' })
  if (await end.count()) {
    await end.first().click().catch(() => {})
    await sleep(1200)
  }
}
const openPermissionsPane = async () => {
  await projectTab(page, 'Settings').click()
  await page.getByRole('tab', { name: 'Permissions', exact: true }).click()
  await page.locator('#settings-section-permissions').waitFor({ timeout: 10_000 })
}

/** Open the "Rules and folders you allowed" disclosure (closed on every mount) and assert its state flips. */
const openAllowed = async () => {
  const toggle = page.locator('[data-testid=permissions-summary-toggle]')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  check((await toggle.getAttribute('aria-expanded')) === 'true', 'the Rules and folders toggle is expanded after Show')
  await page.locator('[data-testid=allowed-folder-input]').waitFor({ state: 'visible', timeout: 8000 })
}

try {
  const project =await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'project created on the mock adapter')

  // ---- Cards: each size, both themes ----
  for (const [w, h] of [
    [1024, 640],
    [1600, 1000]
  ]) {
    const tag = `${w}x${h}`
    await setSize(w, h)
    await setTheme('dark')
    writeScript(CARDS_SCRIPT)
    await startRun(`Permission cards ${tag}`)

    // Card 1: a plain command in the project.
    const l1 = await nextCard('')
    check(l1 === 'Permission: Run git status --short', `the first card asks to run git status ${tag}`, l1)
    if (l1) {
      check(!/Claude/.test(await page.locator(CARD).first().innerText()), `no "Claude" in the permission card copy ${tag}`)
      const loc = page.locator(`${CARD} [data-testid=perm-location]`)
      check((await loc.getAttribute('data-kind')) === 'project' && /Starts in the project/.test(await loc.innerText()), `the location line says Starts in the project ${tag}`, await loc.innerText().catch(() => ''))
      for (const theme of ['dark', 'light']) {
        await setTheme(theme)
        check(await reallyVisible(`${CARD} [data-testid=perm-location]`), `the location line is visible without Details ${tag} ${theme}`)
        check(await reallyVisible(`${CARD} [data-testid=perm-scope-project]`), `the Always allow sentence is visible without Details ${tag} ${theme}`)
        check(await reallyVisible(`${CARD} [data-testid=perm-rule-chip]`), `a rule chip is visible without Details ${tag} ${theme}`)
        check((await reallyVisible(`${CARD} .decision-footer .btn.primary`)), `Allow once stays visible ${tag} ${theme}`)
        await shot(`card-bash-${tag}-${theme}`)
      }
      await setTheme('dark')
      const effect = await page.locator(`${CARD} [data-testid=perm-scope-project]`).innerText()
      check(/^Always allow for project: stops asking for .+ in this project\.$/.test(effect), `the effect sentence names what Always allow stops asking for ${tag}`, effect)
      const chips = await page.locator(`${CARD} [data-testid=perm-rule-chip]`).allInnerTexts()
      check(chips.length >= 1 && chips.every((c) => c.trim().length > 0), `the card lists its rule chips ${tag}`, chips.join(' | '))
      // The scope list (behind Details in compact mode) explains all three answers.
      const details = page.locator(`${CARD} .decision-details`)
      if (await details.isVisible()) await details.click()
      const scopes = await page.locator(`${CARD} [data-testid=perm-scopes] li`).allInnerTexts()
      check(scopes.length === 3 && scopes[0] === 'Allow once: this call only.' && /until you end this session\.$/.test(scopes[1] ?? '') && /^Always allow for project:/.test(scopes[2] ?? ''), `the scope list explains once, session and project ${tag}`, scopes.join(' | '))
      check(await page.locator(`${CARD} [data-testid=perm-settings-link]`).isVisible(), `the Fewer prompts link shows with the scope list ${tag}`)
      await answer('Allow once')
    }

    // Card 2: a compound command in a worktree; the title names the real action.
    const l2 = await nextCard(l1)
    check(l2 === 'Permission: Run git commit -m e2e (+1 more)', `the compound command title names git commit, not cd ${tag}`, l2)
    if (l2) {
      const loc = page.locator(`${CARD} [data-testid=perm-location]`)
      const text = await loc.innerText()
      check((await loc.getAttribute('data-kind')) === 'worktree' && text.includes('Starts in worktree agent-e2e1 (inside the project)'), `the compound card is placed in its worktree ${tag}`, text)
      const badge = await page.locator(`${CARD} .decision-meta .badge`).allInnerTexts()
      check(badge.some((b) => /3 steps/.test(b)), `the compound card is badged with its step count ${tag}`, badge.join(','))
      await shot(`card-compound-${tag}`)
      await answer('Allow once')
    }

    // Card 3: an edit outside the project.
    const l3 = await nextCard(l2)
    check(l3 === 'Permission: Edit index.js', `the outside edit asks to edit index.js ${tag}`, l3)
    if (l3) {
      const loc = page.locator(`${CARD} [data-testid=perm-location]`)
      const text = await loc.innerText()
      check((await loc.getAttribute('data-kind')) === 'outside' && (await loc.getAttribute('data-attention')) === 'true' && text.includes('Outside the project:') && text.includes('shared-lib'), `the outside edit says Outside the project with its folder ${tag}`, text)
      check(await reallyVisible(`${CARD} [data-testid=perm-location]`), `the outside line is visible without Details ${tag}`)
      await setTheme('light')
      await shot(`card-outside-${tag}-light`)
      await setTheme('dark')
      if (w === 1600) {
        // The quiet link opens Project settings > Permissions with "Rules and folders you allowed" open and the saved
        // rules heading focused (ux-review-config-2 N11).
        await page.locator(`${CARD} [data-testid=perm-settings-link]`).click()
        await page.locator('#settings-section-permissions').waitFor({ timeout: 10_000 })
        await sleep(400)
        const focused = await page.evaluate(() => {
          const a = document.activeElement
          return a?.matches('h2, h3') ? `${a.tagName}:${a.textContent}` : `(${a?.outerHTML.slice(0, 120)})`
        })
        check(focused === 'H3:Saved permission rules', 'the Fewer prompts link focuses the saved rules heading', focused)
        check((await page.locator('[data-testid=permissions-summary-toggle]').getAttribute('aria-expanded')) === 'true', 'the Fewer prompts link opens the rules and folders disclosure')
        const permShift = await windowShift(page)
        check(permShift.ok, 'the Fewer prompts link leaves the window unshifted', JSON.stringify(permShift))
        check((await page.getByRole('tab', { name: 'Permissions', exact: true }).getAttribute('aria-selected')) === 'true', 'the link opens the Permissions pane')
        await projectTab(page, 'Live').click()
        await nextCard('', 8000)
      }
      await answer('Allow once')
    }
    await sleep(800)
    await endRun()
  }

  // ---- Settings > Permissions ----
  await setSize(1600, 1000)
  for (const theme of ['dark', 'light']) {
    await setTheme(theme)
    await openPermissionsPane()
    const trade = await page.locator('[data-testid=permission-mode-tradeoff]').innerText()
    check(trade.length > 20 && /prompts|asks|approves/i.test(trade), `the mode shows its trade-off line (${theme})`, trade)
    const note = await page.locator('[data-testid=permission-mode-note]').innerText()
    check(/allowed folders/.test(note), `the mode note says where rules and folders apply (${theme})`, note)
    await shot(`settings-${theme}`)
  }
  await setTheme('dark')
  await openPermissionsPane()
  const mode = (await findProject(page, NAME))?.permissionMode
  const tradeNow = await page.locator('[data-testid=permission-mode-tradeoff]').innerText()
  if (mode === 'auto') check(/Fewest prompts/.test(tradeNow), 'Unattended reads "Fewest prompts"', tradeNow)

  // The summary row counts rules and folders before anything is allowed.
  check(/None yet/.test(await page.locator('[data-testid=permissions-summary]').innerText()), 'the summary says None yet with no rules or folders')
  // Allowed folders: typed absolute path, kept after a reload.
  await openAllowed()
  const input = page.locator('[data-testid=allowed-folder-input]')
  await input.fill(extra)
  await input.press('Enter')
  await page.locator(`[data-testid=allowed-folder-row]`).first().waitFor({ timeout: 8000 })
  await sleep(200)
  const afterAdd = await page.evaluate(() => ({
    focus: document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName,
    value: document.querySelector('[data-testid=allowed-folder-input]')?.value,
    said: document.querySelector('[data-testid=allowed-folder-announce]')?.textContent ?? ''
  }))
  check(afterAdd.focus === 'allowed-folder-input' && afterAdd.value === '', 'Enter adds the folder and keeps focus in the cleared input', JSON.stringify(afterAdd))
  check(/^Added .*extra-folder\.$/.test(afterAdd.said), 'the added folder is announced', afterAdd.said)
  const saved = (await findProject(page, NAME))?.allowedDirectories ?? []
  check(saved.length === 1 && path.resolve(saved[0]) === path.resolve(extra), 'the typed folder is saved to the project', JSON.stringify(saved))
  check(/1 folder you allowed/.test(await page.locator('[data-testid=permissions-summary]').innerText()), 'the summary counts the added folder')
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  await openProject(page, NAME)
  await openPermissionsPane()
  await openAllowed()
  const rows = await page.locator('[data-testid=allowed-folder-row]').allInnerTexts()
  check(rows.length === 1 && rows[0].includes('extra-folder'), 'the allowed folder is listed after a reload', rows.join(' | '))
  // A relative path is dropped by main and gets the quiet notice.
  await input.fill('relative/folder')
  await page.locator('[data-testid=allowed-folder-add]').click()
  await page.locator('[data-testid=allowed-folder-notice]').waitFor({ timeout: 8000 }).catch(() => {})
  const notice = await page.locator('[data-testid=allowed-folder-notice]').innerText().catch(() => '')
  check(notice.includes('relative/folder was not saved: must be an absolute folder'), 'a relative path shows the "was not saved" notice', notice)
  check((await page.locator('[data-testid=allowed-folder-row]').count()) === 1, 'the relative path is not listed')
  // A duplicate is refused before sending.
  await input.fill(extra)
  await page.locator('[data-testid=allowed-folder-add]').click()
  check(/already listed/.test(await page.locator('[data-testid=allowed-folder-error]').innerText().catch(() => '')), 'a duplicate folder is refused inline')
  await shot('settings-allowed-folders')
  // Remove.
  await page.locator('[data-testid=allowed-folder-remove]').first().click()
  await page.locator('[data-testid=allowed-folders-empty]').waitFor({ timeout: 8000 }).catch(() => {})
  await sleep(200)
  const afterRemove = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '')
  check(afterRemove === 'allowed-folder-input', 'removing the last folder moves focus to the folder input', afterRemove)
  check(((await findProject(page, NAME))?.allowedDirectories ?? []).length === 0, 'Remove clears the saved folder')

  // Rules panel: refuse Edit, accept both prefix forms.
  const ruleInput = page.locator('[data-testid=rule-input]')
  await ruleInput.fill('Edit')
  await page.locator('[data-testid=rule-add]').click()
  const refusal = await page.locator('[data-testid=rule-draft-error]').innerText().catch(() => '')
  check(/whole-tool Edit rule/.test(refusal), 'the rules panel refuses a whole-tool Edit rule with a reason', refusal)
  await ruleInput.fill('Edit(/Users/me/docs/**)')
  await page.locator('[data-testid=rule-add]').click()
  const slash = await page.locator('[data-testid=rule-draft-error]').innerText().catch(() => '')
  check(/write \/\/ for an absolute path/.test(slash), 'a single leading / on a file rule is refused with the // hint', slash)
  await ruleInput.fill('Bash(rm -rf:*)')
  check(/Careful/.test(await page.locator('[data-testid=rule-draft-warning]').innerText().catch(() => '')), 'a destructive prefix shows a warning before Add')
  for (const rule of ['Bash(npm test:*)', 'Bash(npm test *)']) {
    await ruleInput.fill(rule)
    const kind = await page.locator('[data-testid=rule-draft-kind]').innerText().catch(() => '')
    check(/^Command prefix: .*Takes effect in open runs too\.$/.test(kind), `the draft line names ${rule} a command prefix that applies live`, kind)
    await page.locator('[data-testid=rule-add]').click()
    await page.locator(`[data-testid=rule-row][data-rule="${rule}"]`).waitFor({ timeout: 8000 }).catch(() => {})
    const chip = await page.locator(`[data-testid=rule-row][data-rule="${rule}"] [data-testid=rule-kind]`).innerText().catch(() => '')
    check(chip === 'command prefix', `${rule} is saved and marked command prefix`, chip)
  }
  await shot('settings-rules')
  const focusedName = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.getAttribute('data-testid') ?? '')
  const expectFocus = ['Remove rule Bash(npm test *)', 'New permission rule']
  for (const [i, rule] of ['Bash(npm test:*)', 'Bash(npm test *)'].entries()) {
    await page.getByRole('button', { name: `Remove rule ${rule}`, exact: true }).click().catch(() => {})
    await sleep(400)
    const focused = await focusedName()
    check(focused === expectFocus[i], `after removing ${rule} focus moves to ${expectFocus[i]}`, focused)
  }

  // ---- Project settings panes: acceptance checks (config-review spec 8) ----
  const paneTab = async (name) => {
    await projectTab(page, 'Settings').click()
    await page.getByRole('tab', { name, exact: true }).click()
    await page.locator('.settings-pane-title').waitFor({ timeout: 10_000 })
    await sleep(300)
  }
  const setAdvanced = (pane, open) =>
    page.evaluate(([p, o]) => {
      const el = document.querySelector(`details[data-testid=settings-advanced][data-pane="${p}"]`)
      if (el) el.open = o
    }, [pane, open])
  /** Tab stops from the pane h2 to the end of the pane: visible, enabled, tabbable controls (radios count once per name). */
  const tabStops = () =>
    page.evaluate(() => {
      const panel = document.querySelector('[role=tabpanel]')
      if (!panel) return []
      const sel = 'a[href], button, input, select, textarea, summary, [tabindex]'
      const seen = new Set()
      const out = []
      for (const el of panel.querySelectorAll(sel)) {
        if (el.disabled || el.getAttribute('tabindex') === '-1' || !el.checkVisibility()) continue
        if (el.closest('[data-testid=mock-adapter-toggle]') || el.matches('[data-testid=mock-adapter-toggle]')) continue
        if (el.type === 'radio') {
          const key = `radio:${el.name}`
          if (seen.has(key)) continue
          seen.add(key)
        }
        out.push(el.getAttribute('aria-label') || el.getAttribute('data-testid') || el.textContent.trim().slice(0, 30) || el.tagName)
      }
      return out
    })
  const scrollFits = () => page.evaluate(() => {
    const s = document.querySelector('.settings-scroll')
    return { sh: s?.scrollHeight ?? 0, ch: s?.clientHeight ?? 0 }
  })
  const setProjectAuth = (kind) =>
    page.evaluate(async (k) => {
      const list = await window.orgai.connections.list()
      const conn = list.find((c) => c.connection.id === 'anthropic').connection
      await window.orgai.connections.update({ ...conn, auth: k === 'apiKey' ? { kind: 'apiKey', envVar: 'ANTHROPIC_API_KEY' } : { kind: 'subscription' } })
    }, kind)
  const reloadToSettings = async () => {
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 30_000 })
    await openProject(page, NAME)
  }
  const originalAuth = await page.evaluate(async () => (await window.orgai.connections.list()).find((c) => c.connection.id === 'anthropic').connection.auth)
  log('anthropic connection auth before the pane checks:', JSON.stringify(originalAuth))

  for (const [w, h] of [
    [1024, 640],
    [1600, 1000]
  ]) {
    const tag = `${w}x${h}`
    await setSize(w, h)
    for (const theme of ['dark', 'light']) {
      await setTheme(theme)
      // (2) Permissions at rest does not scroll at 1024x640.
      await paneTab('Permissions')
      await setAdvanced('project-permissions', false)
      const summaryToggle = page.locator('[data-testid=permissions-summary-toggle]')
      if ((await summaryToggle.getAttribute('aria-expanded')) === 'true') await summaryToggle.click()
      await sleep(200)
      check((await page.locator('[data-testid=permissions-summary-toggle]').getAttribute('aria-expanded')) === 'false', `the Rules and folders summary starts hidden ${tag} ${theme}`)
      const fit = await scrollFits()
      if (w === 1024) check(fit.sh <= fit.ch, `Permissions at rest needs no scrolling ${tag} ${theme}`, JSON.stringify(fit))
      // (5) tab stops at rest.
      const perm = await tabStops()
      check(perm.length <= 3, `Permissions has at most 3 tab stops at rest ${tag} ${theme}`, perm.join(' | '))
      await shot(`pane-permissions-${tag}-${theme}`)
      await paneTab('General')
      const gen = await tabStops()
      check(gen.length <= 4, `General has at most 4 tab stops at rest ${tag} ${theme}`, gen.join(' | '))
      const wd = page.locator('[data-testid=project-path]')
      check((await wd.getAttribute('title')) === repo && (await page.locator('input[aria-label="Working directory"]').count()) === 0, `the working directory is a read-only path with the full path in its title ${tag} ${theme}`)
      await shot(`pane-general-${tag}-${theme}`)
      // (4) subscription project: plan guard line, no percent input at rest.
      await paneTab('Limits')
      await setAdvanced('project-limits', false)
      await sleep(200)
      const lim = await tabStops()
      check(lim.length <= 2, `Limits has at most 2 tab stops at rest ${tag} ${theme}`, lim.join(' | '))
      check((await page.locator('[data-testid=plan-guard-line]').count()) === 1, `Limits shows the plan guard line on a subscription project ${tag} ${theme}`)
      check((await page.locator('[role=tabpanel] input[type=number]:visible').count()) === 0, `no number input is visible at rest on a subscription project ${tag} ${theme}`)
      // N2: the line says only what runs: no five-hour promise unless the share is set.
      const guardText = await page.locator('[data-testid=plan-guard-line]').innerText()
      check(!/five-hour/i.test(guardText) && /weekly window passes 80%/.test(guardText) && /pauses until it resets/.test(guardText), `the plan guard line promises no five-hour stop without a share ${tag} ${theme}`, guardText)
      await shot(`pane-limits-${tag}-${theme}`)
    }
  }

  // N2: with a five-hour share set the line names it; cleared again afterwards.
  {
    await paneTab('Limits')
    await setAdvanced('project-limits', true)
    const share = page.getByLabel('Stop at a share of the five-hour window (%)', { exact: true })
    await share.fill('30')
    await sleep(600)
    const withShare = await page.locator('[data-testid=plan-guard-line]').innerText()
    check(/Stops at 30% of the five-hour window\./.test(withShare), 'the plan guard line names a set five-hour share', withShare)
    await share.fill('')
    await sleep(600)
    check(!/five-hour/.test(await page.locator('[data-testid=plan-guard-line]').innerText()), 'clearing the share drops the five-hour sentence')
    await setAdvanced('project-limits', false)
  }

  // N8: one short-name table for the permission mode on both settings pages.
  {
    await paneTab('Permissions')
    const projectModes = await page.locator('[role=tabpanel] select').first().locator('option').allTextContents()
    check(projectModes.includes('Ask for everything risky') && projectModes.includes('Auto-accept edits'), 'the project mode select uses the shared short names', projectModes.join(' | '))
  }

  // N10: with worktrees off, the review switch says why it is disabled.
  {
    await paneTab('Permissions')
    await setAdvanced('project-permissions', true)
    const iso = page.getByRole('switch', { name: 'Isolate writers in worktrees', exact: true })
    if ((await iso.count()) && (await iso.isEnabled())) {
      const wasOn = (await iso.getAttribute('aria-checked')) === 'true'
      if (wasOn) await iso.click()
      await sleep(400)
      const review = page.getByRole('switch', { name: "Review each report's changes before merge", exact: true })
      const reason = await review.evaluate((el) => {
        const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
        return ids.map((i) => document.getElementById(i)?.textContent ?? '').join(' ')
      })
      check((await review.isDisabled()) && /Needs worktree isolation/.test(reason), 'the disabled review switch explains it needs worktree isolation', reason)
      if (wasOn) await iso.click()
      await sleep(300)
    } else check(true, 'worktree isolation is not switchable here; the N10 check was skipped')
    await setAdvanced('project-permissions', false)
  }

  // N6: the Team tab reaches the Team assistant select in one click (Permissions > Advanced, select focused).
  {
    await projectTab(page, 'Team').click()
    const gear = page.locator('[data-testid=team-assistant-settings]')
    await gear.waitFor({ timeout: 10_000 })
    check((await gear.getAttribute('aria-label')) === 'Team assistant settings', 'the Team assistant tray offers "Team assistant settings"')
    await gear.click()
    await page.locator('[data-testid=team-assistant-select]').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
    await sleep(500)
    check((await page.getByRole('tab', { name: 'Permissions', exact: true }).getAttribute('aria-selected')) === 'true', 'Team assistant settings opens the Permissions pane')
    check(await page.evaluate(() => document.querySelector('details[data-testid=settings-advanced][data-pane="project-permissions"]')?.open === true), 'Team assistant settings opens Permissions Advanced')
    check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'team-assistant-select'), 'Team assistant settings focuses the Team assistant select')
    const teamShift = await windowShift(page)
    check(teamShift.ok, 'Team assistant settings leaves the window unshifted', JSON.stringify(teamShift))
    await setAdvanced('project-permissions', false)
  }

  // (4) metered project: no five-hour or weekly text, Advanced open or closed. The connection is restored afterwards.
  try {
    await setProjectAuth('apiKey')
    await reloadToSettings()
    for (const [w, h] of [
      [1024, 640],
      [1600, 1000]
    ]) {
      await setSize(w, h)
      for (const theme of ['dark', 'light']) {
        await setTheme(theme)
        const tag = `${w}x${h} ${theme}`
        await paneTab('Limits')
        for (const open of [false, true]) {
          await setAdvanced('project-limits', open)
          await sleep(200)
          const text = await page.locator('[role=tabpanel]').innerText()
          check(!/five-hour|weekly/i.test(text), `Limits has no five-hour or weekly text on an API-key project, Advanced ${open ? 'open' : 'closed'} ${tag}`, text.slice(0, 200))
        }
        await setAdvanced('project-limits', false)
        check((await page.locator('[data-testid=plan-guard-line]').count()) === 0, `no plan guard line on an API-key project ${tag}`)
        check((await page.getByRole('spinbutton', { name: 'Estimated-cost cap per run' }).count()) === 1, `the cost cap is visible at rest on an API-key project ${tag}`)
        if (w === 1600 && theme === 'dark') await shot('pane-limits-metered')
      }
    }
  } finally {
    await page.evaluate(async (auth) => {
      const list = await window.orgai.connections.list()
      const conn = list.find((c) => c.connection.id === 'anthropic').connection
      await window.orgai.connections.update({ ...conn, auth })
    }, originalAuth)
    await reloadToSettings()
  }
  await setTheme('dark')
  await setSize(1600, 1000)

  // Advanced behaviours on the Permissions pane: name, Enter and Space, focus ring, open state across a reload.
  await paneTab('Permissions')
  await setAdvanced('project-permissions', false)
  const sum = page.locator('details[data-testid=settings-advanced][data-pane=project-permissions] > summary')
  check((await sum.innerText()).trim() === 'Advanced settings' && !(await sum.getAttribute('aria-label')), 'the Advanced summary reads "Advanced settings" with no aria-label override')
  const adv = page.locator('details[data-testid=settings-advanced][data-pane=project-permissions]')
  await sum.focus()
  await page.keyboard.press('Enter')
  check(await adv.evaluate((el) => el.open), 'Enter opens Advanced settings')
  await page.keyboard.press('Space')
  check(!(await adv.evaluate((el) => el.open)), 'Space closes Advanced settings')
  const ring = await sum.evaluate((el) => {
    const cs = getComputedStyle(el)
    return { style: cs.outlineStyle, width: cs.outlineWidth, shadow: cs.boxShadow, focus: el.matches(':focus-visible') }
  })
  check(ring.focus && ring.style !== 'none' && parseFloat(ring.width) > 0, 'the Advanced summary shows a focus ring when keyboard focused', JSON.stringify(ring))
  await page.keyboard.press('Enter')
  check(await adv.evaluate((el) => el.open), 'Advanced reopens before the reload')
  check(await page.getByRole('switch', { name: 'Let runs message each other' }).isVisible(), 'the Runs rows are visible in the open Advanced settings')
  await reloadToSettings()
  await paneTab('Permissions')
  check(await adv.evaluate((el) => el.open), 'the open Advanced state survives a reload')
  await setAdvanced('project-permissions', false)

  // Summary counts after the earlier steps: no folders or rules are left, so the row reads None yet.
  check(/None yet/.test(await page.locator('[data-testid=permissions-summary]').innerText()), 'the summary reads None yet after every folder and rule was removed')
  check((await page.locator('[data-testid=permission-mode-default]').innerText()).startsWith('App default for new projects:'), 'the mode row shows the App default hint')

  // (8) No "Claude" in permission copy; try to put the project on OpenAI first.
  const toOpenAi = await page.evaluate(async (name) => {
    try {
      const list = await window.orgai.projects.list()
      const p = list.find((x) => x.name === name)
      if (!p) return 'no project'
      await window.orgai.projects.save({ ...p, provider: { ...p.provider, connection: 'openai' } })
      const after = (await window.orgai.projects.list()).find((x) => x.name === name)
      return after?.provider?.connection === 'openai' ? 'openai' : `stayed ${after?.provider?.connection}`
    } catch (e) {
      return `error ${e}`
    }
  }, NAME)
  log('project connection switch to openai:', toOpenAi)
  if (toOpenAi === 'openai') await reloadToSettings()
  await paneTab('Permissions')
  await setAdvanced('project-permissions', true)
  await page.locator('[data-testid=permissions-summary-toggle]').click()
  const paneText = await page.locator('[role=tabpanel]').innerText()
  check(!/Claude/.test(paneText), `no "Claude" in the Permissions pane text (project on ${toOpenAi === 'openai' ? 'OpenAI' : 'the default connection; the mock could not switch to OpenAI'})`, (paneText.match(/.{0,40}Claude.{0,40}/) ?? [''])[0])
  await setAdvanced('project-permissions', false)
  if (toOpenAi === 'openai') {
    await page.evaluate(async (name) => {
      const p = (await window.orgai.projects.list()).find((x) => x.name === name)
      const { connection: _c, ...provider } = p.provider
      await window.orgai.projects.save({ ...p, provider })
    }, NAME)
    await reloadToSettings()
  }

  // ---- [mock:fatigue] (guarded: SKIP until the runtime marker is merged) ----
  writeScript({ delayMs: 250 })
  await startRun('[mock:fatigue] tidy up')
  const f1 = await nextCard('', 10_000)
  if (!f1 || !/npm test/.test(f1)) {
    // Without the marker the default work script runs: its only ask is mock-report-1's Edit of src/example.ts.
    if (f1) {
      const loc = page.locator(`${CARD} [data-testid=perm-location]`)
      const text = await loc.innerText().catch(() => '')
      check((await loc.getAttribute('data-kind').catch(() => null)) === 'project' && text.includes('src/example.ts'), "the default script's Edit card says In the project with its file", text)
      await answer('Allow once')
    }
    log('SKIP [mock:fatigue]: no npm test card within 10 s (runtime marker not merged yet)')
  } else {
    const chips = await page.locator(`${CARD} [data-testid=perm-rule-chip]`).allInnerTexts()
    check(chips.some((c) => c.includes('Bash(npm test:*)')), 'the fatigue cd && npm test card offers Bash(npm test:*)', chips.join(' | '))
    check(/Run npm test/.test(f1), 'the fatigue card title names npm test', f1)
    await answer('Allow for session')
    let sawOutside = false
    let repeatAsked = false
    let prev = f1
    for (let i = 0; i < 6; i++) {
      const next = await nextCard(prev, 6000)
      if (!next) break
      if (/npm test/.test(next)) repeatAsked = true
      const kind = await page.locator(`${CARD} [data-testid=perm-location]`).getAttribute('data-kind').catch(() => null)
      if (kind === 'outside') {
        sawOutside = true
        const text = await page.locator(`${CARD} [data-testid=perm-location]`).innerText()
        check(text.includes('Outside the project'), 'the fatigue outside edit says Outside the project', text)
        const effect = await page.locator(`${CARD} [data-testid=perm-scope-project]`).innerText().catch(() => '')
        check(/allowed folders|Auto-accept edits/.test(effect), 'the outside edit explains what Always allow saves', effect)
        await shot('fatigue-outside')
      }
      prev = next
      await answer('Allow once')
    }
    check(sawOutside, 'the fatigue run raised an outside-the-project edit card')
    check(!repeatAsked, 'after Allow for session the repeat cd && npm test raised no card')
  }
  await endRun()
} catch (e) {
  check(false, 'permissions e2e ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await cleanup(app, page, NAME)
  fs.rmSync(base, { recursive: true, force: true })
}
finish('e2e/permissions')
