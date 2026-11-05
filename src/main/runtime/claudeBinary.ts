/**
 * The one Claude runtime resolver (Wave 7, docs/design/cli-standalone.md 6.1), used by claude.ts (runs) and
 * anthropicAuth.ts (the connection probe) so the two never disagree. Evaluated per call, never at import.
 *
 * Order: ORGAI_CLAUDE_PATH (must exist and be a regular file), the app.asar.unpacked native package, the SDK's
 * per-platform package through createRequire from the bundle, else none. When resolved, callers always pass
 * `pathToClaudeCodeExecutable`. A `claude` found on PATH is named in the error, never used silently.
 *
 * Contracts only: claudeExecutable is WP-C's; until then claude.ts and anthropicAuth.ts keep their own lookups and
 * nothing calls this. Electron-free; relative imports only.
 */

/** Where a resolved Claude executable came from. */
export type ClaudeExecutableSource = 'env' | 'app' | 'sdk'

export type ClaudeExecutableResolution =
  | { ok: true; path: string; source: ClaudeExecutableSource }
  | {
      ok: false
      /** The sentence runs and the probe both show (claudeRuntimeMissingMessage, or why ORGAI_CLAUDE_PATH was refused). */
      reason: string
      /** A `claude` on PATH that is not used ("a claude on PATH at <path> is not used; set ORGAI_CLAUDE_PATH to use it"). */
      pathCandidate?: string
    }

export interface ClaudeExecutableOptions {
  platform?: NodeJS.Platform
  arch?: string
  /** Where the CLI bundle (or main bundle) lives, for createRequire; default this module's folder. */
  bundleDir?: string
}

/** The variable that names a Claude executable explicitly. Not a secret: it stays in child environments. */
export const CLAUDE_PATH_ENV = 'ORGAI_CLAUDE_PATH'

/** No runtime for this platform (the SDK's optional native package is missing). */
export function claudeRuntimeMissingMessage(platform: string, arch: string): string {
  return `The Claude runtime for ${platform}-${arch} is not installed; reinstall orgai without --omit=optional, or set ${CLAUDE_PATH_ENV}.`
}

/** The Claude executable runs and the connection probe use. WP-C implements it (6.1). */
export function claudeExecutable(env: NodeJS.ProcessEnv = process.env, opts: ClaudeExecutableOptions = {}): ClaudeExecutableResolution {
  void env
  void opts
  throw new Error('claudeExecutable is not implemented yet (Wave 7 WP-C).')
}
