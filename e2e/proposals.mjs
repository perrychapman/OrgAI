// Token-free. Mock adapter, temp ORGAI_DATA_DIR. Proposal cards inside runs (docs/design/ux-review-proposals-in-runs.md:
// H1 compact frame, M2 kind labels, M5 proposer, M7 roomy frame). A project MCP assistant proposes to narrow one server,
// remove another and add a new one; a work run leaves two background permission cards, an ask_user question and then an
// org chart proposal open together (the stepper). Checks at 1024x640 (dark and light) and 1600x1000.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, cleanup, createProject, endSession, finish, launch, log, makeFixtureRepo, projectTab, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const scriptFile = path.join(fs.mkdtempSync(path.join(TMP, 'orgai-e2e-proposals-script-')), 'script.json')
const writeScript = (s) => fs.writeFileSync(scriptFile, JSON.stringify(s))
writeScript({ delayMs: 200 })
process.env.ORGAI_MOCK_SCRIPT = scriptFile

const NAME = 'E2E proposals (orgai test)'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-proposals-'))
const repo = path.join(base, 'repo')
makeFixtureRepo('proposals', { at: repo })

const { app, page, shot } = await launch({ shotPrefix: 'proposals' })
page.setDefaultTimeout(8000)
const setSize = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await page.waitForFunction((cw) => Math.abs(window.innerWidth - cw) <= 1, w, { timeout: 10_000 }).catch(() => {})
  await sleep(600)
}
const setTheme = async (theme) => {
  await page.evaluate(async (t) => {
    const s = await window.orgai.settings.get()
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, theme: t } })
  }, theme)
  await sleep(500)
}
const SERVER = (id, name, roles, pkg) => ({
  id,
  name,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', `${pkg}@1.0.0`],
  enabled: true,
  roles,
  source: 'user',
  addedAt: '2026-01-01T00:00:00.000Z'
})

/** Geometry of the tray, stage, shown card and body, in viewport pixels. */
const geometry = () =>
  page.evaluate(() => {
    const box = (el) => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { t: b.top, b: b.bottom, l: b.left, r: b.right, h: b.height }
    }
    const tray = document.querySelector('section.frame-tray')
    const stage = document.querySelector('.frame-stage')
    const frame = document.querySelector('.canvas-frame')
    const card = tray?.querySelector('.decision-card.kind-proposal')
    const body = card?.querySelector('.decision-body')
    const server = card?.querySelector('[data-testid=mcp-proposal-server]')
    const trayBox = box(tray)
    // Nothing in the stage may be positioned over the tray (no fixed/absolute overlay escaping the stage).
    let overlap = 0
    if (stage && trayBox) {
      const sb = stage.getBoundingClientRect()
      if (sb.height > 8) {
        for (const el of stage.querySelectorAll('*')) {
          const b = el.getBoundingClientRect()
          if (b.width > 0 && b.height > 0 && b.bottom > trayBox.t + 1 && b.top < trayBox.b && b.right > trayBox.l && b.left < trayBox.r && getComputedStyle(el).position === 'fixed') overlap++
        }
      }
    }
    const hint = document.querySelector('.composer-hint')
    return {
      tray: trayBox,
      stage: box(stage),
      frame: box(frame),
      card: box(card),
      body: body && getComputedStyle(body).display !== 'none' ? box(body) : null,
      server: box(server),
      vh: window.innerHeight,
      compact: tray?.getAttribute('data-compact') ?? null,
      expanded: card?.getAttribute('data-expanded') ?? null,
      overlap,
      composer: box(document.querySelector('.composer')),
      composerHint: hint ? getComputedStyle(hint).display : null
    }
  })
const insideTray = (g) => !!g.server && !!g.tray && g.server.t >= g.tray.t - 0.5 && g.server.b <= g.tray.b + 0.5 && g.server.t >= 0 && g.server.b <= g.vh
const details = () => page.locator('.decision-card.kind-proposal .decision-details')

try {
  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'project created on the mock adapter')
  const pid = project.id
  await setSize(1024, 640)
  await setTheme('dark')

  // ---- Scenario 1: project MCP assistant, three changes ----
  const GH = 'mcp_e2e_github'
  const FS = 'mcp_e2e_fs'
  await page.evaluate(
    async ([id, a, b]) => {
      await window.orgai.mcp.upsert({ projectId: id, spec: a })
      await window.orgai.mcp.upsert({ projectId: id, spec: b })
    },
    [pid, SERVER(GH, 'github-issues', ['orchestrator', 'implementer'], 'gh-issues-server'), SERVER(FS, 'mock-fs', ['implementer'], 'mock-fs-server')]
  )
  writeScript({
    delayMs: 200,
    mcpAssist: [
      { type: 'text', text: 'I will tighten who can use the issue tracker and tidy the file server.' },
      {
        type: 'harness',
        name: 'propose_mcp_servers',
        retryOnRevise: false,
        args: {
          title: 'Tighten MCP access',
          rationale: 'Only the reviewer needs the issue tracker; mock-fs is unused; release notes need a server.',
          upsert: [
            { ...SERVER(GH, 'github-issues', ['reviewer'], 'gh-issues-server'), projectOnly: true },
            { ...SERVER('mcp_e2e_notes', 'release-notes', ['orchestrator'], 'release-notes-server'), projectOnly: true }
          ],
          remove: [FS]
        }
      },
      { type: 'text', text: 'Done.' }
    ]
  })
  await projectTab(page, 'Live').click()
  await page.evaluate((id) => window.orgai.mcp.startAssist({ projectId: id, scope: 'project', instruction: 'Tighten access' }), pid)
  const card = page.locator('section.frame-tray .decision-card.kind-proposal')
  await page.locator('.run-tablist [role="tab"]', { hasText: 'R1' }).click()
  await card.waitFor({ timeout: 30_000 })
  await sleep(500)

  let g = await geometry()
  check(g.compact === 'true', 'the tray is compact at 1024x640', JSON.stringify(g.frame))
  const summary = ((await page.locator('[data-testid=decision-summary]').first().innerText().catch(() => '')) || '').trim()
  check(/github-issues/.test(summary) && /mock-fs/.test(summary), 'the folded card shows a summary naming the servers', summary)
  const summaryBox = await page
    .locator('[data-testid=decision-summary]')
    .first()
    .evaluate((el) => ({ one: el.scrollHeight <= el.clientHeight + 2, title: el.getAttribute('title'), ws: getComputedStyle(el).whiteSpace }))
    .catch(() => ({}))
  check(summaryBox.one && summaryBox.ws === 'nowrap' && summaryBox.title === summary, 'the summary is one line with the full text in its title', JSON.stringify(summaryBox))
  check(g.body === null && g.expanded === 'false', 'the body is folded behind Details at first', JSON.stringify(g.body))
  const focused = await page.evaluate(() => document.activeElement?.className ?? '')
  check(/decision-details/.test(focused), 'first focus on the card is Details', focused)
  await shot('mcp-folded-1024-dark')

  // Needs you: the item names the kind first, and Enter on it lands on Details of the folded card.
  await page.locator('[data-testid=needs-you-row]').click()
  const item = page.locator('[data-testid=needs-you-list] .needs-item').first()
  await item.waitFor()
  const itemText = ((await item.innerText()) || '').replace(/\s+/g, ' ').trim()
  check(/^MCP servers:/.test(itemText), 'the Needs you item starts with the proposal kind', itemText)
  await item.focus()
  await page.keyboard.press('Enter')
  await sleep(600)
  const focusedAfterJump = await page.evaluate(() => document.activeElement?.className ?? '')
  check(/decision-details/.test(focusedAfterJump), 'Enter on a Needs you item lands on Details of a folded proposal', focusedAfterJump)

  // Enter expands; the tray takes the frame; the first server is visible without scrolling.
  await page.keyboard.press('Enter')
  await sleep(600)
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') await setTheme('light')
    g = await geometry()
    const tag = `at 1024x640 ${theme}`
    check(g.expanded === 'true' && !!g.body, `Details expands the body ${tag}`, JSON.stringify(g.body))
    check(!!g.stage && g.stage.h < 2, `the stage collapses to nothing while a proposal is open ${tag}`, JSON.stringify(g.stage))
    check(!!g.stage && !!g.tray && g.stage.b <= g.tray.t + 0.5 && g.overlap === 0, `nothing in the stage overlaps the tray ${tag}`, JSON.stringify({ stage: g.stage, tray: g.tray }))
    check(!!g.body && g.body.h >= 200, `the card body is at least 200 px tall ${tag}`, `${g.body?.h}`)
    check(insideTray(g), `the first server is fully visible inside the tray ${tag}`, JSON.stringify({ server: g.server, tray: g.tray, vh: g.vh }))
    check(g.composerHint === 'none' || g.composerHint === null, `the composer folds its hint ${tag}`, String(g.composerHint))
    check(!!g.composer && g.composer.h <= 70, `the composer folds to one line ${tag}`, `${g.composer?.h}`)
    check((await page.locator('.composer textarea').count()) === 1 && (await page.locator('.composer textarea').isVisible()), `the composer textarea stays reachable ${tag}`)
    await shot(`mcp-expanded-1024-${theme}`)
  }
  const summaryLine = ((await page.locator('[data-testid=proposal-summary]').first().innerText().catch(() => '')) || '').trim()
  check(/access change/.test(summaryLine) && /removal/.test(summaryLine), 'the body opens with a summary line', summaryLine)
  const gh = page.locator('[data-testid=mcp-proposal-server][data-server=github-issues]')
  check((await gh.getAttribute('data-change').catch(() => null)) === 'access', 'github-issues reads as an access change')
  const ghText = ((await gh.innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
  check(/\(was /.test(ghText), 'the access change shows the roles it was', ghText)
  const rm = ((await page.locator('[data-testid=mcp-proposal-removal][data-server=mock-fs]').innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
  check(/mock-fs/.test(rm) && /from this project/.test(rm) && !/mcp_/.test(rm), 'the removal names mock-fs and never the internal id', rm)

  // Collapse Details: the stage comes back and the canvas is usable again.
  await details().click()
  await sleep(700)
  g = await geometry()
  check(!!g.stage && g.stage.h > 40 && g.expanded === 'false', 'collapsing Details restores the stage', JSON.stringify(g.stage))
  const stageChild = await page.evaluate(() => document.querySelector('.frame-stage > *')?.getBoundingClientRect().height ?? -1)
  check(stageChild > 40, 'the stage content is back at a usable height', String(stageChild))

  // A single-agent run opens in the conversation layout; switch to the graph layout and expand again: same result.
  const layout0 = await page.locator('.run-body').getAttribute('data-layout')
  await page.locator('[data-testid=run-layout-toggle]').click()
  await sleep(500)
  await details().click()
  await sleep(600)
  g = await geometry()
  const layout1 = await page.locator('.run-body').getAttribute('data-layout')
  check(layout0 !== layout1 && g.expanded === 'true' && !!g.body && g.body.h >= 200 && !!g.stage && g.stage.h < 2, `the ${layout1} layout gives the expanded card the frame too (was ${layout0})`, JSON.stringify({ body: g.body, stage: g.stage }))
  await shot('mcp-expanded-graph-layout-1024')
  await details().click()
  await page.locator('[data-testid=run-layout-toggle]').click()
  await sleep(400)

  // 1600x1000: the tray stays within about 60% of the frame and the summary is in the body.
  await setSize(1600, 1000)
  if ((await page.locator('.decision-card.kind-proposal').getAttribute('data-expanded')) !== 'true' && (await details().isVisible().catch(() => false))) await details().click()
  await sleep(500)
  g = await geometry()
  check(!!g.tray && !!g.frame && g.tray.h <= g.frame.h * 0.62, 'at 1600x1000 the tray takes at most about 60% of the frame', JSON.stringify({ tray: g.tray?.h, frame: g.frame?.h }))
  check((await page.locator('[data-testid=proposal-summary]').count()) === 1, 'at 1600x1000 the body shows the proposal summary')
  await shot('mcp-1600')
  await setSize(1024, 640)

  // Approve and wind this run down.
  await page.locator('.decision-card.kind-proposal .btn.primary').click()
  await sleep(1500)
  await endSession(page)

  // ---- Scenario 2: work run, three open decisions ----
  const roles = ['Orchestrator', 'Implementer', 'Reviewer', 'Researcher'].map((n, i) => ({
    name: n,
    description: `${n} role`,
    responsibilities: ['Do the work'],
    prompt: `You are the ${n}. Do the work you are given and report what you did in a few lines for the team lead.`,
    tools: ['Read', 'Glob', 'Grep'],
    model: 'everyday',
    canSpawn: i === 0,
    spawnable: i === 0 ? ['Implementer', 'Reviewer', 'Researcher'] : [],
    reportsTo: i === 0 ? null : 'Orchestrator'
  }))
  roles.push({
    name: 'Release writer',
    description: 'Writes release notes',
    responsibilities: ['Write notes'],
    prompt: 'You write release notes from merged changes. Keep them short, accurate and in the project voice.',
    tools: ['Read', 'Glob'],
    model: 'fast',
    canSpawn: false,
    spawnable: [],
    reportsTo: 'Orchestrator'
  })
  writeScript({
    delayMs: 200,
    work: [
      { type: 'text', text: 'Splitting the work.' },
      { type: 'spawn', id: 'e2e-a', description: 'Edit the notes route' },
      { type: 'spawn', id: 'e2e-b', description: 'Run the tests' },
      { type: 'tool', agent: 'e2e-a', name: 'Edit', input: { file_path: 'src/notes.js', old_string: 'a', new_string: 'b' }, ask: true, background: true, result: 'ok' },
      { type: 'tool', agent: 'e2e-b', name: 'Bash', input: { command: 'npm test' }, ask: true, background: true, result: 'ok' },
      { type: 'harness', name: 'ask_user', retryOnRevise: false, args: { question: 'Which limiter strategy?', options: [{ label: 'Fixed window' }, { label: 'Token bucket' }] } },
      { type: 'harness', name: 'propose_org_change', retryOnRevise: false, args: { title: 'Add a release writer', rationale: 'Release notes keep getting skipped.', roles } },
      { type: 'text', text: 'Carrying on.' }
    ]
  })
  await projectTab(page, 'Live').click()
  await page.keyboard.press('Control+t').catch(() => {})
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill('Work with three decisions')
  await page.locator('.composer .btn.primary').click()
  await page.locator('.decision-card.kind-question').waitFor({ timeout: 30_000 })
  await page.locator('.decision-card.kind-question .question-option').first().click()
  await page.locator('.decision-card.kind-question .btn.primary').click()
  await page.locator('.decision-card.kind-proposal').waitFor({ timeout: 30_000 })
  await sleep(600)
  const chips = (await page.locator('.decision-chip-label').allInnerTexts()).map((t) => t.trim())
  check(chips.some((t) => /^Org chart: /.test(t)), 'the stepper chip for the org chart proposal starts with its kind', chips.join(' | '))
  check(chips.length >= 3, 'three decisions are open', String(chips.length))
  const who = ((await page.locator('.decision-card.kind-proposal .decision-who-name').innerText().catch(() => '')) || '').trim()
  check(who === 'Orchestrator', 'the proposal names the proposing agent', who)
  g = await geometry()
  check(g.compact === 'true', 'the tray is compact with three decisions')
  log('focus after arrival with three decisions:', await page.evaluate(() => document.activeElement?.className ?? ''))
  if (g.expanded !== 'true') await details().click()
  await sleep(700)
  g = await geometry()
  check(!!g.body && g.body.h >= 200, 'with the stepper the body is still at least 200 px', `${g.body?.h}`)
  check((await page.locator('.decision-stepper').isVisible()) && !!g.stage && g.stage.h < 2, 'the stepper still shows while the stage is collapsed')
  const firstChild = await page.evaluate(() => {
    const body = document.querySelector('.decision-card.kind-proposal .decision-body')
    const tray = document.querySelector('section.frame-tray')
    const first = body?.firstElementChild?.getBoundingClientRect()
    const t = tray?.getBoundingClientRect()
    return first && t ? { ok: first.top >= t.top - 0.5 && first.bottom <= t.bottom + 0.5, first: [first.top, first.bottom], tray: [t.top, t.bottom] } : null
  })
  check(!!firstChild?.ok, 'the first block of the proposal body is visible without scrolling', JSON.stringify(firstChild))
  await shot('three-decisions-1024')
  await details().click()
  await sleep(600)
  g = await geometry()
  check(!!g.stage && g.stage.h > 40, 'collapsing Details restores the stage with three decisions', JSON.stringify(g.stage))
} finally {
  await cleanup(app, page, NAME)
  finish('proposals')
}
