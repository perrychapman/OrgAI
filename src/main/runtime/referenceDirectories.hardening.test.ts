import { beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalDeep } from '../quick/scratch'
import { commandReferenceTouch, commandTouchesReference, referenceEditDenial, referenceFolderOf, referenceRefusalEntry } from './referenceDirectories'

vi.mock('../quick/scratch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../quick/scratch')>()
  return { ...actual, canonicalDeep: vi.fn((p: string) => actual.canonicalDeep(p)) }
})

const WREF = 'C:\\Clients\\Acme'
const WCWD = 'C:\\Clients\\Proj'
const w = (command: string, shell?: 'bash' | 'powershell', cwd: string | undefined = WCWD) =>
  commandTouchesReference(command, cwd, [WREF], { platform: 'win32', shell, home: 'C:\\Users\\me' })

beforeEach(() => {
  vi.mocked(canonicalDeep).mockClear()
})

describe('UNC and device words (H1: no file-system access)', () => {
  const unc = [
    '\\\\host\\share\\x',
    '//host/s/x',
    '\\\\?\\C:\\Other\\x',
    '\\\\.\\pipe\\x',
    '\\\\?\\UNC\\host\\share\\x',
    '\\\\localhost\\C$\\x'
  ]
  it('counts as touching the first folder and never calls the file system', () => {
    for (const word of unc) {
      expect(w(`type ${word}`)).toBe(WREF)
      expect(w(`type ${word}`, 'powershell')).toBe(WREF)
      expect(w(`node tool.js --out=${word}`)).toBe(WREF)
      expect(w(`ls -Path:${word}`, 'powershell')).toBe(WREF)
      expect(w(`type ${word}*`)).toBe(WREF)
    }
    // Local resolutions (the cwd, a folder, a word made relative to the cwd) happen; no call ever starts with two separators.
    const uncCalls = vi.mocked(canonicalDeep).mock.calls.filter(([p]) => /^[\\/]{2}/.test(p))
    expect(uncCalls).toEqual([])
  })
  it('treats a UNC cwd as running inside the folder with no file-system access', () => {
    expect(commandReferenceTouch('dir', '\\\\host\\share', [WREF], { platform: 'win32' })).toEqual({ folder: WREF, how: 'runs-in' })
    expect(canonicalDeep).not.toHaveBeenCalled()
  })
  it('never resolves a UNC edit path and denies it on Windows', () => {
    for (const word of unc) {
      const r = referenceFolderOf(word, ['C:\\Clients\\Acme'])
      if (process.platform === 'win32') expect(r).toBe('C:\\Clients\\Acme')
      referenceEditDenial('Write', { file_path: word }, ['C:\\Clients\\Acme'])
    }
    expect(canonicalDeep).not.toHaveBeenCalled()
  })
  it.runIf(process.platform === 'win32')('denies UNC edit paths', () => {
    expect(referenceEditDenial('Edit', { file_path: '\\\\host\\share\\x' }, [WREF])).toContain('reference folder')
  })
  it('skips the file system for a UNC reference folder', () => {
    referenceFolderOf('C:\\x\\y', ['\\\\host\\share\\ref'])
    commandReferenceTouch('type C:\\x\\y', undefined, ['\\\\host\\share\\ref'], { platform: 'win32' })
    expect(canonicalDeep).not.toHaveBeenCalledWith('\\\\host\\share\\ref')
  })
})

describe('spellings (M1)', () => {
  it('reads -Name:value, FileSystem:: and provider-qualified words', () => {
    expect(w('Remove-Item -Path:C:\\Clients\\Acme\\x', 'powershell')).toBe(WREF)
    expect(w('Get-Content -LiteralPath:C:\\Clients\\Acme\\x', 'powershell')).toBe(WREF)
    expect(w('dir FileSystem::C:\\Clients\\Acme\\x', 'powershell')).toBe(WREF)
    expect(w('dir Microsoft.PowerShell.Core\\FileSystem::C:\\Clients\\Acme', 'powershell')).toBe(WREF)
    expect(w('dir HKCU:\\Software', 'powershell')).toBeNull()
    expect(w('dir Registry::HKEY_LOCAL_MACHINE\\x', 'powershell')).toBeNull()
    expect(w('dir Env:\\Path', 'powershell')).toBeNull()
    expect(w('dir Weird:\\x', 'powershell')).toBe(WREF)
    // `Name::x` is not a path (M-A: Foo::bar, std::fs); only FileSystem:: and `Name:\` forms are.
    expect(w('dir Weird::x', 'powershell')).toBeNull()
  })
  it('unescapes backslashes in bash words', () => {
    expect(commandTouchesReference('cat /srv/\\acme/x', '/srv/proj', ['/srv/acme'], { platform: 'linux' })).toBe('/srv/acme')
    expect(commandTouchesReference('cat /srv/ac\\me/x', '/srv/proj', ['/srv/acme'], { platform: 'linux' })).toBe('/srv/acme')
    expect(commandTouchesReference('cat /srv/ac\\me/x', '/srv/proj', ['/srv/acme'], { platform: 'linux', shell: 'powershell' })).toBeNull()
  })
})

describe('cwd tracking (M2)', () => {
  it('scans cd words and takes the last non-flag word as the target', () => {
    expect(w('cd /d C:\\Clients\\Acme')).toBe(WREF)
    expect(w('cd -- C:\\Clients\\Acme')).toBe(WREF)
    expect(w('Set-Location -Path C:\\Clients\\Acme', 'powershell')).toBe(WREF)
    expect(w('Set-Location -Path ..\\Acme', 'powershell')).toBe(WREF)
    expect(w('pushd -LiteralPath C:\\Clients\\Acme', 'powershell')).toBe(WREF)
    expect(w('cd C:\\Clients')).toBe(WREF)
    expect(w('cd C:\\Work && dir', undefined, 'C:\\Work')).toBeNull()
  })
  it('keeps cd .. free when it is not an ancestor of a folder', () => {
    expect(commandTouchesReference('cd .. && dir C:\\Work\\x', 'C:\\Work\\Proj', [WREF], { platform: 'win32' })).toBeNull()
    expect(commandTouchesReference('cd sub && npm test', '/srv/proj', ['/srv/acme'], { platform: 'linux' })).toBeNull()
  })
  it('fails closed after a cd it cannot follow', () => {
    for (const cd of ['cd -', 'popd', 'cd', 'cd $X']) {
      expect(commandReferenceTouch(`${cd} && npm test`, '/srv/proj', ['/srv/acme'], { platform: 'linux' })).toEqual({
        folder: '/srv/acme',
        how: 'runs-in'
      })
      expect(commandReferenceTouch(`${cd} && rm sub/x`, '/srv/proj', ['/srv/acme'], { platform: 'linux' })?.folder).toBe('/srv/acme')
    }
    expect(w('Pop-Location; dir', 'powershell')).toBe(WREF)
    // Every later segment asks after an untracked cd (M-B), even one naming only an unrelated absolute path.
    expect(commandReferenceTouch('cd - && cat /srv/other/x', '/srv/proj', ['/srv/acme'], { platform: 'linux' })?.folder).toBe('/srv/acme')
    expect(commandReferenceTouch('cd - && rm -rf * 2>/dev/null', '/srv/proj', ['/srv/acme'], { platform: 'linux' })?.folder).toBe('/srv/acme')
    expect(w('Push-Location $env:X; Remove-Item -Recurse *', 'powershell')).toBe(WREF)
    // A tracked cd afterwards ends the unknown state.
    expect(commandReferenceTouch('cd - && cd /srv/other && ls', '/srv/proj', ['/srv/acme'], { platform: 'linux' })).toBeNull()
  })
})

describe('URLs and provider-looking words (M-A)', () => {
  it('does not treat URLs or Foo::bar as touching', () => {
    for (const shell of ['bash', 'powershell'] as const) {
      expect(w('git clone https://github.com/x/y', shell)).toBeNull()
      expect(w('curl https://a.b/c', shell)).toBeNull()
      expect(w('rg "Foo::bar"', shell)).toBeNull()
      expect(w('rg std::fs', shell)).toBeNull()
    }
    expect(w('Remove-Item FileSystem::C:\\Clients\\Acme\\x', 'powershell')).toBe(WREF)
  })
})

describe('refusal row cleaner (L-e)', () => {
  it('strips supplementary variation selectors and tag characters', () => {
    const e = referenceRefusalEntry('/srv/acme/a\u{e0100}b\u{e01ef}c\u{e0041}.md', '/srv/acme')
    expect(e.detail.split('\n')[0]).toBe('/srv/acme/abc.md')
  })
})

describe('bounded work (M3)', () => {
  const quick = (f: () => unknown) => {
    const t = Date.now()
    const r = f()
    expect(Date.now() - t).toBeLessThan(200)
    return r
  }
  it('trims trailing dots and spaces in linear time', () => {
    quick(() => w(`del C:\\x\\${'.'.repeat(30000)}a`))
    quick(() => w(`del C:\\x\\${' '.repeat(30000)}a`))
    quick(() => w(`del "C:\\x\\${'. '.repeat(15000)}a"`))
  })
  it('fails closed past the size caps without file-system access', () => {
    expect(quick(() => w(`del ${'.'.repeat(100000)}a`))).toBe(WREF)
    const long = commandReferenceTouch(`echo ${'a '.repeat(20000)}`, WCWD, [WREF], { platform: 'win32' })
    expect(long).toEqual({ folder: WREF, how: 'names' })
    expect(canonicalDeep).not.toHaveBeenCalled()
  })
  it('handles a 30 KB pipeline and a 30 KB quoted word quickly', () => {
    expect(quick(() => w('a|'.repeat(15000) + 'a'))).toBe(WREF)
    quick(() => w(`echo "${'a|'.repeat(15000)}"`))
  })
})

describe('refusal row cleaner (L7)', () => {
  it('strips variation selectors and interlinear annotation marks', () => {
    const e = referenceRefusalEntry('/srv/acme/a\ufe0fb\ufff9c\ufffb.md', '/srv/acme')
    expect(e.detail.split('\n')[0]).toBe('/srv/acme/abc.md')
  })
})
