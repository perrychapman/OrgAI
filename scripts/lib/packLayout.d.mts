export interface UnpackedLayout {
  dir: string
  marker: string
}
export interface PackagedPaths {
  unpackedDir: string
  resourcesDir: string
  launcher: string
  cliBundleDir: string
  appBinary: string
}
export function unpackedLayout(platform: string, arch: string): UnpackedLayout
export function packagedPaths(platform: string, arch: string, releaseDir: string): PackagedPaths
export function isNodeBuiltin(name: string): boolean
export function packageOf(specifier: string): string | undefined
export function bareImports(sourceText: string): string[]
