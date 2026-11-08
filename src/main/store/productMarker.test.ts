import { readdirSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkCliFolder, containsAppRefusal, folderRefusal, markerUnreadableRefusal, markerWriteRefusal, readProductMarker, writeProductMarker } from './productMarker'

const dirs: string[] = []
const base = (): string => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'pmark-')))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const check = (userDataDir: string, desktopDefault: string): string | undefined => checkCliFolder({ userDataDir, dataDir: join(userDataDir, 'data'), desktopDefault })
const marker = (dir: string, product: string): void => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'product.json'), JSON.stringify({ product, version: 1 }))
}
const link = (target: string, at: string): void => symlinkSync(target, at, 'junction')

describe('product marker', () => {
  it('a missing folder is created with a 0600 CLI marker', () => {
    const dir = join(base(), 'orgai-cli')
    expect(check(dir, join(base(), 'OrgAI'))).toBeUndefined()
    expect(JSON.parse(readFileSync(join(dir, 'product.json'), 'utf8'))).toEqual({ product: 'orgai-cli', version: 1 })
    if (process.platform !== 'win32') expect(statSync(join(dir, 'product.json')).mode & 0o777).toBe(0o600)
    expect(readProductMarker(dir)).toEqual({ state: 'marked', product: 'orgai-cli' })
  })

  it('an existing but empty folder (also an empty data/) gets the marker', () => {
    const dir = base()
    mkdirSync(join(dir, 'data'))
    expect(check(dir, join(base(), 'OrgAI'))).toBeUndefined()
    expect(readProductMarker(dir)).toEqual({ state: 'marked', product: 'orgai-cli' })
  })

  it('a CLI-marked folder with data stays usable and is not rewritten', () => {
    const dir = base()
    marker(dir, 'orgai-cli')
    mkdirSync(join(dir, 'data'))
    writeFileSync(join(dir, 'data', 'projects.json'), '[]')
    const before = readFileSync(join(dir, 'product.json'), 'utf8')
    expect(check(dir, join(base(), 'OrgAI'))).toBeUndefined()
    expect(readFileSync(join(dir, 'product.json'), 'utf8')).toBe(before)
  })

  it('refuses a folder marked for the desktop app, writing nothing', () => {
    const dir = base()
    marker(dir, 'orgai-desktop')
    expect(check(dir, join(base(), 'OrgAI'))).toBe(folderRefusal(dir))
    expect(folderRefusal(dir)).toBe(`${dir} belongs to the OrgAI app. orgai keeps its own data; choose another folder.`)
    expect(readProductMarker(dir)).toEqual({ state: 'marked', product: 'orgai-desktop' })
  })

  it('refuses an unmarked folder whose data/ is not empty, and does not mark it', () => {
    const dir = base()
    mkdirSync(join(dir, 'data'))
    writeFileSync(join(dir, 'data', 'settings.json'), '{}')
    expect(check(dir, join(base(), 'OrgAI'))).toBe(folderRefusal(dir))
    expect(readProductMarker(dir)).toEqual({ state: 'absent' })
  })

  it('refuses a folder whose marker is damaged, unknown or unreadable instead of replacing it', () => {
    const dir = base()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'product.json')
    writeFileSync(file, '{nope')
    expect(readProductMarker(dir)).toEqual({ state: 'invalid' })
    expect(check(dir, join(base(), 'OrgAI'))).toBe(markerUnreadableRefusal(dir))
    expect(readFileSync(file, 'utf8')).toBe('{nope')
    // A marker of a newer version or another product (a future app folder with its marker but no data/ yet).
    writeFileSync(file, JSON.stringify({ product: 'orgai-desktop', version: 2, extra: true }))
    expect(readProductMarker(dir)).toEqual({ state: 'marked', product: 'orgai-desktop' })
    writeFileSync(file, JSON.stringify({ product: 'something', version: 1 }))
    expect(readProductMarker(dir)).toEqual({ state: 'invalid' })
    expect(check(dir, join(base(), 'OrgAI'))).toBe(markerUnreadableRefusal(dir))
    expect(JSON.parse(readFileSync(file, 'utf8')).product).toBe('something')
    // A product.json that is a directory (EISDIR) is unreadable too.
    rmSync(file)
    mkdirSync(file)
    expect(check(dir, join(base(), 'OrgAI'))).toBe(markerUnreadableRefusal(dir))
  })

  it('refuses a CLI-marked folder whose data/ links into the app data (a symlink), and any data/ that is not its own', () => {
    const app = join(base(), 'OrgAI')
    mkdirSync(join(app, 'data'), { recursive: true })
    writeFileSync(join(app, 'data', 'projects.json'), '[]')
    const dir = base()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'product.json'), JSON.stringify({ product: 'orgai-cli', version: 1 }))
    link(join(app, 'data'), join(dir, 'data'))
    expect(check(dir, app)).toBe(folderRefusal(dir))
    // Even a link to a harmless folder elsewhere is not <userDataDir>/data.
    rmSync(join(dir, 'data'))
    const other = join(base(), 'elsewhere')
    mkdirSync(other, { recursive: true })
    link(other, join(dir, 'data'))
    expect(check(dir, app)).toBe(folderRefusal(dir))
    // A real data/ is fine.
    rmSync(join(dir, 'data'))
    mkdirSync(join(dir, 'data'))
    expect(check(dir, app)).toBeUndefined()
  })

  it('refuses the desktop default folder itself, even unmarked and empty', () => {
    const app = join(base(), 'OrgAI')
    mkdirSync(app)
    expect(check(app, app)).toBe(folderRefusal(app))
    expect(readProductMarker(app)).toEqual({ state: 'absent' })
  })

  it('refuses the desktop default when it does not exist yet (same parent and name)', () => {
    const app = join(base(), 'OrgAI')
    expect(check(app, app)).toBe(folderRefusal(app))
  })

  it('refuses a symlink alias of the desktop default folder', () => {
    const root = base()
    const app = join(root, 'OrgAI')
    mkdirSync(app)
    const alias = join(root, 'alias')
    link(app, alias)
    expect(check(alias, app)).toBe(folderRefusal(alias))
    expect(readProductMarker(app)).toEqual({ state: 'absent' })
  })

  it('refuses the default reached through a symlinked parent folder', () => {
    const root = base()
    const parent = join(root, 'Support')
    mkdirSync(parent)
    const app = join(parent, 'OrgAI')
    const viaLink = join(root, 'Shortcut')
    link(parent, viaLink)
    // The folder does not exist yet: only the parent resolves.
    expect(check(join(viaLink, 'OrgAI'), app)).toBe(folderRefusal(join(viaLink, 'OrgAI')))
    mkdirSync(app)
    expect(check(join(viaLink, 'OrgAI'), app)).toBe(folderRefusal(join(viaLink, 'OrgAI')))
  })

  it('writeProductMarker reports failure instead of throwing', () => {
    const root = base()
    writeFileSync(join(root, 'file'), 'x')
    expect(writeProductMarker(join(root, 'file', 'sub'), 'orgai-cli')).toBe(false)
  })

  it('refuses a folder inside the desktop default (its data/ subfolder, or deeper) and writes nothing there', () => {
    const app = join(base(), 'OrgAI')
    mkdirSync(join(app, 'data'), { recursive: true })
    for (const inside of [join(app, 'data'), join(app, 'data', 'x'), join(app, 'newfolder')]) {
      expect(check(inside, app), inside).toBe(folderRefusal(inside))
    }
    expect(() => readFileSync(join(app, 'data', 'product.json'))).toThrow()
  })

  it('refuses a folder that contains the desktop default, and one under a desktop-marked ancestor', () => {
    const root = base()
    const app = join(root, 'Support', 'OrgAI')
    mkdirSync(app, { recursive: true })
    expect(check(join(root, 'Support'), app)).toBe(containsAppRefusal(join(root, 'Support')))
    expect(containsAppRefusal(join(root, 'Support'))).not.toContain('belongs to')
    const other = join(root, 'Other')
    mkdirSync(join(other, 'deep'), { recursive: true })
    marker(other, 'orgai-desktop')
    expect(check(join(other, 'deep'), join(root, 'elsewhere'))).toBe(folderRefusal(join(other, 'deep')))
  })

  it('a sibling of the desktop default is fine', () => {
    const root = base()
    const app = join(root, 'OrgAI')
    mkdirSync(app)
    expect(check(join(root, 'orgai-cli'), app)).toBeUndefined()
  })

  it('a marker that cannot be written is a refusal naming the folder, not a silent go-ahead', () => {
    const root = base()
    writeFileSync(join(root, 'file'), 'x')
    const dir = join(root, 'file', 'sub')
    expect(check(dir, join(root, 'OrgAI'))).toBe(markerWriteRefusal(dir))
  })

  it('the marker is written through a temp file that is gone afterwards', () => {
    const dir = base()
    expect(writeProductMarker(dir, 'orgai-cli')).toBe(true)
    expect(readdirSync(dir)).toEqual(['product.json'])
  })
})
