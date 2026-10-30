/** Pure platform helpers for the renderer. No IPC: derived from the navigator platform string. */
export function isMacPlatform(platform: string): boolean {
  return /^mac/i.test(platform)
}

export function modKeyLabel(platform: string): 'Cmd' | 'Ctrl' {
  return isMacPlatform(platform) ? 'Cmd' : 'Ctrl'
}

export function currentPlatform(): string {
  return typeof navigator === 'undefined' ? '' : navigator.platform || ''
}

/** Example folder path for input placeholders. */
export function examplePath(name: string, platform: string = currentPlatform()): string {
  return /^win/i.test(platform) ? `C:\\path\\to\\${name}` : `~/Projects/${name}`
}
