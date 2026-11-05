import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  REFERENCE_EDIT_TOOLS,
  commandControlScan,
  commandReferenceTouch,
  commandTouchesReference,
  editTargetOf,
  globMayStartWith,
  pathAtOrUnder,
  referenceCommandMessage,
  referenceEditDenial,
  referenceFolderMessage,
  referenceFolderOf,
  referenceRefusalEntry,
  referenceTouchOf,
  searchReaches
} from './referenceDirectories'

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

describe('commandTouchesReference (shell guard)', () => {
  const WREF = 'C:\\Clients\\Acme'
  const WCWD = 'C:\\Clients\\Proj'
  const PREF = '/srv/acme'
  const PCWD = '/srv/proj'
  const w = (command: string, shell?: 'bash' | 'powershell', cwd: string | undefined = WCWD) =>
    commandTouchesReference(command, cwd, [WREF], { platform: 'win32', shell, home: 'C:\\Users\\me' })
  const x = (command: string, cwd: string | undefined = PCWD) => commandTouchesReference(command, cwd, [PREF], { platform: 'linux', home: '/srv' })

  it('catches commands that name a path inside the folder (Windows)', () => {
    expect(w('del "C:\\Clients\\Acme\\brief.md"')).toBe(WREF)
    expect(w("Remove-Item -Path 'C:\\Clients\\Acme\\a.txt'", 'powershell')).toBe(WREF)
    expect(w('echo x > C:\\Clients\\Acme\\out.txt')).toBe(WREF)
    expect(w('type C:\\Clients\\Acme\\a.txt')).toBe(WREF)
    expect(w('node tool.js --out=C:\\Clients\\Acme\\r.csv')).toBe(WREF)
    expect(w('del C:/Clients/Acme/x')).toBe(WREF)
  })

  it('catches commands that name a path inside the folder (POSIX)', () => {
    expect(x('rm -rf /srv/acme/x')).toBe(PREF)
    expect(x('mv /srv/acme/a ./b')).toBe(PREF)
    expect(x('echo x>/srv/acme/o')).toBe(PREF)
    expect(x('cat /srv/acme/a')).toBe(PREF)
    expect(x('cd ../acme && rm x')).toBe(PREF)
    expect(x('cat ~/acme/x')).toBe(PREF)
  })

  it('compares whole path parts, folds case on win32 and not on linux', () => {
    expect(w('del C:\\Clients\\Acme2\\x')).toBeNull()
    expect(x('cat /srv/acme2/x')).toBeNull()
    expect(w('del c:\\clients\\ACME\\x')).toBe(WREF)
    expect(x('cat /srv/ACME/x')).toBeNull()
    expect(w('del C:\\Clients\\Acme.\\x')).toBe(WREF)
  })

  it('reads MSYS /c/ paths in bash but not in PowerShell', () => {
    expect(w('cat /c/Clients/Acme/x', 'bash')).toBe(WREF)
    expect(w('cat /c/Clients/Acme/x', 'powershell')).toBeNull()
  })

  it('resolves relative words against the tracked cwd and follows cd', () => {
    expect(w('type ..\\Acme\\x')).toBe(WREF)
    expect(w('cd .. && del Acme\\x')).toBe(WREF)
    // A cd to a sibling's parent is an ancestor of the folder: it asks (accepted).
    expect(w('cd .. && del Other\\x')).toBe(WREF)
    expect(commandTouchesReference('cd .. && del Other\\x', 'C:\\Work\\Proj', [WREF], { platform: 'win32' })).toBeNull()
    expect(commandTouchesReference('del Acme\\x', undefined, [WREF], { platform: 'win32' })).toBeNull()
    expect(w('cd $X && del Acme\\x')).toBe(WREF)
    expect(w('cd Acme', 'powershell', 'C:\\Clients')).toBe(WREF)
    expect(commandReferenceTouch('cd /srv/acme', PCWD, [PREF], { platform: 'linux' })).toEqual({ folder: PREF, how: 'names' })
  })

  it('catches an ancestor and a glob over the folder', () => {
    expect(w('rm -rf ..')).toBe(WREF)
    expect(w('del /s C:\\Clients')).toBe(WREF)
    expect(w('rm C:\\Clients\\Ac*')).toBe(WREF)
    expect(w('rm C:\\Clients\\Acme\\*.txt')).toBe(WREF)
    expect(x('rm -rf ..')).toBe(PREF)
    expect(x('rm /srv/a*')).toBe(PREF)
    expect(x('rm *.log')).toBeNull()
  })

  it('reports runs-in when the cwd is inside the folder, names otherwise', () => {
    expect(commandReferenceTouch('npm test', 'C:\\Clients\\Acme\\sub', [WREF], { platform: 'win32' })).toEqual({ folder: WREF, how: 'runs-in' })
    expect(commandReferenceTouch('del C:\\Clients\\Acme\\x', WCWD, [WREF], { platform: 'win32' })).toEqual({ folder: WREF, how: 'names' })
    expect(commandTouchesReference('npm test', '/srv/acme/sub', [PREF], { platform: 'linux' })).toBe(PREF)
    expect(referenceCommandMessage(PREF, 'names')).toBe(`${referenceFolderMessage(PREF)}; this command names it`)
    expect(referenceCommandMessage(PREF, 'runs-in')).toBe(`${referenceFolderMessage(PREF)}; this command runs inside it`)
  })

  it('sees inside a wrapped shell and ignores unrelated commands, empty refs and URLs', () => {
    expect(x("bash -lc 'rm /srv/acme/x'")).toBe(PREF)
    expect(x("./tools/sh -c 'rm /srv/acme/x'")).toBe(PREF)
    expect(x('npm test')).toBeNull()
    expect(w('npm test -- --reporter=dot')).toBeNull()
    expect(x('git clone https://srv/acme/x.git')).toBeNull()
    expect(commandTouchesReference('rm /srv/acme/x', PCWD, [], { platform: 'linux' })).toBeNull()
    expect(commandTouchesReference('rm /srv/acme/x', PCWD, ['relative'], { platform: 'linux' })).toBeNull()
  })

  it('fails closed past the word budget', () => {
    expect(x(`echo ${'a '.repeat(2100)}`)).toBe(PREF)
  })

  it('sees through a real link on this platform', () => {
    const link = join(work, 'shortcut')
    try {
      symlinkSync(ref, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return
    }
    expect(commandTouchesReference(`cat ${join(link, 'sub', 'a.md')}`, work, [ref])).toBe(ref)
    expect(commandTouchesReference('cat other.md', work, [ref])).toBeNull()
  })
})

describe('referenceTouchOf', () => {
  it('routes shell, edit, Read, Glob and Grep calls', () => {
    const f = join(ref, 'sub', 'a.md')
    expect(referenceTouchOf('Bash', { command: `cat ${f}` }, [ref], work)).toBe(ref)
    expect(referenceTouchOf('PowerShell', { command: `Get-Content '${f}'` }, [ref], work)).toBe(ref)
    expect(referenceTouchOf('Write', { file_path: f }, [ref], work)).toBe(ref)
    expect(referenceTouchOf('Read', { file_path: f }, [ref], work)).toBe(ref)
    expect(referenceTouchOf('Read', { file_path: join(work, 'a.md') }, [ref], work)).toBeNull()
    expect(referenceTouchOf('Glob', { pattern: '*.md', path: ref }, [ref], work)).toBe(ref)
    expect(referenceTouchOf('Glob', { pattern: '*.md' }, [ref], ref)).toBe(ref)
    expect(referenceTouchOf('Glob', { pattern: join(ref, '**', '*.md') }, [ref], work)).toBe(ref)
    expect(referenceTouchOf('Glob', { pattern: '*.md' }, [ref], work)).toBeNull()
    expect(referenceTouchOf('Grep', { pattern: 'x', path: ref }, [ref], work)).toBe(ref)
    expect(referenceTouchOf('Grep', { pattern: 'x' }, [ref], ref)).toBe(ref)
    expect(referenceTouchOf('Grep', { pattern: 'x' }, [ref], work)).toBeNull()
  })
  it('is null for other tools, empty refs and bad input', () => {
    expect(referenceTouchOf('WebFetch', { url: 'x' }, [ref], work)).toBeNull()
    expect(referenceTouchOf('Bash', { command: `cat ${join(ref, 'a')}` }, [], work)).toBeNull()
    expect(referenceTouchOf('Bash', {}, [ref], work)).toBeNull()
    expect(referenceTouchOf('Read', null, [ref], work)).toBeNull()
  })
})

describe('referenceRefusalEntry', () => {
  it('names the file and carries the path and the folder message', () => {
    const e = referenceRefusalEntry('C:\\Clients\\Acme\\sub\\brief.md', 'C:\\Clients\\Acme')
    expect(e.text).toBe('Refused: brief.md is in a reference folder (read only)')
    expect(e.detail).toBe(`C:\\Clients\\Acme\\sub\\brief.md\n${referenceFolderMessage('C:\\Clients\\Acme')}`)
    expect(referenceRefusalEntry('/srv/acme/a.md', '/srv/acme').text).toContain('a.md')
  })
  it('handles a missing path and strips hidden characters', () => {
    for (const t of [undefined, '', 42, '\u202e\u200b']) {
      const e = referenceRefusalEntry(t, '/srv/acme')
      expect(e.text).toBe('Refused: an edit that names no file (reference folders are read only)')
      expect(e.detail).toBe(referenceFolderMessage('/srv/acme'))
    }
    const e = referenceRefusalEntry('/srv/acme/a\u202eb\u0000.md', '/srv/acme')
    expect(e.text).toBe('Refused: ab.md is in a reference folder (read only)')
    expect(e.detail.split('\n')[0]).toBe('/srv/acme/ab.md')
  })
  it('clamps the name and the path', () => {
    const e = referenceRefusalEntry(`/srv/acme/${'n'.repeat(1200)}`, '/srv/acme')
    expect(e.text.length).toBeLessThan(200)
    expect(e.text).toContain('…')
    expect(e.detail.split('\n')[0].length).toBe(1024)
    expect(referenceRefusalEntry({ file: 1 }, '/srv/acme').detail).toBe(referenceFolderMessage('/srv/acme'))
  })
})

describe('prefix protection (definite mode, selfControlGate.ts Wave 7)', () => {
  it('globMayStartWith runs the prefix through the glob', () => {
    for (const g of ['*', 'v*', 'vault*', '*.json', '*.json*', 'v?ult.json.tmp', '[uv]ault.json', '[!x]ault*', '*.tmp', '*corrupt*', 'vault.json', 'vault.json.reset-*', 'vault.jso[n]x']) {
      expect(globMayStartWith(g, 'vault.json'), g).toBe(true)
    }
    for (const g of ['p*', 'x*', 'w*.json', 'vault', 'vault.js', '[!v]*', 'valut*', '?', 'vault.jsox*']) {
      expect(globMayStartWith(g, 'vault.json'), g).toBe(false)
    }
  })

  it('pathAtOrUnder / searchReaches / commandControlScan honour `prefixed`, and only in definite mode', () => {
    const prefixed = [{ dir: '/d', prefixes: ['vault.json'], safeExtensions: new Set(['md']) }]
    const opts = { platform: 'linux' as const, home: '/h', prefixed }
    expect(pathAtOrUnder('/d/vault.json.tmp', [], undefined, opts)).toBe('/d')
    expect(pathAtOrUnder('/d/vault.json/x', [], undefined, opts)).toBe('/d')
    expect(pathAtOrUnder('/d', [], undefined, opts)).toBeNull()
    expect(pathAtOrUnder('/d/other.json', [], undefined, opts)).toBeNull()
    expect(pathAtOrUnder('/d/sub/vault.json', [], undefined, opts)).toBeNull()
    expect(searchReaches('/d', 'v*', [], undefined, opts)).toBe('/d')
    expect(searchReaches('/d', '*.md', [], undefined, opts)).toBeNull()
    expect(searchReaches('/', undefined, [], undefined, opts)).toBe('/d')
    expect(commandControlScan('cat /d/vault.json.corrupt-1', '/w', [], opts)).toBe('touch')
    expect(commandControlScan('cat /d/*', '/w', [], opts)).toBe('touch')
    expect(commandControlScan('cat /d/*.md /d/p*', '/w', [], opts)).toBeNull()
    expect(commandControlScan('cd /d && cat vault.json', '/w', [], opts)).toBe('touch')
    // Reference mode ignores it.
    expect(commandReferenceTouch('cat /d/vault.json', '/w', ['/r'], { platform: 'linux', prefixed })).toBeNull()
  })
})
