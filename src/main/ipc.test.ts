import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: { handle: vi.fn() },
  shell: {}
}))

import { assertTrustedIpcSender, externalUrl, isTrustedRendererUrl, trustedRenderer } from './ipc'

describe('renderer trust boundary', () => {
  it('trusts only the packaged renderer document', () => {
    const trusted = trustedRenderer('file:///Applications/OrgAI.app/renderer/index.html')
    expect(isTrustedRendererUrl('file:///Applications/OrgAI.app/renderer/index.html#run', trusted)).toBe(true)
    expect(isTrustedRendererUrl('file:///Applications/OrgAI.app/renderer/other.html', trusted)).toBe(false)
    expect(isTrustedRendererUrl('https://example.com/', trusted)).toBe(false)
  })

  it('trusts only the configured development origin', () => {
    const trusted = trustedRenderer('http://127.0.0.1:5173/')
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/settings', trusted)).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5173/', trusted)).toBe(false)
    expect(isTrustedRendererUrl('https://127.0.0.1:5173/', trusted)).toBe(false)
    expect(isTrustedRendererUrl('http://user:pass@127.0.0.1:5173/', trusted)).toBe(false)
  })

  it('rejects subframes and untrusted main frames for IPC', () => {
    const trusted = trustedRenderer('https://orgai.test/')
    const main = { url: 'https://orgai.test/' }
    expect(() => assertTrustedIpcSender({ senderFrame: main, sender: { mainFrame: main } } as never, trusted)).not.toThrow()
    expect(() => assertTrustedIpcSender({ senderFrame: null, sender: { mainFrame: main } } as never, trusted)).toThrow('untrusted renderer')
    expect(() => assertTrustedIpcSender({ senderFrame: { url: main.url }, sender: { mainFrame: main } } as never, trusted)).toThrow('untrusted renderer')
    const remote = { url: 'https://attacker.test/' }
    expect(() => assertTrustedIpcSender({ senderFrame: remote, sender: { mainFrame: remote } } as never, trusted)).toThrow('untrusted renderer')
  })
})

describe('externalUrl', () => {
  it('allows absolute web URLs without credentials', () => {
    expect(externalUrl('https://example.com/login?q=1')).toBe('https://example.com/login?q=1')
    expect(externalUrl('http://127.0.0.1:8080/callback')).toBe('http://127.0.0.1:8080/callback')
  })

  it('rejects local, relative, credentialed and custom-protocol URLs', () => {
    for (const url of ['/relative', 'file:///tmp/x', 'mailto:user@example.com', 'vscode://open', 'https://user:pass@example.com/']) {
      expect(externalUrl(url), url).toBeNull()
    }
  })
})
