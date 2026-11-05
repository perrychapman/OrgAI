export interface LockEntry {
  version?: string
  resolved?: string
  integrity?: string
  optional?: boolean
  os?: string[]
  cpu?: string[]
  libc?: string[]
  link?: boolean
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  [key: string]: unknown
}
export interface Lockfile {
  lockfileVersion?: number
  packages: Record<string, LockEntry>
  [key: string]: unknown
}
export interface InstallInfoJson {
  channel: 'npm' | 'app' | 'archive'
  version: string
  commit?: string
}
export interface NpmPackageJson {
  name: string
  version: string
  description: string
  type: 'module'
  bin: Record<string, string>
  files: string[]
  engines: { node: string }
  license: string
  dependencies: Record<string, string>
  repository?: unknown
}
export interface TreeComparison {
  ok: boolean
  missing: string[]
  extra: string[]
  wrongVersion: { location: string; expected: string | undefined; installed: string }[]
  skipped: string[]
  otherPlatforms: string[]
}
export const NPM_PACKAGE_NAME: string
export const NPM_RUNTIME_PACKAGES: string[]
export const AGENT_SDK: string
export const NODE_FLOOR_22: string
export const NODE_FLOOR_24: string
export const NODE_ENGINES: string
export const INSTALL_SCRIPT_NAMES: string[]
export function installInfoFor(channel: string, version: string, commit?: string | null): InstallInfoJson
export function nameOfLocation(location: string): string
export function resolveLocation(packages: Record<string, LockEntry>, from: string, dep: string): string | undefined
export function pinnedVersions(lock: Lockfile, names: Iterable<string>): Record<string, string>
export function cliDependencyNames(sdkPackageJson: { peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> }, runtimePackages?: readonly string[]): string[]
export function dependencyClosure(lock: Lockfile, rootDeps: Iterable<string>): Map<string, { optional: boolean }>
export function npmPackageJson(input: { version: string; dependencies: Record<string, string>; repository?: unknown; license?: string; description?: string; shrinkwrap?: boolean }): NpmPackageJson
export function shrinkwrapFor(lock: Lockfile, pkg: NpmPackageJson): Lockfile & { name: string; version: string }
export function listAdmits(list: unknown, value: string): boolean
export function entryMatchesPlatform(entry: LockEntry | undefined, platform: string, arch: string): boolean
export function libcDecides(location: string, entry: LockEntry | undefined, platform: string): boolean
export function compareInstalledTree(shrinkwrap: Lockfile, installed: Map<string, string>, platform: string, arch: string): TreeComparison
export function compareTopLevel(dependencies: Record<string, string>, installed: Map<string, string>, platform: string, arch: string): { ok: boolean; problems: string[] }
export function claudeNativePackage(platform: string, arch: string): string
export function unlistedInstallScripts(
  manifests: Map<string, { name?: string; version?: string; scripts?: Record<string, string>; hasBindingGyp?: boolean }>,
  allowlist: Iterable<string>
): { location: string; name: string; version?: string; scripts: string[] }[]
export function globalLayout(platform: string, prefix: string, name?: string): { packageDir: string; binDir: string; bin: string }
export function tarballName(name: string, version: string): string
export function isPrerelease(version: string): boolean
export function readmeText(input: { version: string; nodeEngines?: string; shrinkwrap?: boolean }): string
