/** Path display helpers. Pure: no IPC, no node:path (the renderer sees both Windows and POSIX paths). */

const SEP = /[\\/]+/

/** The last path segment ("C:\\Users\\me\\notes-api\\" gives "notes-api"). A bare root is returned as is. */
export function folderName(path: string): string {
  const parts = path.split(SEP).filter(Boolean)
  const last = parts[parts.length - 1]
  return last ?? path.trim()
}

/**
 * Shortens a long path from the middle, keeping the first segment and the end (the recognisable part).
 * Never truncates the last segment. Returns the path unchanged when it fits `max` characters.
 */
export function abbreviatePath(path: string, max = 40): string {
  if (path.length <= max) return path
  const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/'
  const parts = path.split(SEP).filter(Boolean)
  if (parts.length <= 2) return path
  const lead = path.startsWith('/') ? '/' : ''
  const head = `${lead}${parts[0]}${sep}`
  let tail = parts[parts.length - 1]
  for (let i = parts.length - 2; i > 0; i--) {
    const next = `${parts[i]}${sep}${tail}`
    if (head.length + 1 + sep.length + next.length > max) break
    tail = next
  }
  return `${head}…${sep}${tail}`
}
