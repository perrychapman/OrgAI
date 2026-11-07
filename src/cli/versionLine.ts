/**
 * The `orgai --version` line (Wave 7, docs/design/cli-standalone.md 3.5): the CLI's version first (scripts and
 * verify-pack.mjs read the first word), then the install channel and commit from install.json:
 * `0.1.6 channel npm commit 1a2b3c4d5e6f`, `0.1.6-dev1 channel dev`. A malformed install.json reads as channel dev.
 * Pure.
 */
import type { InstallInfo } from '../shared/types'

export function versionLine(version: string, info: InstallInfo): string {
  const words = [version, 'channel', info.channel]
  if (info.commit) words.push('commit', info.commit)
  if (info.version && info.version !== version) words.push(`(install.json says ${info.version})`)
  return words.join(' ')
}
