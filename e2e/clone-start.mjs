// Free e2e for the New project form's From GitHub start. Runs on ORGAI_MOCK=1: main's mock clones with local git and
// never calls GitHub (markers: MOCK_REPO_MARKERS in src/main/repoClone.ts). Destinations sit in a throwaway folder beside
// the e2e data dir, because main refuses a clone inside OrgAI's own data folder (that refusal is driven below too).
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DATA_DIR, TMP, check, finish, findProject, gitSafe, gotoProjects, launch, log, openProjectForm, screenshot, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
delete process.env.ORGAI_MOCK_GH
delete process.env.ORGAI_MOCK_GIT

const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-clone-'))
const { app, page } = await launch({ shotPrefix: 'clone-start' })

const tid = (id) => page.locator(`[data-testid=${id}]`)
const setEnv = (key, value) =>
  app.evaluate((_e, [k, v]) => {
    if (v === null) delete process.env[k]
    else process.env[k] = v
  }, [key, value])

async function size(w, h, theme) {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await page.waitForFunction((cw) => Math.abs(window.innerWidth - cw) <= 1, w, { timeout: 10_000 }).catch(() => {})
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
  await sleep(150)
}

/** The form on the From GitHub segment. */
async function openGithub() {
  await gotoProjects(page)
  const form = await openProjectForm(page)
  await form.locator('[data-testid=project-kind-option][data-kind=code] input[type=radio]').check({ force: true })
  await form.getByRole('radio', { name: 'From GitHub', exact: true }).check({ force: true })
  await tid('repo-source').waitFor({ timeout: 10_000 })
  return form
}

/** Close the dialog (or leave the inline form) with nothing running. */
async function closeForm() {
  const d = tid('new-project-dialog')
  if (await d.locator('form').count()) {
    await page.keyboard.press('Escape')
    await d.locator('form').waitFor({ state: 'detached', timeout: 10_000 })
  }
}

async function fillRepo(source, parent = base, folder) {
  await tid('repo-source').fill(source)
  await tid('repo-parent').fill(parent)
  if (folder !== undefined) await tid('repo-folder').fill(folder)
  // Let the debounced parse and checkPath answer.
  await sleep(600)
}

const isInert = async (loc) => (await loc.getAttribute('aria-disabled')) === 'true'
const textOf = async (id) => ((await tid(id).count()) ? ((await tid(id).first().innerText()) ?? '').trim() : '')
const activeTestId = () => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.closest('[data-testid]')?.getAttribute('data-testid') ?? null)

async function waitGone(p, ms = 15_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!fs.existsSync(p)) return true
    await sleep(100)
  }
  return false
}

/** No page scroll, and the submit row in view with the dialog inside the window. */
async function layoutOk(label) {
  const r = await page.evaluate(() => {
    const s = document.querySelector('[data-testid=new-project-submit]')?.getBoundingClientRect()
    const step = (document.querySelector('[data-testid=repo-clone-cancel]') ?? document.querySelector('[data-testid=repo-clone]'))?.getBoundingClientRect()
    return {
      pageScroll: document.documentElement.scrollHeight - window.innerHeight,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      submitBottom: s?.bottom ?? -1,
      submitTop: s?.top ?? -1,
      stepBottom: step?.bottom ?? null,
      stepClear: step && s ? step.bottom <= s.top : null,
      h: window.innerHeight
    }
  })
  check(r.pageScroll <= 0 && r.overflowX <= 0, `${label}: no page scroll`, JSON.stringify(r))
  check(r.submitTop >= 0 && r.submitBottom <= r.h, `${label}: submit in view`, JSON.stringify(r))
  if (r.stepBottom !== null) check(r.stepClear === true, `${label}: the clone step's button is in view above the submit row`, JSON.stringify(r))
}

try {
  await size(1024, 640, 'dark')

  // ---- First launch: the inline form, keyboard path, a plain clone that becomes a project ----
  {
    await gotoProjects(page)
    const form = await openProjectForm(page)
    await form.locator('[data-testid=project-kind-option][data-kind=code] input[type=radio]').check({ force: true })
    const seg = form.locator('.seg input[type=radio]')
    check((await seg.count()) === 3, 'three segments')
    await form.getByRole('radio', { name: 'New idea', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    check(await form.getByRole('radio', { name: 'From GitHub', exact: true }).isChecked(), 'arrow keys reach From GitHub')
    await tid('repo-source').waitFor({ timeout: 10_000 })
    await page.keyboard.press('Tab')
    check((await activeTestId()) === 'repo-source', 'the segment is one tab stop: Tab lands on Repository', String(await activeTestId()))
    check(await isInert(tid('new-project-submit')), 'submit is inert before the clone')
    check((await form.locator('.form-submit .hint').innerText()).includes('Clone the repository first.'), 'submit says why')
    check((await tid('use-mock').count()) === 0 && (await tid('architect-setup').count()) === 0, 'no setup choice before the clone')

    await page.keyboard.type('octo/first')
    await sleep(400)
    check((await tid('repo-folder').inputValue()) === 'first', 'folder name follows the repository')
    await tid('repo-parent').fill(base)
    await sleep(500)
    check((await textOf('repo-target-line')).includes(path.join(base, 'first')), 'live line names the target')
    await tid('repo-parent').press('Enter')
    await tid('repo-cloned-line').waitFor({ timeout: 30_000 })
    await sleep(200)
    check((await activeTestId()) === 'repo-cloned-line', 'focus lands on the success line', String(await activeTestId()))
    const line = await textOf('repo-cloned-line')
    check(line.includes(path.join(base, 'first')) && line.includes('keeps the folder'), 'success line names the path and says closing keeps it', line)
    check(fs.existsSync(path.join(base, 'first', '.git')), 'the clone is on disk')
    check((await textOf('repo-config-line')).includes('subfolders'), 'quiet line with nothing to list still has the nested note')
    await sleep(600)
    check((await textOf('new-project-status')).startsWith('Cloned.'), 'the polite status says it was cloned', await textOf('new-project-status'))
    check((await page.locator('input[placeholder*="Defaults to the folder name"]').count()) === 1, 'the name field appears')
    await layoutOk('inline after clone 1024')
    await page.locator('[data-testid=architect-setup]').waitFor()
    await page.locator('label.checkbox', { hasText: 'Set up with the Architect' }).click()
    await tid('new-project-submit').click()
    await page.waitForSelector('[data-testid=dashboard]', { state: 'detached', timeout: 60_000 })
    const p = await findProject(page, 'first')
    check(p && path.resolve(p.path) === path.resolve(base, 'first'), 'the project opens on the cloned folder', String(p?.path))
  }

  // ---- Both sizes and themes: live parse, clone, Import, project opens; fork preview and upstream ----
  for (const [w, h, theme] of [
    [1024, 640, 'dark'],
    [1024, 640, 'light'],
    [1600, 1000, 'dark'],
    [1600, 1000, 'light']
  ]) {
    const tag = `${w}-${theme}`
    await size(w, h, theme)
    const form = await openGithub()
    await layoutOk(`${tag} empty panel`)
    await tid('repo-source').fill('not a repo !!')
    await tid('repo-source-error').waitFor({ timeout: 5_000 })
    check(await isInert(tid('repo-clone')), `${tag}: Clone inert on a bad address`)
    check((await tid('repo-source').getAttribute('aria-invalid')) === 'true', `${tag}: field marked invalid`)

    await tid('repo-mode-fork').check({ force: true })
    await fillRepo('some-org/forkme', base, `forkme-${tag}`)
    check((await tid('repo-clone').innerText()).includes('Fork and clone'), `${tag}: the button names the fork`)
    const preview = await textOf('repo-fork-preview')
    check(preview.includes('Signed in to the GitHub CLI as mock-user') && preview.includes('Creates github.com/mock-user/forkme') && preview.includes('public') && preview.includes('upstream'), `${tag}: fork preview says who, what, public, upstream`, preview)
    await layoutOk(`${tag} fork preview`)
    await screenshot(page, `clone-start-${tag}-fork-preview`)
    await tid('repo-clone').click()
    await tid('repo-cloned-line').waitFor({ timeout: 30_000 })
    const forkDir = path.join(base, `forkme-${tag}`)
    const result = await textOf('repo-fork-result')
    check(result.includes('Forked to github.com/mock-user/forkme') && result.includes('upstream'), `${tag}: fork result`, result)
    const remotes = gitSafe(forkDir, ['remote'])
    check(/upstream/.test(String(remotes.stdout ?? remotes)) && /origin/.test(String(remotes.stdout ?? remotes)), `${tag}: the clone has origin and upstream`, JSON.stringify(remotes))
    await layoutOk(`${tag} after fork`)
    await screenshot(page, `clone-start-${tag}-forked`)
    // Closing keeps the folder; dismiss the offer so the next round starts clean.
    await closeForm()
    check(fs.existsSync(forkDir), `${tag}: closing keeps the folder`)
    await openGithub()
    await tid('repo-use-cloned-dismiss').click()
    check((await tid('repo-offer').count()) === 0, `${tag}: the offer can be dismissed`)

    await fillRepo('mock-org/with-agents', base, `agents-${tag}`)
    check(!(await isInert(tid('repo-clone'))), `${tag}: Clone ready`)
    await tid('repo-clone').click()
    await tid('repo-cloned-line').waitFor({ timeout: 30_000 })
    await tid('setup-choice').waitFor({ timeout: 10_000 })
    const cfg = await textOf('repo-config-line')
    check(cfg.indexOf('.claude/settings.json') < cfg.indexOf('.mcp.json') && cfg.indexOf('.mcp.json') < cfg.indexOf('AGENTS.md') && cfg.includes('subfolders'), `${tag}: repo config ranked by effect, with the nested note`, cfg)
    check(/until you allow them in the project's Settings/.test(cfg), `${tag}: repo config says agents wait for the user's allow`, cfg)
    check((await textOf('agents-found')).includes('Claude Code'), `${tag}: agents found from the clone`, await textOf('agents-found'))
    await sleep(300)
    check((await textOf('new-project-status')).includes('Choose how the team starts'), `${tag}: the setup choice is announced`, await textOf('new-project-status'))
    await layoutOk(`${tag} after clone with agents`)
    await screenshot(page, `clone-start-${tag}-cloned`)
    const importRadio = form.locator('[data-testid=setup-choice] input[value=import]')
    if (!(await importRadio.isChecked())) await importRadio.check({ force: true })
    await tid('new-project-submit').click()
    const dialog = tid('import-dialog')
    await dialog.waitFor({ state: 'visible', timeout: 60_000 })
    await dialog.locator('[data-testid=import-row]').first().waitFor({ timeout: 20_000 })
    check((await dialog.locator('[data-testid=import-row]').count()) >= 1, `${tag}: Import reviews the cloned agents`)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
    const p = await findProject(page, `agents-${tag}`)
    check(p && path.resolve(p.path) === path.resolve(base, `agents-${tag}`), `${tag}: project on the cloned folder`)
  }

  await size(1024, 640, 'dark')

  // ---- gh missing, logged out, Check again; git missing ----
  await setEnv('ORGAI_MOCK_GH', 'missing')
  await openGithub()
  await sleep(300)
  await fillRepo('some-org/nogh', base, 'nogh')
  check(await isInert(tid('repo-mode-fork')), 'gh missing: fork is inert')
  await tid('repo-mode-fork').check({ force: true }).catch(() => {})
  check(await tid('repo-mode-clone').isChecked(), 'gh missing: choosing it does nothing')
  check((await tid('repo-clone').innerText()).trim() === 'Clone', 'gh missing: the button stays Clone')
  check((await textOf('repo-fork-reason')).includes('Install the GitHub CLI'), 'gh missing: says why', await textOf('repo-fork-reason'))
  check((await tid('repo-mode-fork').getAttribute('aria-describedby')) !== null, 'gh missing: the reason is tied to the radio')
  check(!(await isInert(tid('repo-clone'))), 'gh missing: a plain clone still works')

  await setEnv('ORGAI_MOCK_GH', 'logged-out')
  await tid('repo-tools-recheck').click()
  await tid('repo-gh-command').waitFor({ timeout: 5_000 })
  check((await textOf('repo-gh-command')) === 'gh auth login', 'logged out: copyable command')
  check((await textOf('repo-fork-reason')).includes('gh auth login'), 'logged out: says why', await textOf('repo-fork-reason'))
  check(await isInert(tid('repo-mode-fork')), 'logged out: fork is inert')
  check((await tid('repo-gh-copy').count()) === 1, 'logged out: copy button')

  await setEnv('ORGAI_MOCK_GH', null)
  await tid('repo-tools-recheck').click()
  await page.waitForFunction(() => document.querySelector('[data-testid=repo-mode-fork]')?.getAttribute('aria-disabled') !== 'true', null, { timeout: 5_000 })
  check((await tid('repo-gh-command').count()) === 0, 'Check again: signed in, command gone')
  await tid('repo-mode-fork').check({ force: true })
  check(await tid('repo-mode-fork').isChecked(), 'Check again: fork can be chosen')
  await tid('repo-mode-clone').check({ force: true })

  await tid('repo-source').fill('https://gitlab.com/group/thing')
  await sleep(500)
  check(await isInert(tid('repo-mode-fork')), 'another host: fork is inert')
  check((await textOf('repo-fork-reason')).includes('github.com'), 'another host: says why')
  check(!(await isInert(tid('repo-clone'))), 'another host: Clone works')
  await closeForm()

  await setEnv('ORGAI_MOCK_GIT', 'missing')
  await openGithub()
  await sleep(300)
  await fillRepo('some-org/nogit', base, 'nogit')
  check((await textOf('repo-git-missing')).includes('Git is not installed'), 'git missing: says so')
  check(await isInert(tid('repo-clone')), 'git missing: Clone is inert')
  await setEnv('ORGAI_MOCK_GIT', null)
  await tid('repo-tools-recheck').click()
  await page.waitForFunction(() => document.querySelector('[data-testid=repo-clone]')?.getAttribute('aria-disabled') !== 'true', null, { timeout: 5_000 })
  check((await tid('repo-git-missing').count()) === 0, 'Check again: git found')
  await closeForm()

  // ---- Cancel removes the folder ----
  {
    await openGithub()
    const dest = path.join(base, 'slow-cancel')
    await fillRepo('mock-org/slow', base, 'slow-cancel')
    await tid('repo-clone').click()
    await tid('repo-clone-progress').waitFor({ timeout: 5_000 })
    await sleep(100)
    check((await activeTestId()) === 'repo-clone-cancel', 'focus moves to Cancel clone', String(await activeTestId()))
    check(await tid('repo-source').isDisabled(), 'fields lock during the clone')
    check(await tid('repo-parent').isDisabled() && (await tid('repo-folder').isDisabled()), 'destination locks too')
    check(await page.locator('.seg input[type=radio]').first().isDisabled(), 'the segment locks')
    await page.waitForFunction(() => /\d+%/.test(document.querySelector('[data-testid=repo-clone-progress-label]')?.textContent ?? ''), null, { timeout: 10_000 })
    check(true, 'progress shows a percent')
    await layoutOk('during clone 1024')
    await tid('repo-clone-cancel').click()
    await tid('repo-clone-cancelled').waitFor({ timeout: 15_000 })
    check(await waitGone(dest), 'cancel removes the folder')
    await sleep(100)
    check((await activeTestId()) === 'repo-clone', 'focus returns to Clone after a stop', String(await activeTestId()))
    check(!(await tid('repo-source').isDisabled()), 'fields unlock after a stop')
    check((await tid('repo-clone-error').count()) === 0, 'a stop is not shown as an error')
  }

  // ---- Destination: not empty, a file, main's refusal, already a project ----
  {
    const full = path.join(base, 'not-empty')
    fs.mkdirSync(full, { recursive: true })
    fs.writeFileSync(path.join(full, 'x.txt'), 'x')
    fs.writeFileSync(path.join(base, 'a-file'), 'x')
    await fillRepo('some-org/dest', base, 'not-empty')
    check((await textOf('repo-destination-problem')).includes('not empty'), 'a non-empty target is named')
    check(await isInert(tid('repo-clone')), 'a non-empty target blocks Clone')
    check((await textOf('repo-clone-why')).includes('not empty'), 'Clone says why')
    await tid('repo-folder').fill('a-file')
    await sleep(600)
    check((await textOf('repo-destination-problem')).includes('file'), 'a file at the target is named')
    await tid('repo-folder').fill('a/b')
    await sleep(100)
    check((await textOf('repo-destination-problem')).includes('one folder name'), 'slashes in the folder name are refused')
    await tid('repo-folder').fill('fresh-name')
    await tid('repo-parent').fill('relative/path')
    await sleep(100)
    check((await textOf('repo-destination-problem')).includes('full path'), 'a relative parent is refused')

    // <userData>/data is what main calls its data folder (ORGAI_DATA_DIR replaces userData).
    await tid('repo-parent').fill(path.join(DATA_DIR, 'data'))
    await sleep(600)
    await tid('repo-clone').click()
    await tid('repo-destination-error').waitFor({ timeout: 10_000 })
    check((await textOf('repo-destination-error')).includes('data folder'), "main's refusal shows in the destination", await textOf('repo-destination-error'))
    await sleep(100)
    check((await activeTestId()) === 'repo-destination-error', 'focus lands on the refusal', String(await activeTestId()))
    check((await tid('repo-parent').getAttribute('aria-describedby'))?.includes('dest-err'), 'the refusal describes the field')
    await tid('repo-folder').fill('other')
    check((await tid('repo-destination-error').count()) === 0, 'editing clears the refusal')

    await tid('repo-parent').fill(base)
    await tid('repo-folder').fill('first')
    await sleep(600)
    check((await tid('already-project').count()) === 1, 'a target that is a project says so')
    check(await isInert(tid('repo-clone')), 'that target blocks Clone')
    check((await tid('new-project-submit').innerText()).includes('Open first'), 'submit offers to open it')
    await closeForm()
  }

  // ---- Each failure sentence, with focus on it and a retry ----
  await openGithub()
  for (const [source, mode, needle] of [
    ['mock-org/missing', 'clone', 'was not found'],
    ['mock-org/private', 'clone', 'could not sign in'],
    ['mock-org/unreachable', 'clone', 'Could not reach'],
    ['mock-org/no-fork', 'fork', 'does not allow forking'],
    ['mock-org/missing', 'fork', 'was not found'],
    ['mock-user/mine', 'fork', 'your own repository'],
    ['mock-org/fork-clone-fails', 'fork', 'github.com/mock-user/fork-clone-fails']
  ]) {
    await tid(mode === 'fork' ? 'repo-mode-fork' : 'repo-mode-clone').check({ force: true })
    await fillRepo(source, base, `fail-${source.replace('/', '-')}-${mode}`)
    await tid('repo-clone').click()
    await tid('repo-clone-error').waitFor({ timeout: 30_000 })
    const msg = await textOf('repo-clone-error')
    check(msg.includes(needle), `${source} ${mode}: says "${needle}"`, msg)
    await sleep(100)
    check((await activeTestId()) === 'repo-clone-error', `${source} ${mode}: focus on the error`, String(await activeTestId()))
    check(!(await isInert(tid('repo-clone'))), `${source} ${mode}: a retry is possible`)
    check(!fs.existsSync(path.join(base, `fail-${source.replace('/', '-')}-${mode}`)), `${source} ${mode}: no folder left`)
    await layoutOk(`${source} ${mode} error`)
  }
  // Retry forks again: same failure, same sentence, still no crash.
  await tid('repo-clone').click()
  await sleep(300)
  await tid('repo-clone-error').waitFor({ timeout: 30_000 })
  check((await textOf('repo-clone-error')).includes('github.com/mock-user/fork-clone-fails'), 'a retried fork answers the same way')

  // fork-exists: "already had"; fork-slow: the waiting phase shows.
  await fillRepo('mock-org/fork-slow', base, 'fork-slow')
  await tid('repo-clone').click()
  await page.waitForFunction(() => /Waiting for GitHub/.test(document.querySelector('[data-testid=repo-clone-progress-label]')?.textContent ?? ''), null, { timeout: 10_000 })
  check(true, 'fork-slow: the waiting phase is shown')
  await tid('repo-cloned-line').waitFor({ timeout: 30_000 })
  await tid('repo-clone-another').click()
  await sleep(100)
  check((await activeTestId()) === 'repo-source', '"Clone a different repository" returns to Repository', String(await activeTestId()))
  await fillRepo('mock-org/fork-exists', base, 'fork-exists')
  await tid('repo-clone').click()
  await tid('repo-fork-result').waitFor({ timeout: 30_000 })
  check((await textOf('repo-fork-result')).includes('already had'), 'fork-exists: says it was already there')
  await tid('repo-clone-another').click()
  await tid('repo-mode-clone').check({ force: true })
  await closeForm()

  // ---- Esc, Cancel and the close button during a clone ask first ----
  {
    await openGithub()
    const dest = path.join(base, 'slow-esc')
    await fillRepo('mock-org/slow', base, 'slow-esc')
    await tid('repo-clone').click()
    await tid('repo-clone-progress').waitFor({ timeout: 5_000 })
    await sleep(200)
    await page.keyboard.press('Escape')
    await tid('repo-clone-stop-confirm').waitFor({ timeout: 5_000 })
    check((await tid('new-project-dialog').locator('form').count()) === 1, 'Esc asks instead of closing')
    await page.getByRole('button', { name: 'Keep cloning', exact: true }).click()
    await sleep(200)
    check((await tid('repo-clone-progress').count()) === 1, 'Keep cloning keeps it going')
    await page.locator('[data-testid=new-project-dialog] [aria-label="Close dialog"]').first().click()
    await tid('repo-clone-stop-confirm').waitFor({ timeout: 5_000 })
    check(true, 'the close button asks too')
    await page.keyboard.press('Escape')
    await sleep(200)
    check((await tid('repo-clone-progress').count()) === 1, 'Esc on the question keeps cloning')
    await tid('new-project-dialog').locator('form .form-submit').getByRole('button', { name: 'Cancel', exact: true }).click()
    await tid('repo-clone-stop-confirm').waitFor({ timeout: 5_000 })
    await tid('repo-clone-stop-confirm').click()
    await tid('new-project-dialog').locator('form').waitFor({ state: 'detached', timeout: 5_000 })
    check(await waitGone(dest), 'stopping removes the folder')
    await sleep(300)
    await openProjectForm(page)
    await sleep(200)
    check((await tid('repo-clone-cancelled').count()) === 0 && (await tid('repo-clone-error').count()) === 0, 'a closed clone leaves nothing behind in the reopened form')
    await closeForm()
  }

  // ---- A view change does not cancel: the form comes back with the clone ----
  {
    await openGithub()
    const dest = path.join(base, 'slow-away')
    await fillRepo('mock-org/slow', base, 'slow-away')
    await tid('repo-clone').click()
    await tid('repo-clone-progress').waitFor({ timeout: 5_000 })
    await sleep(300)
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('open-app-settings')?.click())
    await tid('dashboard').waitFor({ state: 'detached', timeout: 10_000 })
    await sleep(300)
    check(fs.existsSync(dest), 'navigating away does not cancel the clone')
    await gotoProjects(page)
    await tid('repo-clone-progress').waitFor({ timeout: 10_000 })
    check((await tid('repo-source').inputValue()) === 'mock-org/slow', 'the form comes back with what was typed')
    await sleep(200)
    check((await activeTestId()) === 'repo-clone-cancel', 'the returned form focuses Cancel clone', String(await activeTestId()))
    await tid('repo-clone-cancel').click()
    await tid('repo-clone-cancelled').waitFor({ timeout: 15_000 })
    check(await waitGone(dest), 'the returned form can still stop it')
    await closeForm()
  }

  // ---- After success: closing keeps the folder, the form offers it, the Connection link keeps it ----
  {
    await openGithub()
    await fillRepo('some-org/keepme', base, 'keepme')
    await tid('repo-clone').click()
    await tid('repo-cloned-line').waitFor({ timeout: 30_000 })
    await page.keyboard.press('Escape')
    await tid('new-project-dialog').locator('form').waitFor({ state: 'detached', timeout: 5_000 })
    check((await tid('repo-clone-stop-confirm').count()) === 0, 'closing after success does not ask')
    check(fs.existsSync(path.join(base, 'keepme', '.git')), 'the folder stays')
    await openProjectForm(page)
    await tid('repo-offer').waitFor({ timeout: 5_000 })
    check((await textOf('repo-offer')).includes(path.join(base, 'keepme')), 'the reopened form names the folder')
    await tid('repo-use-cloned').click()
    await tid('repo-cloned-line').waitFor({ timeout: 5_000 })
    await sleep(200)
    check((await activeTestId()) === 'repo-cloned-line', 'Use the folder lands on the success line', String(await activeTestId()))
    check((await tid('repo-offer').count()) === 0, 'the offer goes once used')

    const mock = page.locator('label.checkbox', { hasText: 'Use the mock adapter' })
    await mock.click()
    const link = tid('new-project-connection-change')
    if (await link.count()) {
      await link.click()
      await tid('dashboard').waitFor({ state: 'detached', timeout: 10_000 })
      await gotoProjects(page)
      await tid('repo-cloned-line').waitFor({ timeout: 10_000 })
      check((await textOf('repo-cloned-line')).includes('keepme'), 'the Connection link keeps the clone')
      await page.locator('label.checkbox', { hasText: 'Use the mock adapter' }).click()
    } else log('no connection link in this environment; parked draft not driven')
    await closeForm()
    await openProjectForm(page)
    await tid('repo-use-cloned').click()
    await tid('repo-cloned-line').waitFor({ timeout: 5_000 })
    await tid('repo-clone-another').click()
    await tid('repo-source').waitFor({ timeout: 5_000 })
    check((await tid('repo-offer').count()) === 0, 'choosing another clone drops the offer')
    check(fs.existsSync(path.join(base, 'keepme', '.git')), 'choosing another clone leaves the folder')
    await closeForm()
  }

  // ---- Bridge from Existing code ----
  {
    await gotoProjects(page)
    const form = await openProjectForm(page)
    await form.locator('[data-testid=project-kind-option][data-kind=code] input[type=radio]').check({ force: true })
    await form.getByRole('radio', { name: 'Existing code', exact: true }).check({ force: true })
    const folder = form.locator('input[placeholder*="repo"]')
    await folder.fill('git@github.com:octocat/hello-world.git')
    await tid('repo-bridge').waitFor({ timeout: 5_000 })
    const text = await form.innerText()
    check(!text.includes('Use a full path'), 'an address does not say "Use a full path"')
    check(!text.includes('The Architect scans it'), 'the hint gives way to the offer')
    await folder.fill('octocat/hello-world')
    await sleep(500)
    check((await textOf('repo-bridge')).includes('octocat/hello-world') && (await form.innerText()).includes('Use a full path'), 'a shorthand offers the clone and keeps the path line')
    await tid('repo-bridge-clone').click()
    await tid('repo-source').waitFor({ timeout: 5_000 })
    await sleep(150)
    check((await tid('repo-source').inputValue()) === 'octocat/hello-world', 'the source is filled in')
    check((await activeTestId()) === 'repo-source', 'focus lands on Repository', String(await activeTestId()))
    check(await form.getByRole('radio', { name: 'From GitHub', exact: true }).isChecked(), 'the segment switched')
    await form.getByRole('radio', { name: 'Existing code', exact: true }).check({ force: true })
    await folder.fill(base)
    await sleep(600)
    check((await tid('repo-bridge').count()) === 0, 'a real path offers nothing')
    await closeForm()
  }
} catch (err) {
  check(false, `script threw: ${err?.message ?? err}`)
  await screenshot(page, 'clone-start-threw').catch(() => {})
} finally {
  await app.close().catch(() => {})
  fs.rmSync(base, { recursive: true, force: true })
}
finish('clone-start')
