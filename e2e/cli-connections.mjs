// `orgai connections | models | usage | notes` end to end (cli-spec 6.3, Wave 5, W5-T3). Run `npm run build` first.
// Mock adapter only (ORGAI_MOCK=1): no tokens, no network, no provider CLI spawned. One long-lived host
// (`daemon start --host inproc --foreground`), an engagement seeded through cliLib's raw hostRpc.
//
// 1. connections list --output-format json: three connections, exactly one default, no key material.
// 2. connections set-default openai (not connected) exits 1 with the host's sentence.
// 3. models list (json) and models prices (text, per MTok).
// 4. One mock exec run ([mock:exec-plan] through --host daemon exec), then usage show (json, one run) and
//    usage csv --out (a header plus one row; a second --out without --force exits 1).
// 5. notes add / list / show / edit, a stale edit (a hostRpc save in between, the CLI edit with the old revision exits
//    1), remove; notes plan set / show and a stale plan set.
// Not driven: connections test / connect / login and usage refresh (they spawn `claude` or the Codex app-server).
import * as fs from 'node:fs'
import * as path from 'node:path'
import { check, finish, log, makeFixtureRepo, removeFixture } from './lib.mjs'
import { cli, hostRpc, json, requireBuild, seedProject, show, startDaemon, stopDaemon } from './cliLib.mjs'

requireBuild()
const NAME = 'cli-connections'
const repo = makeFixtureRepo('cli-connections')

try {
  await startDaemon({ cwd: repo })
  const eng = await seedProject(repo, { name: 'Acme review', kind: 'engagement' })
  check(eng?.kind === 'engagement', 'seeded an engagement project', JSON.stringify(eng).slice(0, 200))
  const d = ['--host', 'daemon']

  // 1. connections list
  const list = await cli([...d, 'connections', 'list', '--output-format', 'json'], { cwd: repo })
  const lj = json(list.out)
  check(list.code === 0 && lj?.schemaVersion === 1, 'connections list json exits 0', show(list))
  check(JSON.stringify(lj?.connections?.map((c) => c.id)) === '["anthropic","openai"]', 'built-in connections in order (no proxy on a fresh profile)', JSON.stringify(lj?.connections?.map((c) => c.id)))
  check(lj?.connections?.filter((c) => c.isDefault).length === 1, 'exactly one default connection')
  check(!/"(apiKey|key|keyHash|secret)"\s*:|sk-/i.test(list.out), 'no key material in the JSON')
  const text = await cli([...d, 'connections', 'list'], { cwd: repo })
  check(text.code === 0 && /Default \((Chosen|Automatic)\)/.test(text.out), 'connections list text shows the default marker', show(text))

  // 2. set-default to a disconnected connection
  const def = await cli([...d, 'connections', 'set-default', 'openai'], { cwd: repo })
  check(def.code === 1 && /OpenAI is (not connected|turned off)/.test(def.err), 'set-default openai exits 1 with the host sentence', show(def))

  // 3. models
  const models = await cli([...d, 'models', 'list', '--output-format', 'json'], { cwd: repo })
  const mj = json(models.out)
  check(models.code === 0 && Array.isArray(mj?.models) && mj.models.length > 0, 'models list json lists models', show(models))
  check(mj?.models?.every((m) => m.price === null || typeof m.price.inputPerToken === 'number'), 'every model price is a price or null (unknown)')
  const prices = await cli([...d, 'models', 'prices'], { cwd: repo })
  check(prices.code === 0 && prices.out.includes('USD per million tokens.'), 'models prices prints per-MTok rows', show(prices))

  // 4. usage after one mock exec run
  const exec = await cli([...d, 'exec', '--output-format', 'json', '[mock:exec-plan] write the summary'], { cwd: repo, timeoutMs: 120_000 })
  check(exec.code === 0, 'mock exec run completes', show(exec))
  const usage = await cli([...d, 'usage', 'show', '--output-format', 'json'], { cwd: repo })
  const uj = json(usage.out)
  check(usage.code === 0 && uj?.runs >= 1, 'usage show counts the run', show(usage))
  check(typeof uj?.totals?.cost === 'string' && uj.totals.cost !== '$0.00', 'usage totals cost is a figure or unknown, never a fake $0', uj?.totals?.cost)
  const usageText = await cli([...d, 'usage'], { cwd: repo })
  check(usageText.code === 0 && /Acme review: \d+ runs? all time/.test(usageText.out), 'usage (text) names the project and range', show(usageText))
  const csvPath = path.join(repo, '..', `usage-${process.pid}.csv`)
  fs.rmSync(csvPath, { force: true })
  const csv = await cli([...d, 'usage', 'csv', '--out', csvPath], { cwd: repo })
  const csvText = fs.existsSync(csvPath) ? fs.readFileSync(csvPath, 'utf8') : ''
  const csvLines = csvText.split(/\r?\n/).filter(Boolean)
  check(csv.code === 0 && /^﻿?project,client,/.test(csvText) && csvLines.length >= 2, 'usage csv --out writes a header and a row', `${show(csv)} ${csvText.slice(0, 200)}`)
  const again = await cli([...d, 'usage', 'csv', '--out', csvPath], { cwd: repo })
  check(again.code === 1 && again.err.includes('--force'), 'usage csv --out refuses to overwrite without --force', show(again))
  const forced = await cli([...d, 'usage', 'csv', '--out', csvPath, '--force'], { cwd: repo })
  check(forced.code === 0, 'usage csv --out --force replaces the file', show(forced))
  fs.rmSync(csvPath, { force: true })

  // 5. notes
  const add = await cli([...d, 'notes', 'add', '--title', 'Kickoff call', '--text', 'We met the sponsor.', '--output-format', 'json'], { cwd: repo })
  const note = json(add.out)?.note
  check(add.code === 0 && typeof note?.id === 'string', 'notes add', show(add))
  const nl = await cli([...d, 'notes', 'list'], { cwd: repo })
  check(nl.code === 0 && nl.out.includes('Kickoff call'), 'notes list shows it', show(nl))
  const ns = await cli([...d, 'notes', 'show', 'kickoff call'], { cwd: repo })
  check(ns.code === 0 && ns.out.includes('We met the sponsor.'), 'notes show by title', show(ns))
  const edit = await cli([...d, 'notes', 'edit', note.id, '--text', 'We met the sponsor and the CFO.', '--expected-updated-at', String(note.updatedAt), '--output-format', 'json'], { cwd: repo })
  const edited = json(edit.out)?.note
  check(edit.code === 0 && edited?.updatedAt >= note.updatedAt, 'notes edit with the current revision', show(edit))
  await new Promise((r) => setTimeout(r, 10))
  await hostRpc('projects:saveNote', [{ projectId: eng.id, noteId: note.id, title: 'Kickoff call', text: 'Changed in the app.' }])
  const stale = await cli([...d, 'notes', 'edit', note.id, '--text', 'Mine', '--expected-updated-at', String(edited.updatedAt)], { cwd: repo })
  check(stale.code === 1 && stale.err.includes('The note changed since you read it'), 'a stale notes edit exits 1', show(stale))
  const kept = await cli([...d, 'notes', 'show', note.id], { cwd: repo })
  check(kept.out.includes('Changed in the app.'), 'the stale edit saved nothing', show(kept))
  const rm = await cli([...d, 'notes', 'remove', note.id, '--yes'], { cwd: repo })
  check(rm.code === 0, 'notes remove --yes', show(rm))

  const planSet = await cli([...d, 'notes', 'plan', 'set', '--file', '-', '--output-format', 'json'], { cwd: repo, input: '# Engagement plan\nScope: billing.\n' })
  const plan = json(planSet.out)?.plan
  check(planSet.code === 0 && typeof plan?.updatedAt === 'number', 'notes plan set from stdin', show(planSet))
  const planShow = await cli([...d, 'notes', 'plan', 'show'], { cwd: repo })
  check(planShow.code === 0 && planShow.out.includes('Scope: billing.'), 'notes plan show', show(planShow))
  await new Promise((r) => setTimeout(r, 10))
  await hostRpc('projects:updateEngagementDocument', [{ projectId: eng.id, text: 'Their plan', expectedUpdatedAt: plan.updatedAt }])
  const planStale = await cli([...d, 'notes', 'plan', 'set', '--text', 'Mine', '--expected-updated-at', String(plan.updatedAt)], { cwd: repo })
  check(planStale.code === 1 && /changed since/.test(planStale.err), 'a stale notes plan set exits 1', show(planStale))

  // A code project has no notes.
  const codeDir = makeFixtureRepo('cli-connections-code')
  try {
    await seedProject(codeDir, { name: 'Code app' })
    const codeNotes = await cli([...d, 'notes', 'list'], { cwd: codeDir })
    check(codeNotes.code === 2 && codeNotes.err.includes('code project'), 'notes on a code project exits 2', show(codeNotes))
  } finally {
    removeFixture(codeDir)
  }
} catch (e) {
  check(false, 'no unexpected error', e?.stack ?? JSON.stringify(e))
} finally {
  log('stopping the daemon')
  await stopDaemon().catch(() => undefined)
  removeFixture(repo)
  finish(NAME)
}
