/**
 * Open an http(s) URL in the user's browser from plain Node (the `--host inproc` host's openExternal: OAuth sign-ins,
 * device-code pages). Never through a shell; anything that is not http: or https: is refused. The opener runs from the
 * temp dir, and on Windows rundll32.exe by its absolute System32 path: a bare name is searched in the cwd first
 * (review H1; UNVERIFIED on Windows).
 */
import { execFile as nodeExecFile } from 'node:child_process'
import { neutralCwd, system32Path } from '../main/host/systemBinaries'

export type ExecFileFn = (file: string, args: string[], cb: (err: Error | null) => void) => unknown

/** The opener command for `platform`. */
export function openerArgv(url: string, platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>> = process.env): { file: string; args: string[] } {
  if (platform === 'darwin') return { file: 'open', args: [url] }
  if (platform === 'win32') return { file: system32Path('rundll32.exe', env), args: ['url.dll,FileProtocolHandler', url] }
  return { file: 'xdg-open', args: [url] }
}

/** True for an absolute http: or https: URL without whitespace or control characters. */
export function isOpenableUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(url)) return false
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function openUrl(
  url: string,
  deps: { platform?: NodeJS.Platform; execFile?: ExecFileFn; env?: Readonly<Record<string, string | undefined>> } = {}
): Promise<void> {
  if (!isOpenableUrl(url)) return Promise.reject(new Error('Only http and https links can be opened.'))
  const { file, args } = openerArgv(url, deps.platform ?? process.platform, deps.env ?? process.env)
  const run: ExecFileFn =
    deps.execFile ?? ((f, a, cb) => nodeExecFile(f, a, { shell: false, windowsHide: true, cwd: neutralCwd() }, (err) => cb(err)))
  return new Promise((resolve, reject) => {
    run(file, args, (err) => (err ? reject(new Error(`Could not open the link: ${err.message}`)) : resolve()))
  })
}
