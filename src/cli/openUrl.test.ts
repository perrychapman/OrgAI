import { describe, expect, it } from 'vitest'
import { openUrl, type ExecFileFn } from './openUrl'

function recorder(): { calls: [string, string[]][]; execFile: ExecFileFn } {
  const calls: [string, string[]][] = []
  return { calls, execFile: (f, a, cb) => (calls.push([f, a]), cb(null)) }
}

describe('openUrl', () => {
  it('uses the platform opener with the URL as one argument', async () => {
    const url = 'https://example.com/a?b=1&c=2'
    for (const [platform, expected] of [
      ['darwin', ['open', [url]]],
      ['linux', ['xdg-open', [url]]],
      ['win32', ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]]
    ] as const) {
      const r = recorder()
      await openUrl(url, { platform, execFile: r.execFile })
      expect(r.calls).toEqual([expected])
    }
  })

  it('refuses anything but http(s)', async () => {
    const r = recorder()
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ssh://x', 'not a url', 'https://x.com/\nrm', '']) {
      await expect(openUrl(bad, { platform: 'darwin', execFile: r.execFile })).rejects.toThrow(/Only http/)
    }
    expect(r.calls).toEqual([])
  })

  it('reports an opener failure', async () => {
    await expect(openUrl('http://localhost:1/', { platform: 'linux', execFile: (_f, _a, cb) => cb(new Error('ENOENT')) })).rejects.toThrow(/Could not open/)
  })
})
