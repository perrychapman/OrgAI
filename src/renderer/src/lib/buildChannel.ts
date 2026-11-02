/** True when the version has a semver prerelease tag containing "dev" (0.1.5-dev, 0.1.5-dev.3). Build metadata is ignored. */
export function isDevBuild(version: string | null | undefined): boolean {
  if (!version) return false
  const m = /^v?\d+\.\d+\.\d+-([0-9A-Za-z.-]+)(?:\+.*)?$/.exec(version.trim())
  return m ? m[1].toLowerCase().includes('dev') : false
}

/** Tooltip and accessible label for the dev badge. */
export function devBuildLabel(version: string): string {
  return `Dev build ${version}`
}
