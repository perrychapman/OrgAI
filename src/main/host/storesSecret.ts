/**
 * Which host channels can store a secret value (docs/design/cli-standalone.md 5.6, Wave 7). Node and inproc hosts
 * create their vault lazily: `HostDispatcher.invokeRpc` awaits `SecretStore.prepareWrite()` before a handler runs
 * exactly when the channel's predicate is true, so handlers stay synchronous and a clear (or any call that stores
 * nothing) never creates a vault or a keychain item.
 *
 * A predicate sees the gated (validated, decoded) positional arguments and a read-only view of host state, and must be
 * true only when the call will store a non-empty value. registry.ts attaches these to the entries as `storesSecret`.
 *
 * invokeRpc already consults these (dispatcher.ts, inside the mutation lease; the view reads the project store, the
 * MCP library and SecretStore.keys / status). Contracts only: every predicate below is a stub answering false until
 * WP-H writes it, so behaviour is unchanged. Electron-free; imports shared types only.
 */
import type { McpLibraryEntry, Project, SecretStatus } from '../../shared/types'

/** Read-only host state a predicate may look at (never a secret value). */
export interface StoresSecretHostView {
  /** A stored project, or null. */
  project(projectId: string): Project | null
  /** A library entry, or undefined. */
  libraryEntry(entryId: string): McpLibraryEntry | undefined
  /** SecretStore.keys(prefix). */
  secretKeys(prefix?: string): string[]
  /** SecretStore.status(key): promote / copy carry only readable secrets (an unreadable source makes the handler refuse). */
  secretStatus(key: string): SecretStatus
}

/** True when this call will store a non-empty secret value. Pure: no side effects, never throws on odd input. */
export type StoresSecretFn = (args: readonly unknown[], host: StoresSecretHostView) => boolean

/** Stub: WP-H replaces each with the real predicate. */
const notYet: StoresSecretFn = () => false

/**
 * The channels the spec names (5.6). WP-H audits `secrets.set(` callers for any other channel that stores a value.
 * - connections:setSecret, connectors:setToken: a non-empty value.
 * - mcp:setSecret, mcpLibrary:setSecret: a non-empty value.
 * - setup:decide: approving an MCP proposal with non-empty `secrets`.
 * - mcp:answerInstall: approving with non-empty `secrets` and a scope other than 'run'.
 * - mcp:authorize: the input carries a client secret (stored before the browser opens).
 * - mcp:promote, mcp:copyFromLibrary: the source holds a readable secret (per-project values included, whatever
 *   copySecrets says).
 */
export const STORES_SECRET: Readonly<Record<string, StoresSecretFn>> = {
  'connections:setSecret': notYet,
  'connectors:setToken': notYet,
  'mcp:setSecret': notYet,
  'mcpLibrary:setSecret': notYet,
  'setup:decide': notYet,
  'mcp:answerInstall': notYet,
  'mcp:authorize': notYet,
  'mcp:promote': notYet,
  'mcp:copyFromLibrary': notYet
}
