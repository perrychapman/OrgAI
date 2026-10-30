import { exec } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

/**
 * Where the Claude Code CLI usually lives on macOS and Linux when it is not on the PATH a GUI app inherits:
 * the native installer (~/.claude/local, ~/.local/bin) and Homebrew (Apple silicon, Intel). Existing files only.
 */
export function claudeCandidatePaths(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  exists: (p: string) => boolean = existsSync
): string[] {
  if (platform === 'win32') return []
  const paths = [join(home, '.claude', 'local', 'claude'), join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
  return paths.filter((p) => {
    try {
      return exists(p)
    } catch {
      return false
    }
  })
}

/**
 * Drop entries that resolve to a file already listed (Homebrew's /opt/homebrew/bin/claude symlink and its Cellar
 * target, ~/.local/bin/claude and ~/.claude/local/claude). The first spelling wins; unresolvable paths stay as given.
 */
export function dedupeByRealpath(paths: string[], realpath: (p: string) => string = (p) => realpathSync.native(p)): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    let key = p
    try {
      key = realpath(p)
    } catch {
      /* not a file path (bare "claude") or gone: compare as given */
    }
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

export function listClaudeBinaries(): Promise<string[]> {
  const cmd = process.platform === 'win32' ? 'where claude' : 'which -a claude'
  return new Promise((resolve) => {
    // Pass process.env explicitly (exec's default too): on macOS applyShellPath has already merged the login shell's
    // PATH into it, which is what lets a Finder-launched app see Homebrew, nvm and ~/.local/bin.
    exec(cmd, { timeout: 8000, windowsHide: true, env: process.env }, (err, stdout) => {
      const found = err ? [] : stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      const all = dedupeByRealpath([...new Set([...found, ...claudeCandidatePaths()])])
      resolve(all.length ? all : ['claude'])
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
