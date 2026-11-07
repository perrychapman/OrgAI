/**
 * An in-memory LookupFs for the runtime-resolution tests (claudeBinary, codexBinary, doctor runtime checks). Files carry
 * their first bytes; links map a path to its real path. Test helper only: nothing in the app imports it.
 */
import type { LookupFs } from './executableLookup'

export interface FakeFile {
  /** The file's contents (or its first bytes). */
  head?: Uint8Array | string
  mtimeMs?: number
  size?: number
}

export const MACHO = Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01])
export const ELF = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01])
export const PE = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00])

export class FakeLookupFs implements LookupFs {
  readonly files = new Map<string, FakeFile>()
  readonly dirs = new Set<string>()
  /** path -> real path (a symlink). Followed by stat, realpath and readHead. */
  readonly links = new Map<string, string>()
  readonly reads: string[] = []

  constructor(files: Record<string, FakeFile | string | Uint8Array> = {}, dirs: string[] = []) {
    for (const [p, f] of Object.entries(files)) this.file(p, f)
    for (const d of dirs) this.dirs.add(d)
  }

  file(p: string, f: FakeFile | string | Uint8Array = {}): this {
    this.files.set(p, typeof f === 'string' || f instanceof Uint8Array ? { head: f } : f)
    return this
  }

  link(p: string, target: string): this {
    this.links.set(p, target)
    return this
  }

  private real(p: string): string {
    let cur = p
    for (let i = 0; i < 16 && this.links.has(cur); i++) cur = this.links.get(cur)!
    return cur
  }

  stat(p: string): ReturnType<LookupFs['stat']> {
    const r = this.real(p)
    const f = this.files.get(r)
    if (f) return { isFile: true, isDirectory: false, mtimeMs: f.mtimeMs ?? 1, size: f.size ?? bytes(f.head).length }
    if (this.dirs.has(r)) return { isFile: false, isDirectory: true, mtimeMs: 1, size: 0 }
    return undefined
  }

  realpath(p: string): string | undefined {
    const r = this.real(p)
    return this.files.has(r) || this.dirs.has(r) ? r : undefined
  }

  readHead(p: string, max: number): Uint8Array | undefined {
    const r = this.real(p)
    this.reads.push(r)
    const f = this.files.get(r)
    return f ? bytes(f.head).subarray(0, max) : undefined
  }
}

function bytes(head: Uint8Array | string | undefined): Uint8Array {
  if (head === undefined) return new Uint8Array()
  return typeof head === 'string' ? new TextEncoder().encode(head) : head
}
