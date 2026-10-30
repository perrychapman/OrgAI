import { describe, expect, it } from 'vitest'
import { abbreviatePath, folderName } from './paths'

describe('folderName', () => {
  it('takes the last segment of Windows and POSIX paths', () => {
    expect(folderName('C:\\Users\\me\\Projects\\notes-api')).toBe('notes-api')
    expect(folderName('/home/me/notes-api')).toBe('notes-api')
  })
  it('ignores trailing separators', () => {
    expect(folderName('/home/me/notes-api/')).toBe('notes-api')
    expect(folderName('C:\\work\\app\\\\')).toBe('app')
  })
  it('keeps a root as is', () => {
    expect(folderName('/')).toBe('/')
    expect(folderName('')).toBe('')
  })
})

describe('abbreviatePath', () => {
  it('leaves short paths alone', () => {
    expect(abbreviatePath('/a/b', 40)).toBe('/a/b')
  })
  it('keeps the head and the end of a long path', () => {
    const out = abbreviatePath('C:\\Users\\someone\\AppData\\Local\\Temp\\orgai-e2e\\notes-api', 36)
    expect(out.startsWith('C:\\')).toBe(true)
    expect(out.endsWith('notes-api')).toBe(true)
    expect(out).toContain('…')
  })
  it('never cuts the last segment', () => {
    expect(abbreviatePath('/very/long/path/to/a-quite-long-folder-name', 10).endsWith('a-quite-long-folder-name')).toBe(true)
  })
})
