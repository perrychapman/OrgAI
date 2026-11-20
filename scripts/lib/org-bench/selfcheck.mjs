// `node scripts/bench-org-chart.mjs --self-check`: proves, without a token or a network call, that the real source loads
// through jiti, that the real propose_org_chart validation accepts a canned valid chart and refuses a canned invalid one (both
// families), that the scorer works on what the stub captures, and that the session driver (stub tools, follow-up answers,
// end on capture) works against a scripted fake `query`. A broken import or a renamed export fails here, before a paid run.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { goodC1 } from './canned.mjs'
import { buildCase, cleanupDir, loadSource } from './load.mjs'
import { ALL_TOOLS, scoreChart, scoreRevision } from './score.mjs'
import { RETRO_SCENARIOS, recordPaths, scenarioById } from './scenarios.mjs'
import { makeHandlers, newState, runSession } from './session.mjs'

const ARCH_ARGS = { title: 'Architecture', summary: 'A small script.', stack: ['Python 3'], modules: [{ name: 'script', purpose: 'renames photos', paths: ['rename.py'] }], conventions: ['PEP 8'], commands: [{ name: 'run', command: 'python rename.py DIR' }], risks: [] }

/**
 * Runs a retro fixture's own tests in its prepared folder (`scenario.exec`: runner 'node' = node:test, 'python' = unittest; cwd
 * relative to the folder; `tests` = the count the run record claims). No package is installed: fixtures with `exec` use only
 * Node built-ins or the standard library. Returns { skipped, note } when the toolchain is missing, else { passed, failed, ok }.
 */
export function runFixtureTests(scenario, dir) {
  const ex = scenario.exec
  if (!ex) return { skipped: true, note: 'static fixture: its tests need packages that are not installed' }
  const cwd = join(dir, ...ex.cwd.split('/').filter((p) => p && p !== '.'))
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', NODE_NO_WARNINGS: '1' }
  delete env.NODE_TEST_CONTEXT // set when this runs inside node --test: the child must report on its own
  if (ex.runner === 'node') {
    const [major, minor] = process.versions.node.split('.').map(Number)
    if (major < 22 || (major === 22 && minor < 13)) return { skipped: true, note: `node ${process.versions.node} is older than 22.13 (node:sqlite)` }
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd, env, encoding: 'utf8', timeout: 120_000 })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    const passed = Number(/^# pass (\d+)/m.exec(out)?.[1] ?? NaN)
    const failed = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? NaN)
    return { ok: r.status === 0 && failed === 0 && passed === ex.tests, passed, failed, expected: ex.tests, log: out.slice(-1500) }
  }
  for (const py of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const r = spawnSync(py, ['-m', 'unittest', 'discover', '-s', 'tests'], { cwd, env, encoding: 'utf8', timeout: 120_000 })
    const ran = /^Ran (\d+) tests?/m.exec(r.stderr ?? '')
    if (r.error || !ran) continue // not installed, or a Windows store stub
    const passed = Number(ran[1])
    return { ok: r.status === 0 && passed === ex.tests, passed, failed: r.status === 0 ? 0 : 'some', expected: ex.tests, log: (r.stderr ?? '').slice(-1500) }
  }
  return { skipped: true, note: 'python 3 not found' }
}

/** A scripted stand-in for the SDK's query(): each turn is a list of { text } or { tool, args } actions; one result per turn. */
export function scriptedQuery(script) {
  return ({ prompt }, api) => {
    const it = prompt[Symbol.asyncIterator]()
    let interrupted = 0
    const gen = (async function* () {
      yield { type: 'system', subtype: 'init', model: 'scripted-model' }
      let turn = 0
      for (const actions of script) {
        const user = await it.next()
        if (user.done) return
        turn += 1
        for (const a of actions) {
          if (a.text !== undefined) yield { type: 'assistant', message: { content: [{ type: 'text', text: a.text }] }, parent_tool_use_id: null }
          else {
            yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu-${turn}`, name: `mcp__orgai__${a.tool}`, input: a.args }] }, parent_tool_use_id: null }
            const out = await api.callTool(a.tool, a.args)
            yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu-${turn}`, content: out }] }, parent_tool_use_id: null }
          }
        }
        yield { type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.01 * turn, modelUsage: { scripted: { inputTokens: 100 * turn, outputTokens: 10 * turn } } }
      }
    })()
    gen.interrupt = async () => { interrupted += 1 }
    gen.close = () => {}
    gen.interrupted = () => interrupted
    return gen
  }
}

export async function runSelfCheck(log = console.log) {
  const failures = []
  const ok = (cond, msg) => {
    log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`)
    if (!cond) failures.push(msg)
  }
  const t0 = Date.now()
  log('Loading the real source through jiti (no Electron)...')
  const src = await loadSource()
  log(`  loaded in ${Date.now() - t0} ms`)
  const { z } = await import('zod')
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  ok(typeof sdk.query === 'function' && typeof sdk.tool === 'function' && typeof sdk.createSdkMcpServer === 'function', 'the Agent SDK exports query, tool and createSdkMcpServer')
  ok(JSON.stringify([...ALL_TOOLS]) === JSON.stringify([...src.types.TOOL_CATALOG]), 'score.mjs ALL_TOOLS mirrors TOOL_CATALOG in src/shared/types.ts')
  ok(src.setup.architectPrompt('code').length > 4000 && src.setup.architectPrompt('engagement').length > 4000, `architectPrompt code ${src.setup.architectPrompt('code').length} chars, engagement ${src.setup.architectPrompt('engagement').length} chars`)

  const dirs = []
  const mk = () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-bench-check-')))
    dirs.push(d)
    return d
  }
  try {
    const c1 = scenarioById('c1')
    const built = await buildCase(src, c1, mk())
    const names = built.tools.map((t) => t.name)
    log(`  setup tools: ${names.join(', ')}`)
    ok(['propose_architecture', 'propose_org_chart', 'ask_user', 'complete_setup'].every((n) => names.includes(n)), 'the setup tool set has the proposal, question and completion tools')
    for (const t of built.tools) {
      const schema = JSON.stringify(z.toJSONSchema(t.inputSchema))
      log(`    ${t.name}: description ${t.description.length} chars, schema ${schema.length} chars`)
    }
    ok(built.system.includes('Architect') && /propose_org_chart/.test(built.system), `real Architect system prompt via buildRolePrompt: ${built.system.length} chars`)
    ok(/Setup kind: new project/.test(built.firstMessage) && /Context from the harness/.test(built.firstMessage), `real first message (displayPrompt + hiddenContext via composeFirstMessage): ${built.firstMessage.length} chars`)

    // Recommend family: canned valid and invalid charts through the REAL propose_org_chart validation.
    const goodRoles = goodC1()
    let state = newState()
    let h = makeHandlers(built, c1, state)
    const good = await h.get('propose_org_chart')({ title: 'Chart', rationale: 'Small.', roles: goodRoles })
    ok(/^APPROVED/.test(good) && state.done === 'chart' && state.chart?.drafts.length === 2, `valid chart: ${good.slice(0, 60)}...`)
    ok(state.reviseRounds === 0, 'valid chart: no revise round')
    const scored = scoreChart({ family: 'recommend', status: 'ok', chart: state.chart, reviseRounds: 0 }, c1)
    ok(scored.total >= 90, `valid chart scores ${scored.total} on c1`)
    state = newState()
    h = makeHandlers(await buildCase(src, c1, mk()), c1, state)
    // An unresolved manager is a REVISE naming it (an unknown slug in first-time setup is just a new role).
    const bad = await h.get('propose_org_chart')({ title: 'Chart', rationale: 'Bad.', roles: [goodRoles[0], { ...goodRoles[1], reportsTo: 'no-such-manager' }] })
    ok(/^REVISE/.test(bad) && /no-such-manager/.test(bad) && state.done === null && state.reviseRounds === 1, `invalid chart (unresolved reportsTo): ${bad.slice(0, 80)}...`)
    state = newState()
    h = makeHandlers(await buildCase(src, c1, mk()), c1, state)
    const noRoles = await h.get('propose_org_chart')({ title: 'Chart', rationale: 'None.' })
    ok(/^REVISE/.test(noRoles), `invalid chart (no roles): ${noRoles.slice(0, 80)}...`)
    ok((await h.get('ask_user')({ question: 'q', options: [{ label: 'a' }, { label: 'b' }] })) === 'No preference, use your judgment.' && state.askUserCalls === 1, 'ask_user answers "no preference" and is counted')
    ok(/not available in this benchmark/.test(await h.get('propose_settings')({ title: 't' })) && state.otherToolCalls === 1, 'other setup tools answer "not available" and are counted')

    // Retro family: the chart is set up (state complete), so propose_org_chart is in revision mode.
    const r2 = scenarioById('r2')
    const rb = await buildCase(src, r2, mk())
    ok(rb.project.setup.state === 'complete' && rb.project.roles.length === 3, 'retro case: a complete 3-role project')
    ok(/Run record/.test(rb.firstMessage) && /Tester: Bash was denied|Bash was denied/.test(rb.firstMessage) && /this is a revision/.test(rb.firstMessage), `retro first message carries the run record and revision mode: ${rb.firstMessage.length} chars`)
    const tester = rb.project.roles.find((r) => r.slug === 'tester')
    const orch = rb.project.roles.find((r) => r.slug === 'orchestrator')
    const testerDraft = { slug: 'tester', name: tester.name, description: tester.description, responsibilities: tester.responsibilities, prompt: tester.prompt, tools: [...tester.tools, 'Bash'], canSpawn: false, spawnable: [], reportsTo: orch.name }
    state = newState()
    h = makeHandlers(rb, r2, state)
    const fixed = await h.get('propose_org_chart')({ title: 'Give the tester Bash', rationale: 'It was denied Bash 7 times.', roles: [testerDraft] })
    ok(/^APPROVED/.test(fixed) && state.done === 'propose' && state.revision?.listed === 1 && state.revision.after.length === 3, `valid revision: ${fixed.slice(0, 60)}...`)
    const rs = scoreRevision({ family: 'retro', status: 'ok', revision: state.revision, reviseRounds: 0 }, r2)
    ok(rs.total >= 95, `valid revision scores ${rs.total} on r2 (${rs.metrics.changed.join(', ')})`)
    // The same fix as a patch: only the slug and the changed field; everything else is kept from the current role.
    state = newState()
    h = makeHandlers(await buildCase(src, r2, mk()), r2, state)
    const patched = await h.get('propose_org_chart')({ title: 'Give the tester Bash', rationale: 'It was denied Bash 7 times.', roles: [{ slug: 'tester', tools: [...tester.tools, 'Bash'] }] })
    const ps = scoreRevision({ family: 'retro', status: 'ok', revision: state.revision, reviseRounds: 0 }, r2)
    ok(/^APPROVED/.test(patched) && state.revision?.after.length === 3 && ps.total >= 95, `patch revision (slug + tools only): ${patched.slice(0, 40)}... scores ${ps.total} (${ps.metrics.changed.join(', ')})`)
    state = newState()
    h = makeHandlers(await buildCase(src, r2, mk()), r2, state)
    const badRev =await h.get('propose_org_chart')({ title: 'Remove', rationale: 'x', roles: [testerDraft], remove: ['no-such-role'] })
    ok(/^REVISE/.test(badRev) && state.reviseRounds === 1, `invalid revision (remove names an unknown slug): ${badRev.slice(0, 80)}...`)
    state = newState()
    h = makeHandlers(await buildCase(src, scenarioById('r5'), mk()), scenarioById('r5'), state)
    const done = await h.get('complete_setup')({ summary: 'The run was healthy; nothing to change.' })
    ok(/^Setup is marked complete/.test(done) && state.done === 'noChange' && state.revision.ending === 'noChange', 'retro: complete_setup is a valid ending (real handler)')

    // Retro fixtures agree with their run records: every path the record names exists; `git: true` gives a repository with a commit.
    for (const s of RETRO_SCENARIOS) {
      const d = mk()
      const b = await buildCase(src, s, d)
      const missing = recordPaths(s).filter((p) => !existsSync(join(d, ...p.split('/'))))
      ok(missing.length === 0 && existsSync(join(d, '.orgai', 'ARCHITECTURE.md')), `${s.id}: fixture holds every path its record names${missing.length ? ` (missing ${missing.join(', ')})` : ''}`)
      const t = runFixtureTests(s, d)
      if (t.skipped) log(`  skip ${s.id}: fixture tests not executed (${t.note})`)
      else ok(t.ok, `${s.id}: the fixture's own tests run and pass in the prepared folder (${t.passed} passed, ${t.failed} failed, record claims ${t.expected})${t.ok ? '' : `\n${t.log}`}`)
      if (s.git) {
        const head = b.git?.ok ? spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: d, encoding: 'utf8' }) : null
        ok(head?.status === 0 && head.stdout.trim() === '1', `${s.id}: git fixture is a repository with one commit${b.git?.ok ? '' : ` (${b.git?.note})`}`)
      }
    }

    // Session driver against a scripted fake query (the real SDK is used only to build the in-process MCP server).
    const dir = mk()
    const sc = await buildCase(src, c1, dir)
    const rec = await runSession({
      built: sc, scenario: c1, repeat: 1, model: 'scripted', sdk, dir, timeoutMs: 20_000, graceMs: 2000,
      queryImpl: scriptedQuery([
        [{ text: 'Which Python version?' }],
        [{ tool: 'ask_user', args: { question: 'Tests?', options: [{ label: 'yes' }, { label: 'no' }] } }, { tool: 'propose_architecture', args: ARCH_ARGS }, { tool: 'propose_org_chart', args: { title: 'Chart', rationale: 'Small.', roles: goodC1() } }, { text: 'Proposed.' }]
      ])
    })
    ok(rec.status === 'ok' && rec.chart?.drafts.length === 2 && rec.questionTurns === 1 && rec.followUps === 1 && rec.askUserCalls === 1 && rec.architectureCalls === 1, `driver: answered one prose question, captured the chart (${rec.status}, ${rec.questionTurns} question turn, ${rec.turns} turns, $${rec.costUsd})`)
    ok(rec.costExact === true && rec.usage?.inputTokens > 0 && rec.sessionModel === 'scripted-model', 'driver: cost, usage and model recorded from the result message')
    const giveUp = await runSession({
      built: await buildCase(src, c1, mk()), scenario: c1, repeat: 1, model: 'scripted', sdk, dir, timeoutMs: 20_000,
      queryImpl: scriptedQuery([[{ text: 'Q1?' }], [{ text: 'Q2?' }], [{ text: 'Q3?' }], [{ text: 'never reached' }]])
    })
    ok(giveUp.status === 'noChart' && giveUp.followUps === 2 && giveUp.questionTurns === 3 && giveUp.chart === null, 'driver: after two follow-ups without a chart the session ends as noChart')
    ok(scoreChart(giveUp, c1).total === 0, 'driver: a noChart session scores 0')
    const retroRec = await runSession({
      built: await buildCase(src, scenarioById('r5'), mk()), scenario: scenarioById('r5'), repeat: 1, model: 'scripted', sdk, dir, timeoutMs: 20_000,
      queryImpl: scriptedQuery([[{ tool: 'complete_setup', args: { summary: 'Healthy run; no change.' } }, { text: 'Done.' }]])
    })
    ok(retroRec.status === 'ok' && retroRec.revision?.ending === 'noChange', 'driver: retro session ends on complete_setup')
    ok(scoreRevision(retroRec, scenarioById('r5')).total === 100, 'driver: a healthy chart left alone scores 100 on r5')
  } finally {
    for (const d of dirs) cleanupDir(d, { tries: 3, delayMs: 200 })
  }
  log(failures.length ? `\nself-check FAILED (${failures.length}): ${failures.join('; ')}` : `\nself-check OK (${Date.now() - t0} ms): no model call, no network.`)
  return failures.length ? 1 : 0
}
