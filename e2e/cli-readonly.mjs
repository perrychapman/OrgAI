// CLI read-only commands, and what a second orgai sees beside a running one (cli-standalone-default.md 4.3,
// docs/design/cli-sessions.md). Run `npm run build` first. Mock adapter only: no tokens. No Electron: the CLI and the
// OrgAI desktop app share nothing, so this script never starts the app. Two terminal UIs at once are cli-parallel.mjs.
//
// 1. A project and one finished mock run, made by the CLI itself (`projects create`, `exec`): status, runs list, runs
//    show R1, projects list / show and doctor read the files: no host is started (no daemon.json) and stderr is quiet.
// 2. A second orgai: while a slow mock `exec` runs in the project, the read-only commands answer from the files and
//    show its run as live with no "saved snapshot" note (status lists the session with its folder, pid and project,
//    doctor says the folder is shared). A command that needs a host (`connections list`) starts its own beside it. A
//    second `exec` in the same project is refused at once with exit 6 naming the first one's folder and pid. When the
//    first one ends the project is free again.
// 3. The removed commands (watch, inbox, decide, attach, daemon, app, terminal-access) and --host are usage errors.
import * as fs from 'node:fs'
import { check, finish, log, makeFixtureRepo, removeFixture } from './lib.mjs'
import { DAEMON_JSON, cli, json, requireBuild, seedProject, show, startCli, until } from './cliLib.mjs'

requireBuild()

const repo = makeFixtureRepo('cli-readonly')
try {
  // ---------- 1. Files only ----------
  const project = await seedProject(repo, { name: 'CLI readonly' })
  check(!!project?.id, 'a project made with projects create')
  const exec = await cli(['--output-format', 'json', 'exec', '--team', 'single', 'Hello from the CLI e2e'], { cwd: repo, timeoutMs: 120_000 })
  check(exec.code === 0 && json(exec.out)?.outcome === 'completed-unplanned', 'a finished mock run made by exec', show(exec))
  check(!fs.existsSync(DAEMON_JSON), 'no host is left behind after a command')

  const status = await cli(['--project', repo, 'status', '--output-format', 'json'])
  const sj = json(status.out)
  check(status.code === 0 && sj?.hostState === 'stopped' && sj?.liveInboxAvailable === false && sj?.project?.id === project.id, 'status reads the files: no other orgai, the project found', show(status))
  check(status.err === '', 'status is quiet when nobody else runs', status.err)
  const list = await cli(['runs', 'list', '--project', repo])
  check(list.code === 0 && /R1\s+(Finished|Stopped|Idle)/.test(list.out) && list.err === '', 'runs list shows R1', list.out + list.err)
  const showRun = await cli(['--project', repo, 'runs', 'show', 'R1'])
  check(showRun.code === 0 && showRun.out.includes('Hello from the CLI e2e'), 'runs show R1', showRun.out.slice(0, 400) + showRun.err)
  const projects = await cli(['projects', 'list', '--output-format', 'json'])
  check(projects.code === 0 && json(projects.out)?.projects?.some((p) => p.id === project.id), 'projects list reads the files', show(projects))
  const pshow = await cli(['projects', 'show', repo])
  check(pshow.code === 0 && /Subagent depth:/.test(pshow.out), 'projects show reads the files', show(pshow))
  const doctor = await cli(['doctor'])
  check(doctor.code === 0 && /product +.*marked orgai-cli/.test(doctor.out) && /No other orgai is running/.test(doctor.out), 'doctor: marker, no other orgai', doctor.out + doctor.err)
  check(!fs.existsSync(DAEMON_JSON), 'the read-only commands started no host')
  // outputs list reads through a host (outputs:list), so it runs after the files-only checks; the mock run made none.
  const outs = await cli(['--project', repo, 'outputs', 'list'])
  check(outs.code === 0 && /No outputs yet\.|ID\s+TITLE/.test(outs.out), 'outputs list answers (none for the mock run)', show(outs))
  const outsJson = await cli(['--project', repo, '--output-format', 'json', 'outputs', 'list'])
  check(outsJson.code === 0 && Array.isArray(json(outsJson.out)?.outputs), 'outputs list JSON has an outputs array', show(outsJson))
  check(!fs.existsSync(DAEMON_JSON), 'outputs list left no host behind')

  // ---------- 2. A second orgai ----------
  const slow = startCli(['--output-format', 'stream-json', 'exec', '[mock:exec-slow] take your time'], { cwd: repo })
  let ownerPid
  try {
    await until('the first orgai to own the folder', () => fs.existsSync(DAEMON_JSON) && JSON.parse(fs.readFileSync(DAEMON_JSON, 'utf8')).state === 'ready', 60_000)
    const owner = JSON.parse(fs.readFileSync(DAEMON_JSON, 'utf8'))
    ownerPid = owner.pid
    check(owner.hostKind === 'inproc' && typeof owner.ownerCwd === 'string' && owner.ownerCwd.length > 0, 'daemon.json carries the owner pid and ownerCwd', JSON.stringify(owner))

    check(owner.sessions === true, 'daemon.json says the folder is shared with other orgai sessions', JSON.stringify(owner))

    const snap = await cli(['--project', repo, 'runs', 'list'])
    check(snap.code === 0 && /R2\s+(Running|Idle|Needs you)/.test(snap.out), 'runs list beside a running orgai shows its run as live', show(snap))
    check(!snap.err.includes('saved snapshot'), 'and needs no "saved snapshot" note (the index names the session hosting the run)', show(snap))
    const st = await cli(['--project', repo, 'status'])
    check(st.code === 0 && st.out.includes('orgai sessions running: 1') && st.out.includes(`pid ${owner.pid}`) && st.out.includes('holds '), 'status lists the session (folder, pid and the project it holds)', show(st))
    const stJson = json((await cli(['--project', repo, '--output-format', 'json', 'status'])).out)
    check(stJson?.hostState === 'ready' && stJson.sessions?.length === 1 && stJson.sessions[0].pid === owner.pid && stJson.sessions[0].command === 'exec' && stJson.sessions[0].projects.includes(project.id), 'status JSON carries the session with its command and projects', JSON.stringify(stJson?.sessions))
    const dr = await cli(['doctor'])
    check(dr.out.includes(`orgai is running (pid ${owner.pid}`) && dr.out.includes('shares this folder'), 'doctor says the folder is shared', dr.out + dr.err)

    const began = Date.now()
    const beside = await cli(['--project', repo, 'connections', 'list'])
    check(beside.code === 0, 'a command that needs a host starts its own beside the running orgai', show(beside))
    const refusedExec = await cli(['--project', repo, 'exec', 'hello'], { cwd: repo })
    check(refusedExec.code === 6 && refusedExec.err.includes(`pid ${owner.pid}`) && refusedExec.err.includes('is open in another orgai session') && refusedExec.err.includes('Use that one, or quit it first.'), 'a second exec in the same project is refused with exit 6, naming where the project is open', show(refusedExec))
    check(Date.now() - began < 20_000, 'both answers came at once (no waiting)', `${Date.now() - began} ms`)
    const noSocket = await cli(['--project', repo, 'runs', 'show', 'R1'])
    check(noSocket.code === 0, 'runs show works beside the running orgai', show(noSocket))
    check(JSON.parse(fs.readFileSync(DAEMON_JSON, 'utf8')).pid === owner.pid, 'the running orgai is still the one daemon.json names after those commands')
  } finally {
    slow.child.kill('SIGINT')
    const t = setTimeout(() => slow.child.kill('SIGKILL'), 30_000)
    await slow.done
    clearTimeout(t)
  }
  if (process.platform === 'win32') {
    // kill('SIGINT') is TerminateProcess on Windows: no handler runs, so daemon.json stays behind with a dead pid and the
    // next orgai reclaims it. Wait for the owner process to be gone instead of the record.
    const alive = (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    await until('the first orgai to end', () => typeof ownerPid !== 'number' || !alive(ownerPid), 30_000)
  } else await until('the folder to be free again', () => !fs.existsSync(DAEMON_JSON), 30_000)
  const free = await cli(['--project', repo, 'exec', '--team', 'single', 'hello again'], { cwd: repo })
  check(free.code === 0, 'when the first orgai ends the project is free again', show(free))

  // ---------- 3. Removed commands ----------
  for (const argv of [['watch', 'R1'], ['inbox'], ['decide', 'x', 'allow'], ['attach', 'R1'], ['daemon', 'status'], ['app'], ['terminal-access'], ['--host', 'inproc', 'status']]) {
    const r = await cli(argv)
    check(r.code === 2, `\`orgai ${argv.join(' ')}\` is a usage error`, show(r))
  }
  for (const flag of ['--on-permission', '--on-rules', '--on-mcp-install', '--on-question', '--on-proposal', '--on-merge']) {
    const r = await cli(['exec', flag, 'wait', 'x'], { cwd: repo })
    check(r.code === 2 && /wait is not available/.test(r.err), `exec ${flag} wait is refused (exit 2)`, show(r))
  }
} catch (e) {
  check(false, 'cli-readonly ran to the end', e instanceof Error ? e.stack : String(e))
} finally {
  removeFixture(repo)
  log('done')
}
finish('cli-readonly')
