/** The save dialog may return a name without the kit suffix; a name that does not end in .json gets ".orgai-kit.json". */
export function kitExportPath(chosen: string): string {
  return /\.json$/i.test(chosen) ? chosen : `${chosen}.orgai-kit.json`
}

/**
 * Files the user chose in a main-process dialog (kit:pickExportPath / kit:pickImportPath), per renderer
 * (`WebContents.id`), newest last, at most `max` each. The kit channels accept only a path the same renderer picked, so
 * a compromised renderer cannot make main write or read an arbitrary file. Pure; exported for tests.
 */
export class PickedPaths {
  private bySender = new Map<number, string[]>()
  constructor(private readonly max = 5) {}

  remember(senderId: number, path: string): void {
    const list = (this.bySender.get(senderId) ?? []).filter((p) => p !== path)
    list.push(path)
    while (list.length > this.max) list.shift()
    this.bySender.set(senderId, list)
  }

  /** Whether `senderId` picked `path` (not consumed: a preview and its apply use the same file). */
  has(senderId: number, path: string): boolean {
    return this.bySender.get(senderId)?.includes(path) === true
  }

  /** True (and forgotten) when `senderId` picked `path`. One-shot. */
  take(senderId: number, path: string): boolean {
    const list = this.bySender.get(senderId)
    const i = list ? list.indexOf(path) : -1
    if (!list || i === -1) return false
    list.splice(i, 1)
    if (list.length === 0) this.bySender.delete(senderId)
    return true
  }

  forget(senderId: number): void {
    this.bySender.delete(senderId)
  }
}
