import type { McpServerSpec } from '@shared/types'

const EXACT = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/

/** True only for an exact semver-like version. latest, ranges, ^, ~, * and empty are not pinned. */
export function isPinnedVersion(version: string | null | undefined): boolean {
  return !!version && EXACT.test(version.trim())
}

/** Split "name@1.2.3" / "@scope/name@1.2.3" / "name==1.2.3" into the version part, or null when there is none. */
function suffixVersion(arg: string): string | null {
  const eq = arg.indexOf('==')
  if (eq > 0) return arg.slice(eq + 2)
  const at = arg.lastIndexOf('@')
  if (at > 0) return arg.slice(at + 1)
  return null
}

/**
 * The exact version a stdio spec would run, or null when it is not pinned. The package argument's own suffix is
 * authoritative (so "pkg@latest" is unpinned even when the registry entry has a version). Without a package
 * argument the registry version is used. Remote servers have no package version: null.
 */
export function pinnedVersionOf(spec: McpServerSpec): string | null {
  if (spec.transport !== 'stdio') return null
  const pkg = (spec.args ?? []).find((a) => !a.startsWith('-'))
  if (pkg) {
    const v = suffixVersion(pkg)
    return v && isPinnedVersion(v) ? v.trim() : null
  }
  const reg = spec.registry?.version
  return isPinnedVersion(reg) ? (reg as string).trim() : null
}
