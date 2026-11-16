/**
 * Ctrl+G in the composer: edit the draft in $VISUAL / $EDITOR. The draft goes to a private temp file (a 0700 directory
 * made by mkdtemp, a 0600 file), the editor runs with the terminal handed over exactly like the pager (suspend before,
 * resume after, which also restores raw mode), and the file and its directory are removed afterwards whatever happens.
 * The editor word is split on whitespace only, never through a shell, a value with shell syntax is refused, and a bare
 * name is resolved through absolute PATH entries only (see pager.ts for why).
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { parsePagerEnv, whichOnPath } from './pager'
import { sanitizeTty } from './sanitizeTty'

export interface EditorDeps {
  env: NodeJS.ProcessEnv
  suspend(): void
  resume(): void
  spawn?: typeof import('node:child_process').spawn
  which?: (name: string, env: NodeJS.ProcessEnv) => string | null
  /** Where the private directory is made (tests). */
  tmp?: string
}

export type EditorResult = { status: 'edited'; text: string } | { status: 'cancelled' } | { status: 'no-editor' } | { status: 'failed'; message: string }

/** The editor to run: $VISUAL, then $EDITOR, else `vi` when it is on PATH. */
export function editorCommand(env: NodeJS.ProcessEnv, which: (name: string, env: NodeJS.ProcessEnv) => string | null = whichOnPath): { file: string; args: string[] } | null {
  for (const value of [env.VISUAL, env.EDITOR]) {
    const parsed = parsePagerEnv(value)
    if (!parsed) continue
    const file = isAbsolute(parsed.file) ? parsed.file : /[\\/]/.test(parsed.file) ? null : which(parsed.file, env)
    if (file) return { file, args: parsed.args }
  }
  const vi = which('vi', env)
  return vi ? { file: vi, args: [] } : null
}

export async function editInExternalEditor(draft: string, deps: EditorDeps): Promise<EditorResult> {
  const cmd = editorCommand(deps.env, deps.which ?? whichOnPath)
  if (!cmd) return { status: 'no-editor' }
  const spawn = deps.spawn ?? nodeSpawn
  let dir: string | undefined
  try {
    dir = mkdtempSync(join(deps.tmp ?? tmpdir(), 'orgai-edit-'))
    const path = join(dir, 'prompt.md')
    writeFileSync(path, draft, { mode: 0o600, flag: 'wx' })
    deps.suspend()
    let code: number | null
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        let child: ReturnType<typeof nodeSpawn>
        try {
          child = spawn(cmd.file, [...cmd.args, path], { stdio: 'inherit', shell: false, env: deps.env })
        } catch (e) {
          reject(e)
          return
        }
        child.once('error', reject)
        child.once('exit', (c) => resolve(c))
      })
    } finally {
      deps.resume()
    }
    // A non-zero exit (vim :cq) means "never mind": the draft stays as it was.
    if (code !== 0) return { status: 'cancelled' }
    const raw = readFileSync(path, 'utf8')
    const text = sanitizeTty(raw).replace(/\r\n?/g, '\n').replace(/\n$/, '')
    return { status: 'edited', text }
  } catch (e) {
    return { status: 'failed', message: e instanceof Error ? e.message : String(e) }
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Best effort: the directory is private and empty of anything but the draft.
      }
    }
  }
}
