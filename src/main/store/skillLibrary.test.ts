import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillLibraryEntry } from '@shared/types'
import { SkillLibraryStore } from './skillLibrary'

const dirs: string[] = []
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'orgai-skilllib-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const entry = (id: string, name = id): SkillLibraryEntry => ({ id, name, description: 'd', source: 'user', digest: 'x', files: [], addedAt: 't', updatedAt: 't' })

describe('SkillLibraryStore', () => {
  it('saves, replaces, lists copies, removes and persists', () => {
    const dir = temp()
    const s = new SkillLibraryStore(dir)
    s.save(entry('a'))
    s.save(entry('b'))
    s.save({ ...entry('a'), description: 'changed' })
    expect(s.list().map((e) => e.id)).toEqual(['a', 'b'])
    expect(s.get('a')?.description).toBe('changed')
    s.list()[0].name = 'mutated'
    expect(s.get('a')?.name).toBe('a')
    expect(s.remove('b')).toBe(true)
    expect(s.remove('b')).toBe(false)
    expect(new SkillLibraryStore(dir).list().map((e) => e.id)).toEqual(['a'])
  })

  it('starts empty on a corrupt file and drops entries with unsafe ids', () => {
    const dir = temp()
    writeFileSync(join(dir, 'skill-library.json'), '{nope')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(new SkillLibraryStore(dir).list()).toEqual([])
    spy.mockRestore()
    writeFileSync(join(dir, 'skill-library.json'), JSON.stringify({ entries: [entry('ok'), entry('../evil'), null, { id: 'x' }] }))
    expect(new SkillLibraryStore(dir).list().map((e) => e.id)).toEqual(['ok'])
  })
})
