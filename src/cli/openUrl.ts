/**
 * Open an http(s) URL in the user's browser from plain Node (the `--host inproc` host's openExternal: OAuth sign-ins,
 * device-code pages). Never through a shell; anything that is not http: or https: is refused.
 */
import { execFile as nodeExecFile } from 'node:child_process'

export type ExecFileFn = (file: string, args: string[], cb: (err: Error | null) => void) => unknown

/** The opener command for `platform`. */
export function openerArgv(url: string, platform: NodeJS.Platform): { file: string; args: string[] } {
  if (platform === 'darwin') return { file: 'open', args: [url] }
  if (platform === 'win32') return { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
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

export function openUrl(url: string, deps: { platform?: NodeJS.Platform; execFile?: ExecFileFn } = {}): Promise<void> {
  if (!isOpenableUrl(url)) return Promise.reject(new Error('Only http and https links can be opened.'))
  const { file, args } = openerArgv(url, deps.platform ?? process.platform)
  const run: ExecFileFn = deps.execFile ?? ((f, a, cb) => nodeExecFile(f, a, { shell: false, windowsHide: true }, (err) => cb(err)))
  return new Promise((resolve, reject) => {
    run(file, args, (err) => (err ? reject(new Error(`Could not open the link: ${err.message}`)) : resolve()))
  })
}
