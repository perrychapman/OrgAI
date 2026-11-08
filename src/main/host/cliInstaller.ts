/**
 * Install the orgai command from the app (docs/design/cli-standalone-default.md 5.3). Main process only.
 *
 * Status reads file metadata (orgaiOnPath.ts) and never runs a PATH candidate. Install runs one fixed command:
 * the absolute npm found on the login PATH, `install -g orgai-cli@<tag> --ignore-scripts`, cwd = home, environment =
 * the login environment without ORGAI_*, ANTHROPIC_*, OPENAI_*, CLAUDE_*, CODEX_*, AWS_*, GOOGLE_* and AZURE_*. On
 * Windows npm.cmd runs through `cmd.exe /d /s /c` with a fixed, quoted command line. Never elevated. No electron
 * import: index.ts passes the facts in.
 */
import * as nodeFs from 'node:fs'
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { posix, win32 } from 'node:path'
import type { CliCommandResult, CliCommandStatus } from '../../shared/types'
import { log as appLog } from '../log'
import { findOrgaiOnPath, isNetworkPathFor, type FindOrgaiOptions, type OrgaiOnPathEntry } from './orgaiOnPath'
import type { OldShimService } from './shimInstaller'

export const OUTPUT_MAX_LINES = 200
export const OUTPUT_MAX_BYTES = 64 * 1024
/** An install that runs longer than this is stopped. */
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000
const SCRUBBED_ENV = /^(ORGAI|ANTHROPIC|OPENAI|CLAUDE|CODEX|AWS|GOOGLE|AZURE)_/i

/** `latest` for a stable app version, `next` for a prerelease (release.yml tags prereleases `next`). */
export function installTag(appVersion: string): 'latest' | 'next' {
  return /^\d+\.\d+\.\d+$/.test(appVersion.trim().replace(/^v/, '').replace(/\+.*$/, '')) ? 'latest' : 'next'
}

/** The command shown by the row and put on the clipboard. */
export function installCommandText(tag: string): string {
  return `npm install -g orgai-cli@${tag}`
}

/** The environment npm gets: the login environment minus the variables of OrgAI and of the model providers. */
export function scrubEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' || SCRUBBED_ENV.test(k)) continue
    out[k] = v
  }
  return out
}

export interface NpmFs {
  stat: (path: string) => { isFile(): boolean; mode?: number }
}

/**
 * An absolute npm from `pathList`, first hit in PATH order: `npm` on POSIX, `npm.cmd` on Windows. Relative entries,
 * network folders and a path that cmd.exe would reinterpret (quotes, percent signs, line breaks on Windows) are skipped.
 */
export function resolveNpm(platform: NodeJS.Platform | string, pathList: string | undefined, fs: NpmFs = { stat: (p) => nodeFs.statSync(p) }): string | undefined {
  if (!pathList) return undefined
  const p = platform === 'win32' ? win32 : posix
  const name = platform === 'win32' ? 'npm.cmd' : 'npm'
  for (const raw of pathList.split(platform === 'win32' ? ';' : ':').slice(0, 256)) {
    let dir = raw.trim()
    if (platform === 'win32' && dir.length >= 2 && dir.startsWith('"') && dir.endsWith('"')) dir = dir.slice(1, -1)
    if (!dir || !p.isAbsolute(dir) || isNetworkPathFor(platform, dir)) continue
    const file = p.join(dir, name)
    if (platform === 'win32' && /["%\r\n\0]/.test(file)) continue
    try {
      const st = fs.stat(file)
      if (!st.isFile()) continue
      if (platform !== 'win32' && typeof st.mode === 'number' && (st.mode & 0o111) === 0) continue
      return file
    } catch {
      /* not here */
    }
  }
  return undefined
}

export interface NpmCommand {
  file: string
  args: string[]
  /** true on Windows: args hold one prebuilt command line that Node must not re-quote. */
  verbatim: boolean
}

/** %SystemRoot%\System32\<name> as an absolute path; SystemRoot must be a local absolute folder, else C:\Windows. */
export function systemExe(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? ''
  const ok = win32.isAbsolute(root) && !isNetworkPathFor('win32', root) && !/["%\r\n\0]/.test(root)
  return win32.join(ok ? root : 'C:\\Windows', 'System32', name)
}

/** The fixed command. Nothing but the npm path (checked by resolveNpm) and the tag (latest or next) is in it. */
export function buildNpmCommand(platform: NodeJS.Platform | string, npmPath: string, tag: 'latest' | 'next', comspec?: string, systemRoot?: Readonly<Record<string, string | undefined>>): NpmCommand {
  const fixed = ['install', '-g', `orgai-cli@${tag}`, '--ignore-scripts']
  if (platform !== 'win32') return { file: npmPath, args: fixed, verbatim: false }
  // cmd /s /c strips the outer quote pair, so the whole line is wrapped once more.
  return { file: comspec && win32.isAbsolute(comspec) && !isNetworkPathFor('win32', comspec) ? comspec : systemExe(systemRoot ?? {}, 'cmd.exe'), args: ['/d', '/s', '/c', `""${npmPath}" ${fixed.join(' ')}"`], verbatim: true }
}

/** Removes control characters (ANSI escapes included); a carriage return ends a line; tabs become a space. */
export function cleanOutput(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
}

/** Keeps the tail of npm's output: at most OUTPUT_MAX_LINES lines and OUTPUT_MAX_BYTES bytes. */
export class OutputTail {
  private text = ''
  push(chunk: string): void {
    this.text += cleanOutput(chunk)
    // Bound the working text so a flood cannot grow memory.
    if (this.text.length > OUTPUT_MAX_BYTES * 4) this.text = this.text.slice(-OUTPUT_MAX_BYTES * 2)
  }
  value(): string {
    let lines = this.text.replace(/\n+$/, '').split('\n')
    if (lines.length > OUTPUT_MAX_LINES) lines = lines.slice(-OUTPUT_MAX_LINES)
    let out = lines.join('\n')
    if (Buffer.byteLength(out) > OUTPUT_MAX_BYTES) {
      let buf = Buffer.from(out).subarray(-OUTPUT_MAX_BYTES)
      // Do not start in the middle of a UTF-8 sequence.
      let i = 0
      while (i < buf.length && i < 4 && (buf[i] & 0xc0) === 0x80) i++
      buf = buf.subarray(i)
      out = buf.toString('utf8')
    }
    return out.trim()
  }
}

/** The `--prefix` advice for a permission failure. */
export function prefixHint(platform: NodeJS.Platform | string, tag: string, oldShim = false): string {
  const removeFirst = oldShim ? ' Remove the old orgai command first (the button in this row), or npm will refuse to write over it.' : ''
  return platform === 'win32'
    ? `npm could not write to its global folder. Run \`npm install -g orgai-cli@${tag} --prefix "%USERPROFILE%\\.npm-global"\` in a terminal, then add that folder to your Path.${removeFirst}`
    : `npm could not write to its global folder. Run \`npm install -g orgai-cli@${tag} --prefix ~/.local\` in a terminal (and put ~/.local/bin on your PATH), or fix the permissions of npm's global folder. OrgAI never asks for administrator rights.${removeFirst}`
}

export interface SpawnOptionsLike {
  cwd: string
  env: Record<string, string>
  windowsHide: boolean
  windowsVerbatimArguments: boolean
  stdio: ['ignore', 'pipe', 'pipe']
}
export type SpawnLike = (file: string, args: string[], opts: SpawnOptionsLike) => ChildProcess

export interface CliInstallDeps {
  platform: NodeJS.Platform
  home: string
  /** The resolved login environment (process.env after applyShellPath on POSIX). */
  env: NodeJS.ProcessEnv
  /** The login shell PATH used to classify `orgai` (as the user's terminal sees it). Undefined or empty = env.PATH. */
  loginPath?: string
  /** app.getVersion() */
  appVersion: string
  oldShim: OldShimService
  fs?: NpmFs
  findOnPath?: (opts: FindOrgaiOptions) => OrgaiOnPathEntry[]
  spawn?: SpawnLike
  timeoutMs?: number
  log?: { info: (m: string) => void; warn: (m: string) => void }
}

export interface CliInstallService {
  status(): CliCommandStatus
  install(): Promise<CliCommandResult>
  /** Stops the running install; true when one was running. */
  cancel(): boolean
  removeOldShim(): Promise<CliCommandResult>
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function createCliInstallService(deps: CliInstallDeps): CliInstallService {
  const log = deps.log ?? appLog
  const { platform } = deps
  const tag = installTag(deps.appVersion)
  const command = installCommandText(tag)
  const spawn: SpawnLike = deps.spawn ?? ((f, a, o) => nodeSpawn(f, a, o))
  const envPath = (): string | undefined => deps.env.PATH ?? deps.env.Path
  // The login shell's PATH; when it is unknown (empty), the process PATH, which holds the login additions already.
  const loginPath = (): string | undefined => (deps.loginPath ? deps.loginPath : envPath())
  const npmPath = (): string | undefined => resolveNpm(platform, envPath(), deps.fs)
  let running: { child: ChildProcess; cancelled: boolean } | undefined

  function oldShimNow(): boolean {
    try {
      return deps.oldShim.inspect() === 'ours'
    } catch {
      return false
    }
  }

  function status(): CliCommandStatus {
    let first: OrgaiOnPathEntry | undefined
    const list = loginPath()
    if (list) {
      try {
        first = (deps.findOnPath ?? findOrgaiOnPath)({ platform, pathList: list, env: deps.env, home: deps.home })[0]
      } catch (e) {
        log.warn(`orgai command: reading PATH failed: ${errorText(e)}`)
      }
    }
    const oldShim = oldShimNow()
    let state: CliCommandStatus['state'] = 'not-installed'
    if (first) state = first.kind === 'npm' ? 'npm' : first.kind === 'app-shim' || first.kind === 'app-launcher' ? 'old-shim' : 'other'
    else if (oldShim) state = 'old-shim'
    return {
      state,
      ...(first ? { path: first.path } : {}),
      ...(state === 'npm' && first?.version ? { version: first.version } : {}),
      oldShim,
      npmFound: npmPath() !== undefined,
      tag,
      command,
      installing: running !== undefined
    }
  }

  function killTree(child: ChildProcess): void {
    try {
      if (platform === 'win32' && child.pid) {
        const killer = spawn(systemExe(deps.env, 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { cwd: deps.home, env: scrubEnv(deps.env), windowsHide: true, windowsVerbatimArguments: false, stdio: ['ignore', 'pipe', 'pipe'] })
        // A spawn failure must not become an uncaught exception.
        killer.on?.('error', (e) => log.warn(`orgai command: taskkill failed: ${errorText(e)}`))
      } else {
        child.kill('SIGTERM')
        const t = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* gone */
          }
        }, 3000)
        t.unref?.()
      }
    } catch {
      /* already gone */
    }
  }

  async function install(): Promise<CliCommandResult> {
    if (running) return { ok: false, message: 'An install is already running.', status: status() }
    const npm = npmPath()
    if (!npm) {
      return {
        ok: false,
        message: `OrgAI could not find npm on your PATH. Install Node.js from nodejs.org, or run ${command} in a terminal.`,
        status: status()
      }
    }
    const cmd = buildNpmCommand(platform, npm, tag, deps.env.ComSpec ?? deps.env.COMSPEC, deps.env)
    const out = new OutputTail()
    log.info(`orgai command: running ${command} with ${npm}`)
    return await new Promise<CliCommandResult>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let cancelled = false
      let timedOut = false
      const finish = (r: { ok: boolean; message: string; hint?: string }): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        running = undefined
        const output = out.value()
        resolve({ ...r, ...(cancelled ? { cancelled: true } : {}), ...(output ? { output } : {}), status: status() })
      }
      let child: ChildProcess
      try {
        child = spawn(cmd.file, cmd.args, { cwd: deps.home, env: scrubEnv(deps.env), windowsHide: true, windowsVerbatimArguments: cmd.verbatim, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (e) {
        resolve({ ok: false, message: `OrgAI could not start npm: ${errorText(e)}`, status: status() })
        return
      }
      const mine = { child, cancelled: false }
      running = mine
      child.stdout?.on('data', (d: Buffer | string) => out.push(String(d)))
      child.stderr?.on('data', (d: Buffer | string) => out.push(String(d)))
      const limit = deps.timeoutMs ?? INSTALL_TIMEOUT_MS
      timer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, limit)
      child.on('error', (e) => finish({ ok: false, message: `OrgAI could not start npm: ${errorText(e)}` }))
      child.on('close', (code) => {
        cancelled = mine.cancelled
        if (cancelled) return finish({ ok: false, message: 'Install cancelled.' })
        if (timedOut) return finish({ ok: false, message: `npm did not finish within ${limit % 60000 === 0 ? `${limit / 60000} minutes` : `${Math.round(limit / 1000)} seconds`}; OrgAI stopped it.` })
        if (code === 0) return finish({ ok: true, message: 'Installed orgai-cli. Open a new terminal and run orgai.' })
        const text = out.value()
        const denied = /EACCES|EPERM|permission denied/i.test(text)
        const last = text.split('\n').filter((l) => l.trim()).slice(-1)[0]
        finish({
          ok: false,
          message: denied ? `npm was not allowed to write to its global folder${last ? `: ${last}` : '.'}` : `npm failed${typeof code === 'number' ? ` (exit ${code})` : ''}${last ? `: ${last}` : '.'}`,
          ...(denied ? { hint: prefixHint(platform, tag, oldShimNow()) } : {})
        })
      })
    })
  }

  function cancel(): boolean {
    if (!running) return false
    running.cancelled = true
    killTree(running.child)
    return true
  }

  async function removeOldShim(): Promise<CliCommandResult> {
    const r = deps.oldShim.remove()
    return { ok: r.ok, message: r.message, status: status() }
  }

  return { status, install, cancel, removeOldShim }
}
