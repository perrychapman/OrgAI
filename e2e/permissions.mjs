// Token-free. Mock adapter, temp ORGAI_DATA_DIR. Permission cards and Project settings > Agents > Permissions
// (docs/design/permissions.md): at 1024x640 and 1600x1000, dark and light, a scripted work run raises a plain Bash
// card, a compound `cd <worktree> && git add && git commit` card and an Edit outside the project. Each card shows its
// location line, the effect sentence and the rule chips without opening Details; the compound title names the real
// action; the "Fewer prompts" link opens the Permissions section. Settings: the mode trade-off and note, an allowed
// folder added by typed path survives a reload, a relative path gets the "was not saved" notice, and the rules panel
// refuses `Edit` and accepts both prefix forms. A guarded [mock:fatigue] section SKIPs when the runtime has no such
// marker yet (no card within 10 s).
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, cleanup, createProject, findProject, finish, launch, log, makeFixtureRepo, openProject, projectTab, sleep } from './lib.mjs'

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
const openAgentsPane = async () => {
  await projectTab(page, 'Settings').click()
  await page.getByRole('tab', { name: 'Agents', exact: true }).click()
  await page.locator('#settings-section-permissions').waitFor({ timeout: 10_000 })
}

try {
  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
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
        // The quiet link opens Project settings > Agents with the Permissions heading focused.
        await page.locator(`${CARD} [data-testid=perm-settings-link]`).click()
        await page.locator('#settings-section-permissions').waitFor({ timeout: 10_000 })
        await sleep(400)
        const focused = await page.evaluate(() => document.activeElement?.closest('section')?.id ?? '')
        check(focused === 'settings-section-permissions', 'the Fewer prompts link focuses the Permissions section', focused)
        check((await page.getByRole('tab', { name: 'Agents', exact: true }).getAttribute('aria-selected')) === 'true', 'the link opens the Agents pane')
        await projectTab(page, 'Live').click()
        await nextCard('', 8000)
      }
      await answer('Allow once')
    }
    await sleep(800)
    await endRun()
  }

  // ---- Settings > Agents > Permissions ----
  await setSize(1600, 1000)
  for (const theme of ['dark', 'light']) {
    await setTheme(theme)
    await openAgentsPane()
    const trade = await page.locator('[data-testid=permission-mode-tradeoff]').innerText()
    check(trade.length > 20 && /prompts|asks|approves/i.test(trade), `the mode shows its trade-off line (${theme})`, trade)
    const note = await page.locator('[data-testid=permission-mode-note]').innerText()
    check(/allowed folders/.test(note), `the mode note says where rules and folders apply (${theme})`, note)
    await shot(`settings-${theme}`)
  }
  await setTheme('dark')
  await openAgentsPane()
  const mode = (await findProject(page, NAME))?.permissionMode
  const tradeNow = await page.locator('[data-testid=permission-mode-tradeoff]').innerText()
  if (mode === 'auto') check(/Fewest prompts/.test(tradeNow), 'Unattended reads "Fewest prompts"', tradeNow)

  // Allowed folders: typed absolute path, kept after a reload.
  const input = page.locator('[data-testid=allowed-folder-input]')
  await input.fill(extra)
  await page.locator('[data-testid=allowed-folder-add]').click()
  await page.locator(`[data-testid=allowed-folder-row]`).first().waitFor({ timeout: 8000 })
  const saved = (await findProject(page, NAME))?.allowedDirectories ?? []
  check(saved.length === 1 && path.resolve(saved[0]) === path.resolve(extra), 'the typed folder is saved to the project', JSON.stringify(saved))
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  await openProject(page, NAME)
  await openAgentsPane()
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
  for (const rule of ['Bash(npm test:*)', 'Bash(npm test *)']) {
    await page.getByRole('button', { name: `Remove rule ${rule}`, exact: true }).click().catch(() => {})
    await sleep(400)
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
        check(/allowed folders|Auto-accept file edits/.test(effect), 'the outside edit explains what Always allow saves', effect)
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
