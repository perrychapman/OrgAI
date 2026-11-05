/**
 * $PAGER for diffs and long text (cli-spec 5.2, W4-T2). The pager is spawned with `shell: false` and its words are
 * split on whitespace only: no quoting, no expansion, and a value with a shell metacharacter is refused (the default is
 * used instead), so neither $PAGER nor the text can make a shell run. The text goes to the pager's stdin through
 * sanitizeDiffForPager: agent escapes are stripped and only trusted SGR colour is re-added for `less -R`.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { sanitizeDiffForPager } from './sanitizeTty'

/** Characters a shell would read as syntax; a PAGER holding any of them is not used. Quotes are kept literally. */
const SHELL_META = /[|&;<>$`()\n\r]/

export interface PagerDeps {
  env: NodeJS.ProcessEnv
  suspend(): void
  resume(): void
  spawn?: typeof import('node:child_process').spawn
  /** Finds a program on PATH (tests replace it). */
  which?: (name: string, env: NodeJS.ProcessEnv) => string | null
}

/** The first executable called `name` on env.PATH, else null. Never runs anything. */
export function whichOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const path = env.PATH ?? env.Path ?? ''
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : ['']
  for (const dir of path.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    for (const ext of exts) {
      const cand = join(dir, name + ext)
      try {
        accessSync(cand, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
        return cand
      } catch {
        // next
      }
    }
  }
  return null
}

/** PAGER split into file + args without any shell parsing; null when it is unset, empty or holds shell syntax. */
export function parsePagerEnv(value: string | undefined): { file: string; args: string[] } | null {
  if (typeof value !== 'string') return null
  const words = value.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  if (SHELL_META.test(value)) return null
  return { file: words[0], args: words.slice(1) }
}

export function pagerCommand(env: NodeJS.ProcessEnv, which: (name: string, env: NodeJS.ProcessEnv) => string | null = whichOnPath): { file: string; args: string[] } | null {
  const fromEnv = parsePagerEnv(env.PAGER)
  if (fromEnv) return fromEnv
  if (which('less', env)) return { file: 'less', args: ['-R'] }
  if (which('more', env)) return { file: 'more', args: [] }
  return null
}

function isEpipe(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED'
}

export async function showInPager(text: string, deps: PagerDeps): Promise<'shown' | 'no-pager'> {
  const cmd = pagerCommand(deps.env, deps.which ?? whichOnPath)
  if (!cmd) return 'no-pager'
  const spawn = deps.spawn ?? nodeSpawn
  const body = sanitizeDiffForPager(text)
  deps.suspend()
  try {
    await new Promise<void>((resolve, reject) => {
      let child: ReturnType<typeof nodeSpawn>
      try {
        child = spawn(cmd.file, cmd.args, { stdio: ['pipe', 'inherit', 'inherit'], shell: false, env: deps.env })
      } catch (e) {
        reject(e)
        return
      }
      let settled = false
      const done = (err?: unknown): void => {
        if (settled) return
        settled = true
        if (err) reject(err)
        else resolve()
      }
      child.once('error', (e) => done(e))
      child.once('exit', () => done())
      const stdin = child.stdin
      if (stdin) {
        // The user may quit the pager before it has read everything: that is EPIPE, not a failure.
        stdin.on('error', (e) => {
          if (!isEpipe(e)) done(e)
        })
        try {
          stdin.end(body)
        } catch (e) {
          if (!isEpipe(e)) done(e)
        }
      }
    })
  } finally {
    deps.resume()
  }
  return 'shown'
}
