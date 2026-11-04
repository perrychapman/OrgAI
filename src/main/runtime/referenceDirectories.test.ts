import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REFERENCE_EDIT_TOOLS, editTargetOf, referenceEditDenial, referenceFolderMessage, referenceFolderOf } from './referenceDirectories'

let root: string
let ref: string
let work: string

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-ref-')))
  ref = join(root, 'client-material')
  work = join(root, 'work')
  mkdirSync(join(ref, 'sub'), { recursive: true })
  mkdirSync(work, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('referenceFolderOf', () => {
  it('finds the folder for a path inside it, existing or not', () => {
    expect(referenceFolderOf(join(ref, 'sub', 'a.docx'), [ref])).toBe(ref)
    expect(referenceFolderOf(join(ref, 'new', 'deep', 'b.md'), [ref])).toBe(ref)
    expect(referenceFolderOf(ref, [ref])).toBe(ref)
  })
  it('ignores paths outside and sibling prefixes', () => {
    expect(referenceFolderOf(join(work, 'a.md'), [ref])).toBeNull()
    expect(referenceFolderOf(`${ref}-copy${'/'}a.md`, [ref])).toBeNull()
  })
  it('resolves a relative path against cwd', () => {
    expect(referenceFolderOf(join('..', 'client-material', 'x.txt'), [ref], work)).toBe(ref)
    expect(referenceFolderOf('x.txt', [ref], work)).toBeNull()
  })
  it('sees through a link into the folder', () => {
    const link = join(work, 'shortcut')
    try {
      symlinkSync(ref, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return // no link support here
    }
    expect(referenceFolderOf(join(link, 'sub', 'a.docx'), [ref])).toBe(ref)
  })
  it('returns null for junk targets and refs', () => {
    expect(referenceFolderOf(undefined, [ref])).toBeNull()
    expect(referenceFolderOf('', [ref])).toBeNull()
    expect(referenceFolderOf(join(ref, 'a'), ['', 'relative/dir'])).toBeNull()
  })
})

describe('referenceEditDenial', () => {
  it('denies the four edit tools under a reference folder with the shared message', () => {
    for (const tool of REFERENCE_EDIT_TOOLS) {
      const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path'
      expect(referenceEditDenial(tool, { [key]: join(ref, 'a.md') }, [ref])).toBe(referenceFolderMessage(ref))
    }
    expect(referenceFolderMessage('/x')).toBe('/x is a reference folder: agents may read it, not change it')
  })
  it('allows edits elsewhere, other tools and runs without reference folders', () => {
    expect(referenceEditDenial('Write', { file_path: join(work, 'a.md') }, [ref])).toBeNull()
    expect(referenceEditDenial('Read', { file_path: join(ref, 'a.md') }, [ref])).toBeNull()
    expect(referenceEditDenial('Bash', { command: `echo x > ${join(ref, 'a.md')}` }, [ref])).toBeNull()
    expect(referenceEditDenial('Write', { file_path: join(ref, 'a.md') }, [])).toBeNull()
    expect(referenceEditDenial('Write', {}, undefined)).toBeNull()
  })
  it('fails closed on a missing or non-string path when reference folders exist', () => {
    expect(referenceEditDenial('Edit', {}, [ref])).toContain('reference folder')
    expect(referenceEditDenial('Write', { file_path: 42 }, [ref])).toContain('names no file path')
    expect(referenceEditDenial('Write', { file_path: `${join(work, 'a.md')}\0x` }, [ref])).toContain('NUL')
    expect(referenceEditDenial('MultiEdit', null, [ref])).toContain('reference folder')
  })
  it('reads notebook_path for NotebookEdit', () => {
    expect(editTargetOf('NotebookEdit', { notebook_path: 'a', file_path: 'b' })).toBe('a')
    expect(editTargetOf('Edit', { notebook_path: 'a', file_path: 'b' })).toBe('b')
  })
})
