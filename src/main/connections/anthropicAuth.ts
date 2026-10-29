import { exec } from 'node:child_process'
import type { ConnectionStatus, ProviderAuth } from '@shared/types'

export type ClaudeAuthStatus = { loggedIn: boolean; method?: string; detail?: string }

/**
 * Ask the installed Claude Code CLI whether it is logged in. Token-free (`claude auth status`).
 * Several `claude` launchers can sit on the PATH (shims, old installs), so every candidate is
 * tried in PATH order and the first one that answers wins.
 */
export async function claudeAuthStatus(): Promise<ClaudeAuthStatus> {
  const candidates = await listClaudeBinaries()
  for (const bin of candidates) {
    const result = await runAuthStatus(bin)
    if (result) return result
  }
  return { loggedIn: false, detail: 'Claude Code CLI not found or not logged in' }
}

/** Live status of the Anthropic connection. apiKey: the env var must be set; subscription: the CLI login. */
export async function anthropicStatus(auth: ProviderAuth, env: NodeJS.ProcessEnv = process.env): Promise<ConnectionStatus> {
  const checkedAt = Date.now()
  if (auth.kind === 'apiKey') {
    const set = !!env[auth.envVar]?.trim()
    return set
      ? { state: 'connected', detail: `Using ${auth.envVar}`, checkedAt }
      : { state: 'disconnected', detail: `${auth.envVar} is not set in OrgAI's environment`, checkedAt }
  }
  const s = await claudeAuthStatus()
  return s.loggedIn
    ? { state: 'connected', detail: s.method ? `Claude Code login (${s.method})` : 'Claude Code login', checkedAt }
    : { state: 'disconnected', detail: s.detail ?? 'Not logged in to Claude Code', checkedAt }
}

export function listClaudeBinaries(): Promise<string[]> {
  const cmd = process.platform === 'win32' ? 'where claude' : 'which -a claude'
  return new Promise((resolve) => {
    exec(cmd, { timeout: 8000, windowsHide: true }, (err, stdout) => {
      const found = err ? [] : stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      resolve(found.length ? [...new Set(found)] : ['claude'])
    })
  })
}

export function runAuthStatus(bin: string): Promise<ClaudeAuthStatus | null> {
  const quoted = /\s/.test(bin) ? `"${bin}"` : bin
  return new Promise((resolve) => {
    exec(`${quoted} auth status`, { timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (err && !stdout.trim()) {
        resolve(null)
        return
      }
      try {
        const parsed = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string }
        resolve({ loggedIn: !!parsed.loggedIn, method: parsed.authMethod, detail: parsed.apiProvider })
      } catch {
        if (/logged in|not logged in/i.test(stdout)) resolve({ loggedIn: !/not logged in/i.test(stdout), detail: stdout.trim().slice(0, 120) })
        else resolve(null)
      }
    })
  })
}
