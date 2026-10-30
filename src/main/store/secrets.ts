import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { McpSecretKind } from '@shared/types'

/**
 * Encrypted secrets (the LiteLLM key, MCP server env vars and headers). Values are encrypted with Electron
 * safeStorage (DPAPI on Windows, Keychain on macOS, libsecret on Linux) and kept in secrets.json in the data
 * dir, never in settings.json or projects.json. Values never cross IPC and are never logged; callers ask
 * only for has-flags unless they are about to hand the value to a child process.
 */

/** The part of Electron's safeStorage this store uses; tests pass a fake. */
export interface SecretCipher {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** Key of the LiteLLM proxy key. */
export const LITELLM_KEY = 'connection:litellm:apiKey'

/** Prefix of every secret of one MCP server (remove them all when the server is removed). */
export function mcpSecretPrefix(projectId: string, serverId: string): string {
  return `mcp:${projectId}:${serverId}:`
}

/** Key of one MCP secret slot. */
export function mcpSecretKey(projectId: string, serverId: string, kind: McpSecretKind, name: string): string {
  return `${mcpSecretPrefix(projectId, serverId)}${kind}:${name}`
}

/** Prefix of every MCP secret of a project (remove them all when the project is removed). */
export function mcpProjectPrefix(projectId: string): string {
  return `mcp:${projectId}:`
}

/** The OAuth secret slots of one server: the client secret and the current tokens. */
export type McpOAuthSlot = 'clientSecret' | 'accessToken' | 'refreshToken'

/** Key of one OAuth secret of a project-only server (under mcpSecretPrefix, so removing the server removes it). */
export function mcpOAuthKey(projectId: string, serverId: string, slot: McpOAuthSlot): string {
  return `${mcpSecretPrefix(projectId, serverId)}oauth:${slot}`
}

/** Prefix of every secret of one library entry. Distinct from every project key ('mcplib:' never starts 'mcp:'). */
export function mcpLibraryPrefix(entryId: string): string {
  return `mcplib:${entryId}:`
}

/** Key of one env or header secret of a library entry. */
export function mcpLibrarySecretKey(entryId: string, kind: McpSecretKind, name: string): string {
  return `${mcpLibraryPrefix(entryId)}${kind}:${name}`
}

/** Key of one OAuth secret of a library entry. */
export function mcpLibraryOAuthKey(entryId: string, slot: McpOAuthSlot): string {
  return `${mcpLibraryPrefix(entryId)}oauth:${slot}`
}

/** Whose secrets: a project-only server or a library entry (linked project servers use their entry's). */
export type McpSecretOwner = { projectId: string; serverId: string } | { libraryId: string }

export function mcpOwnerPrefix(owner: McpSecretOwner): string {
  return 'libraryId' in owner ? mcpLibraryPrefix(owner.libraryId) : mcpSecretPrefix(owner.projectId, owner.serverId)
}

export function mcpOwnerSecretKey(owner: McpSecretOwner, kind: McpSecretKind, name: string): string {
  return `${mcpOwnerPrefix(owner)}${kind}:${name}`
}

export function mcpOwnerOAuthKey(owner: McpSecretOwner, slot: McpOAuthSlot): string {
  return `${mcpOwnerPrefix(owner)}oauth:${slot}`
}

export class SecretStore {
  private file: string
  /** key -> base64 ciphertext */
  private values: Record<string, string> = {}

  constructor(
    dataDir: string,
    private cipher: SecretCipher
  ) {
    this.file = join(dataDir, 'secrets.json')
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { secrets?: unknown }
      const raw = parsed.secrets
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') this.values[k] = v
      }
    } catch (e) {
      // Never print the file: it holds ciphertext only, but there is nothing useful in it for a log either.
      console.error('Failed to read secrets.json, starting empty:', (e as Error).message)
      this.values = {}
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, secrets: this.values }, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.file)
  }

  /** False when the OS offers no encryption (e.g. Linux without a keyring); set() then throws. */
  available(): boolean {
    try {
      return this.cipher.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  has(key: string): boolean {
    return Object.hasOwn(this.values, key)
  }

  /** The decrypted value, or undefined when none is stored or it cannot be decrypted (another user, a new OS keyring). */
  get(key: string): string | undefined {
    const v = this.values[key]
    if (v === undefined) return undefined
    try {
      return this.cipher.decryptString(Buffer.from(v, 'base64'))
    } catch {
      return undefined
    }
  }

  /** Store a value, or delete it with null or ''. Throws when encryption is unavailable (never stores plain text). */
  set(key: string, value: string | null): void {
    if (value === null || value === '') {
      this.delete(key)
      return
    }
    if (!this.available()) throw new Error('Secure storage is not available on this system, so OrgAI cannot store secrets.')
    this.values[key] = this.cipher.encryptString(value).toString('base64')
    this.persist()
  }

  delete(key: string): void {
    if (!this.has(key)) return
    delete this.values[key]
    this.persist()
  }

  /** Stored keys starting with a prefix. */
  keys(prefix = ''): string[] {
    return Object.keys(this.values).filter((k) => k.startsWith(prefix))
  }

  /** Delete every key starting with a prefix; returns how many were removed. */
  deletePrefix(prefix: string): number {
    const doomed = this.keys(prefix)
    if (!doomed.length) return 0
    for (const k of doomed) delete this.values[k]
    this.persist()
    return doomed.length
  }
}
