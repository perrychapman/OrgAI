// CLI read-only commands and the "one orgai at a time" rule end to end (cli-standalone-default.md 4.2, 4.3). Run
// `npm run build` first. Mock adapter only: no tokens. No Electron: the CLI and the OrgAI desktop app share nothing, so
// this script never starts the app.
//
// 1. A project and one finished mock run, made by the CLI itself (`projects create`, `exec`): status, runs list, runs
//    show R1, projects list / show and doctor read the files: no host is started (no daemon.json) and stderr is quiet.
// 2. A second orgai: while a slow mock `exec` owns the data folder, the read-only commands answer from the files with
//    "orgai is running in another terminal; this is a saved snapshot." (status names its folder and pid, doctor names
//    the pid), and a command that needs a host (`connections list`, a second `exec`) is refused at once with exit 6
//    naming the first orgai's folder and pid. When the first one ends the folder is free again.
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

  // ---------- 2. A second orgai ----------
  const slow = startCli(['--output-format', 'stream-json', 'exec', '[mock:exec-slow] take your time'], { cwd: repo })
  let ownerPid
  try {
    await until('the first orgai to own the folder', () => fs.existsSync(DAEMON_JSON) && JSON.parse(fs.readFileSync(DAEMON_JSON, 'utf8')).state === 'ready', 60_000)
    const owner = JSON.parse(fs.readFileSync(DAEMON_JSON, 'utf8'))
    ownerPid = owner.pid
    check(owner.hostKind === 'inproc' && typeof owner.ownerCwd === 'string' && owner.ownerCwd.length > 0, 'daemon.json carries the owner pid and ownerCwd', JSON.stringify(owner))

    const snap = await cli(['--project', repo, 'runs', 'list'])
    check(snap.code === 0 && snap.err.includes('orgai is running in another terminal; this is a saved snapshot.'), 'runs list beside an owner: a saved snapshot', show(snap))
    const st = await cli(['--project', repo, 'status'])
    check(st.code === 0 && st.out.includes('Another orgai running: yes') && st.out.includes(`pid ${owner.pid}`), 'status names the other orgai (folder and pid)', show(st))
    const dr = await cli(['doctor'])
    check(dr.out.includes(`Another orgai is running (pid ${owner.pid}`), 'doctor names the other orgai', dr.out + dr.err)

    const began = Date.now()
    const refused = await cli(['--project', repo, 'connections', 'list'])
    check(refused.code === 6 && refused.err.includes(`pid ${owner.pid}`) && refused.err.includes('Use that one, or quit it first.'), 'a command that needs a host is refused with exit 6', show(refused))
    const refusedExec = await cli(['--project', repo, 'exec', 'hello'], { cwd: repo })
    check(refusedExec.code === 6, 'a second exec is refused with exit 6', show(refusedExec))
    check(Date.now() - began < 20_000, 'both refusals came at once (no waiting)', `${Date.now() - began} ms`)
    const noSocket = await cli(['--project', repo, 'runs', 'show', 'R1'])
    check(noSocket.code === 0, 'runs show works beside the owner', show(noSocket))
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
  const free = await cli(['--project', repo, 'connections', 'list'])
  check(free.code === 0, 'when the first orgai ends the folder is free again', show(free))

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
