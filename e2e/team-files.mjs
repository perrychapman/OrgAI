// Token-free (mock adapter). Team files (.orgai/ in a project folder, docs/design/team-files.md): a git repo holds a team.
// New project from that folder shows the found team and creates it with the digest; a pulled prompt edit applies at once
// with an Undo that rewrites the file; a power change (Bash, a new MCP server) pends with a Needs-you item and a card
// (before/after, full target), Approve and Reject work, a stale digest is refused; Commit commits only team files.
// Keyboard path, focus after Approve and no page scroll are checked at 1024x640 and 1600x1000 in both themes.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { check, cleanup, finish, findProject, git as git0, gitSafe, gotoProjects, launch, log, makeFixtureRepo, openProjectForm, projectTab, removeFixture, sleep, writeFile } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E team files (orgai test)'

// The app runs its own git calls against this repo; retry when one holds the index lock.
const git = (cwd, args) => {
  for (let i = 0; ; i++) {
    try {
      return git0(cwd, args)
    } catch (e) {
      if (i >= 8 || !/index\.lock/.test(String(e.message))) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)
    }
  }
}
const q = (s) => JSON.stringify(s)
const role = ({ name, description, tools, canSpawn = false, spawnable = [], reportsTo = null, color, prompt }) =>
  `---\nname: ${q(name)}\ndescription: ${q(description)}\nresponsibilities: []\ntools:\n${tools.map((t) => `  - ${q(t)}`).join('\n')}\ntier: "everyday"\ncanSpawn: ${canSpawn}\n${
    spawnable.length ? `spawnable:\n${spawnable.map((t) => `  - ${q(t)}`).join('\n')}` : 'spawnable: []'
  }\nreportsTo: ${reportsTo === null ? 'null' : q(reportsTo)}\ncolor: ${q(color)}\nskills: []\nmcpServers: []\n---\n\n${prompt}\n`
const LEAD_PROMPT = 'You lead the team. Split work and review results.'
const DEV_PROMPT = 'You build features. Keep changes small.'
const leadFile = (prompt = LEAD_PROMPT) => role({ name: 'Lead', description: 'Leads the team', tools: ['Read', 'Glob', 'Grep'], canSpawn: true, spawnable: ['dev'], color: '#6d5ae6', prompt })
const devFile = (tools = ['Read', 'Grep'], prompt = DEV_PROMPT) => role({ name: 'Dev', description: 'Builds features', tools, reportsTo: 'lead', color: '#2f9e6e', prompt })

const repo = makeFixtureRepo('teamfiles')
writeFile(repo, '.orgai/team.json', `${JSON.stringify({ format: 'orgai.team/1', brief: 'A tiny notes API.', permissionMode: 'default' }, null, 2)}\n`)
writeFile(repo, '.orgai/agents/lead.md', leadFile())
writeFile(repo, '.orgai/agents/dev.md', devFile())
git(repo, ['add', '-A'])
git(repo, ['commit', '-q', '-m', 'add team files'])
const orgai = (rel) => path.join(repo, '.orgai', rel)
const read = (rel) => fs.readFileSync(orgai(rel), 'utf8')
const SERVER_URL = 'https://docs.example.com/mcp/v1/team-e2e-endpoint'
log('fixture at', repo)

const { app, page, shot } = await launch({ shotPrefix: 'team-files' })
page.setDefaultTimeout(10_000)

const setSize = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await page.waitForFunction((cw) => Math.abs(window.innerWidth - cw) <= 1, w, { timeout: 10_000 }).catch(() => {})
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await sleep(500)
}
const setTheme = async (theme) => {
  await page.evaluate(async (t) => {
    const s = await window.orgai.settings.get()
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, theme: t } })
  }, theme)
  await sleep(400)
}
const pid = async () => (await findProject(page, NAME))?.id
/** Ask main to look at the folder now (what window focus does), then give the push time to reach the store. */
const refresh = async () => {
  const id = await pid()
  const s = await page.evaluate((i) => window.orgai.teamFiles.status({ projectId: i }), id)
  await sleep(500)
  return s
}
const line = () => page.locator('[data-testid=team-files-line]')
const lineText = async () => ((await line().innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim()
const waitLine = (re, timeout = 10_000) =>
  page.waitForFunction(([src]) => new RegExp(src).test((document.querySelector('[data-testid=team-files-line]')?.textContent ?? '').replace(/\s+/g, ' ')), [re.source], { timeout }).then(() => true, () => false)
const noPageScroll = () => page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight && document.body.scrollHeight <= window.innerHeight && document.documentElement.scrollWidth <= window.innerWidth)
const onReal = () =>
  page.evaluate(() => {
    const a = document.activeElement
    return !!a && a !== document.body && a !== document.documentElement ? `${a.tagName.toLowerCase()}${a.getAttribute('data-testid') ? '[' + a.getAttribute('data-testid') + ']' : ''}` : ''
  })
const focusLands = () => page.waitForFunction(() => document.activeElement && document.activeElement !== document.body, null, { timeout: 4000, polling: 100 }).then(() => true, () => false)
const gotoTeam = async () => {
  await page.locator('[data-testid=tab-team]').click()
  await line().waitFor({ timeout: 10_000 })
}

try {
  await setSize(1600, 1000)

  // ---- 1. New project from a folder that holds a team ----
  await gotoProjects(page)
  const form = await openProjectForm(page)
  await form.locator('[data-testid=project-kind-option][data-kind=code] input[type=radio]').check({ force: true })
  await form.getByRole('radio', { name: 'Existing code', exact: true }).check({ force: true })
  await form.locator('input[placeholder*="repo"]').fill(repo)
  await form.locator('input[placeholder*="Defaults to the folder name"]').fill(NAME)
  const found = page.locator('[data-testid=team-found]')
  await found.waitFor({ timeout: 15_000 })
  const foundText = (await found.innerText()).replace(/\s+/g, ' ')
  check(/2 roles/i.test(await page.locator('[data-testid=team-found-counts]').innerText()), 'found panel counts two roles', await page.locator('[data-testid=team-found-counts]').innerText())
  check((await page.locator('[data-testid=team-found-role]').count()) === 2, 'found panel lists two roles')
  check((await page.locator('[data-testid=team-found-role][data-slug=lead]').count()) === 1 && (await page.locator('[data-testid=team-found-role][data-slug=dev]').count()) === 1, 'roles carry their slugs')
  check((await page.locator('[data-testid=team-found-settings]').count()) === 1, 'found panel shows the settings')
  check(/Start other agents|start other agents|spawn/i.test(foundText), 'found panel names the power the lead holds', foundText.slice(0, 400))
  check(!/Replace|Import|setup-choice/i.test(foundText) && (await form.locator('[data-testid=setup-choice]').count()) === 0, 'no default chart, Replace or import wording for a found team', foundText.match(/.{0,60}(Replace|Import).{0,60}/i)?.[0])
  check((await page.locator('[data-testid=team-architect]').count()) === 1, 'the Architect is an option, not the path')
  const submit = form.locator('[data-testid=new-project-submit]')
  check(/^Create project$/.test((await submit.innerText()).trim()), 'primary button reads Create project', await submit.innerText())
  await shot('found')
  await submit.click()
  await page.waitForSelector('[data-testid=dashboard]', { state: 'detached', timeout: 60_000 })
  let project = await findProject(page, NAME)
  check(!!project && ['lead', 'dev'].every((s) => project.roles.some((r) => r.slug === s)) && project.roles.length === 2, 'project opens with the team roles and no default chart', JSON.stringify(project?.roles.map((r) => r.slug)))
  await gotoTeam()
  check(await waitLine(/in sync/i), 'Team tab line says in sync', await lineText())
  check((await page.locator('[data-testid=export-org]').count()) === 0, 'no export button')
  check(read('agents/lead.md') === leadFile(), 'creating from the folder did not rewrite the files')
  await shot('in-sync')

  // ---- 2. A pulled change that applies at once ----
  fs.writeFileSync(orgai('agents/dev.md'), devFile(['Read', 'Grep'], 'You build features. Write tests first.'))
  await refresh()
  const applied = page.locator('[data-testid=team-files-applied]')
  await applied.waitFor({ timeout: 10_000 }).catch(() => {})
  const appliedText = (await applied.innerText().catch(() => '')).replace(/\s+/g, ' ')
  check(/1 change applied/i.test(appliedText), 'applied notice appears', appliedText)
  check(/Undo rewrites .*agents\/dev\.md.*uncommitted/i.test(await page.locator('[data-testid=team-files-undo-files]').innerText().catch(() => '')), 'Undo says which file it rewrites and that it shows as uncommitted')
  check((await findProject(page, NAME)).roles.find((r) => r.slug === 'dev').prompt.includes('Write tests first'), 'the new prompt is in the chart without a card')
  await shot('applied')
  await page.locator('[data-testid=team-files-undo]').click()
  await page.locator('[data-testid=team-files-undone]').waitFor({ timeout: 10_000 })
  check(read('agents/dev.md').includes('Keep changes small') && !read('agents/dev.md').includes('Write tests first'), 'Undo rewrote the file on disk')
  check((await findProject(page, NAME)).roles.find((r) => r.slug === 'dev').prompt === DEV_PROMPT, 'Undo put the prompt back in the chart')
  check(await waitLine(/changed, not committed/i), 'after Undo the line shows uncommitted', await lineText())
  // Commit from the line brings it back to in sync.
  await page.locator('[data-testid=team-files-commit]').click()
  check(await waitLine(/in sync/i), 'in sync once the undone files are committed from the line', (await lineText()) + ' | ' + gitSafe(repo, ['status', '--porcelain']))

  // ---- 3. A power change pends, shows in Needs you, is approved ----
  const before = (await refresh()).digest
  fs.writeFileSync(orgai('agents/dev.md'), devFile(['Read', 'Grep', 'Bash']))
  const s3 = await refresh()
  check(s3.state === 'pending', 'adding Bash pends', s3.state)
  check(await waitLine(/1 change needs your approval/i), 'line says 1 change needs your approval', await lineText())
  check((await page.locator('[data-testid=team-files-review]').count()) === 1, 'Review changes button is offered')
  check((await findProject(page, NAME)).roles.find((r) => r.slug === 'dev').tools.every((t) => t !== 'Bash'), 'the chart does not have Bash yet')
  // Needs you: the bell, then the Dashboard.
  const bell = page.locator('[data-testid=needs-you-row]').first()
  if (await bell.count()) {
    await bell.click()
    const item = page.locator('[data-testid=needs-item][data-kind=team], [data-testid=needs-you-list] [data-kind=team]')
    check(await item.first().waitFor({ timeout: 5000 }).then(() => true, () => false), 'Needs-you list holds the team item', (await page.locator('[data-testid=needs-you-list]').innerText().catch(() => 'no list')).slice(0, 200))
    await page.keyboard.press('Escape')
  } else check(false, 'found the Needs-you bell')
  await gotoProjects(page)
  check((await page.locator('[data-testid=dash-needs-row][data-kind=team]').count()) === 1, 'Dashboard Needs you has the team row')
  await shot('dashboard-needs')
  await page.locator('[data-testid=dash-needs-row][data-kind=team]').first().click()
  await page.locator('[data-testid=team-files-card]').waitFor({ timeout: 10_000 })
  check(true, 'the Needs-you row opens the Team tab card')
  const card = page.locator('[data-testid=team-files-card]')
  await card.getByRole('button', { name: /Details/ }).click().catch(() => {})
  const change = card.locator('[data-testid=team-files-change][data-kind=role]').first()
  check((await change.getAttribute('data-needs-approval')) === 'true', 'the role change needs approval')
  check(/Bash/.test(await change.innerText()) && /run commands/i.test(await change.innerText()), 'card names Bash and what it can do', (await change.innerText()).slice(0, 200))
  await change.getByText('Show all tools').click().catch(() => {})
  const toolsText = (await change.innerText()).replace(/\s+/g, ' ')
  check(/Before: Grep, Read\./.test(toolsText) && /After: Bash, Grep, Read\./.test(toolsText), 'card shows before and after tools', toolsText.slice(0, 300))
  await shot('card')

  // Stale digest: approving what was reviewed after the files moved again is refused.
  const reviewed = (await refresh()).digest
  check(!!reviewed && reviewed !== before, 'the pending status carries its own digest')
  fs.writeFileSync(orgai('agents/dev.md'), devFile(['Read', 'Grep', 'Bash'], DEV_PROMPT + ' Be brief.'))
  const staleErr = await page.evaluate(({ i, d }) => window.orgai.teamFiles.approve({ projectId: i, digest: d }).then(() => '', (e) => String(e?.message ?? e)), { i: await pid(), d: reviewed })
  check(/review them again|changed/i.test(staleErr), 'a stale digest is refused', staleErr)
  await refresh()

  await card.waitFor({ timeout: 10_000 })
  await page.locator('[data-testid=team-files-approve]').click()
  check(await waitLine(/Approved\. The team in use/), 'line leaves the pending state after Approve', await lineText())
  check((await findProject(page, NAME)).roles.find((r) => r.slug === 'dev').tools.includes('Bash'), 'Approve put Bash on the chart')
  check((await page.locator('[data-testid=team-files-card]').count()) === 0, 'the card is gone')
  check(await focusLands(), 'focus is on a real element after Approve', await onReal())
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'dev can run commands'])
  await refresh()

  // Reject path: another power change.
  fs.writeFileSync(orgai('agents/dev.md'), devFile(['Read', 'Grep', 'Bash', 'Write'], DEV_PROMPT + ' Be brief.'))
  await refresh()
  await waitLine(/need.* your approval/i)
  await page.locator('[data-testid=team-files-review]').click()
  await page.locator('[data-testid=team-files-card]').waitFor()
  await page.locator('[data-testid=team-files-reject]').click()
  check(await waitLine(/differ from the team in use/i), 'Reject leaves the files differing from the team in use', await lineText())
  check(!(await findProject(page, NAME)).roles.find((r) => r.slug === 'dev').tools.includes('Write'), 'Reject keeps the chart as it was')
  check(await focusLands(), 'focus is on a real element after Reject', await onReal())
  git(repo, ['checkout', '--', '.orgai'])
  await refresh()
  check(await waitLine(/in sync/i), 'restoring the files clears the rejected state', await lineText())

  // A new MCP server in mcp.json: the target is shown in full.
  writeFile(repo, '.orgai/mcp.json', `${JSON.stringify({ format: 'orgai.team/1', servers: [{ name: 'docs', transport: 'http', url: SERVER_URL, enabled: true }] }, null, 2)}\n`)
  await refresh()
  await waitLine(/need.* your approval/i)

  // ---- 5. Keyboard, focus and no page scroll, both sizes and themes ----
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    for (const theme of ['dark', 'light']) {
      const tag = `${w}x${h} ${theme}`
      await setSize(w, h)
      await setTheme(theme)
      await gotoTeam()
      await page.locator('[data-testid=team-files-review]').waitFor({ timeout: 10_000 })
      check(await noPageScroll(), `no page scroll with the Review line (${tag})`)
      // Tab to Review changes.
      await page.locator('[data-testid=tab-team]').focus()
      let reached = ''
      for (let i = 0; i < 60 && reached !== 'button[team-files-review]'; i++) {
        await page.keyboard.press('Tab')
        reached = await onReal()
      }
      check(reached === 'button[team-files-review]', `Tab reaches Review changes (${tag})`, reached)
      const ring = await page.evaluate(() => {
        const cs = getComputedStyle(document.activeElement)
        return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 ? 'outline' : cs.boxShadow !== 'none' ? 'shadow' : ''
      })
      check(ring !== '', `Review changes shows a focus ring (${tag})`)
      await page.keyboard.press('Enter')
      await page.locator('[data-testid=team-files-card]').waitFor()
      await sleep(300)
      check(await noPageScroll(), `no page scroll with the card open (${tag})`)
      const target = page.locator('[data-testid=team-files-target]')
      if (!(await target.count())) await page.locator('[data-testid=team-files-card] .decision-details').click().catch(() => {})
      check(((await target.first().innerText().catch(() => '')) || '').includes(SERVER_URL), `card shows the server address in full (${tag})`)
      const approveBox = await page.locator('[data-testid=team-files-approve]').boundingBox()
      check(!!approveBox && approveBox.y + approveBox.height <= h + 1 && approveBox.y >= 0, `Approve is inside the window (${tag})`, JSON.stringify(approveBox))
      let seen = false
      for (let i = 0; i < 40 && !seen; i++) {
        await page.keyboard.press('Tab')
        seen = (await onReal()) === 'button[team-files-approve]'
      }
      check(seen, `Tab reaches Approve (${tag})`)
      if (w === 1024 && theme === 'dark') await shot('card-small-dark')
      if (w === 1600 && theme === 'light') await shot('card-large-light')
    }
  }

  // Approve by keyboard: the new server lands on the project.
  await setSize(1600, 1000)
  await setTheme('dark')
  const approve = page.locator('[data-testid=team-files-approve]')
  await approve.focus()
  await page.keyboard.press('Enter')
  check(await waitLine(/Approved\. The team in use/), 'keyboard Approve leaves the pending state', await lineText())
  check((await findProject(page, NAME)).mcpServers?.some((m) => m.name === 'docs' && m.url === SERVER_URL), 'the approved server is on the project')
  check(!!(await onReal()), 'focus is on a real element after keyboard Approve', await onReal())
  check(await noPageScroll(), 'no page scroll after Approve')

  // ---- 4. Commit ----
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'not part of the team\n')
  await refresh()
  check(await waitLine(/changed, not committed/i), 'line says changed, not committed', await lineText())
  const headBefore = git(repo, ['rev-parse', 'HEAD'])
  await page.locator('[data-testid=team-files-commit]').focus()
  await page.keyboard.press('Enter')
  check(await waitLine(/in sync/i), 'after Commit the line reads in sync', await lineText())
  const headAfter = git(repo, ['rev-parse', 'HEAD'])
  check(headAfter !== headBefore, 'Commit made a commit')
  const files = git(repo, ['show', '--name-only', '--pretty=format:', 'HEAD']).split(/\r?\n/).filter(Boolean)
  check(files.length > 0 && files.every((f) => f.startsWith('.orgai/')), 'the commit holds only team files', files.join(', '))
  check(gitSafe(repo, ['status', '--porcelain']).includes('notes.txt'), 'an unrelated untracked file stays out of the commit')
  check(await focusLands(), 'focus is on a real element after Commit', await onReal())
  await shot('committed')
} catch (e) {
  check(false, 'team files flow ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await cleanup(app, page, NAME)
}
removeFixture(repo)
finish('e2e/team-files')
