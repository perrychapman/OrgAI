import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CATALOG_FILE_PREFIX,
  CATALOG_MAX_AGE_MS,
  CODEX_MODELS_CACHE_FILE,
  catalogStartFailure,
  catalogWithoutNativeAgents,
  clearNativeCatalogMemory,
  isNativeCatalogRejected,
  rejectNativeCatalog,
  modelCatalogEntry,
  nativeAgentsCatalogConfig,
  nodeCatalogFs,
  providerConfigLines,
  type CatalogDumpRunner
} from './codexNativeCatalog'

// The shape of `codex debug models` (codex 0.166.0), trimmed: unknown fields must survive untouched.
const model = (slug: string, extra: Record<string, unknown>) => ({
  slug,
  display_name: slug,
  default_reasoning_level: 'medium',
  supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }, { effort: 'high', description: 'Deep' }],
  context_window: 400000,
  effective_context_window_percent: 95,
  truncation_policy: { mode: 'tokens', limit: 10000 },
  multi_agent_reasoning_effort: null,
  ...extra
})
const catalog = (models: unknown[], top: Record<string, unknown> = {}) => JSON.stringify({ models, ...top })

describe('catalogWithoutNativeAgents', () => {
  it('sets every v2 model to v1 and keeps everything else, key order included', () => {
    const text = catalog([model('gpt-a', { multi_agent_version: 'v2', future_field: { x: [1, 2.5, 'y'] } }), model('gpt-b', { multi_agent_version: 'v2' })], { etag: 'abc' })
    const t = catalogWithoutNativeAgents(text)
    expect(t.kind).toBe('override')
    if (t.kind !== 'override') return
    expect(t.changed).toEqual(['gpt-a', 'gpt-b'])
    const expected = JSON.parse(text)
    for (const m of expected.models) m.multi_agent_version = 'v1'
    expect(t.json).toBe(JSON.stringify(expected))
  })

  it('leaves v1, null and absent entries alone and answers "unchanged" when nothing offers native tools', () => {
    const text = catalog([model('luna', { multi_agent_version: 'v1' }), model('old', { multi_agent_version: null }), model('plain', {})])
    expect(catalogWithoutNativeAgents(text)).toEqual({ kind: 'unchanged', slugs: ['luna', 'old', 'plain'] })
  })

  it('changes only the entries that need it in a mixed catalog', () => {
    const t = catalogWithoutNativeAgents(catalog([model('luna', { multi_agent_version: 'v1' }), model('sol', { multi_agent_version: 'v2' }), model('plain', {})]))
    expect(t.kind === 'override' && t.changed).toEqual(['sol'])
    if (t.kind !== 'override') return
    const out = JSON.parse(t.json)
    expect(out.models.map((m: { multi_agent_version?: unknown }) => m.multi_agent_version)).toEqual(['v1', 'v1', undefined])
    expect('multi_agent_version' in out.models[2]).toBe(false)
  })

  it('a future version name (v3) is set to v1 as well', () => {
    const t = catalogWithoutNativeAgents(catalog([model('next', { multi_agent_version: 'v3' })]))
    expect(t.kind === 'override' && t.changed).toEqual(['next'])
  })

  it('unexpected shapes return no override', () => {
    for (const text of ['', 'not json', 'null', '[]', '"x"', '{}', '{"models":{}}', '{"models":[1]}', '{"models":[null]}', '{"models":[[]]}']) {
      expect(catalogWithoutNativeAgents(text).kind).toBe('unexpected')
    }
    // An integer JavaScript cannot hold exactly would change on the way through.
    expect(catalogWithoutNativeAgents('{"models":[{"slug":"a","multi_agent_version":"v2","n":12345678901234567890}]}').kind).toBe('unexpected')
  })

  it('handles the real 0.166.0 catalog size quickly', () => {
    const many = catalog(Array.from({ length: 200 }, (_, i) => model(`m${i}`, { multi_agent_version: i % 2 ? 'v2' : 'v1', base_instructions: 'x'.repeat(3000) })))
    const t0 = Date.now()
    const t = catalogWithoutNativeAgents(many)
    expect(Date.now() - t0).toBeLessThan(500)
    expect(t.kind === 'override' && t.changed.length).toBe(100)
  })
})

describe('launch config entries', () => {
  it('model_catalog_json is a TOML basic string, backslashes and quotes escaped', () => {
    expect(modelCatalogEntry('/data/codex/orgai-model-catalog-1.json')).toBe('model_catalog_json="/data/codex/orgai-model-catalog-1.json"')
    expect(modelCatalogEntry('C:\\Users\\a "b"\\x.json')).toBe('model_catalog_json="C:\\\\Users\\\\a \\"b\\"\\\\x.json"')
  })

  it('only the provider lines go to the dump', () => {
    const config = ['skills.bundled.enabled=false', 'features.multi_agent=false', 'model_provider="orgai"', 'model_providers.orgai.base_url="http://l/v1"', 'mcp_servers.x.command="npx"', 'model_reasoning_effort="low"']
    expect(providerConfigLines(config)).toEqual(['model_provider="orgai"', 'model_providers.orgai.base_url="http://l/v1"'])
  })
})

describe('nativeAgentsCatalogConfig', () => {
  let dir = ''
  let home = ''
  let bin = ''
  const v2 = catalog([model('gpt-a', { multi_agent_version: 'v2' }), model('gpt-b', { multi_agent_version: 'v1' })])
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgai-native-catalog-'))
    home = join(dir, 'codex')
    bin = join(dir, 'codex-bin')
    writeFileSync(bin, 'binary v1')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const runner = (out: string | (() => Promise<string>)) => vi.fn<CatalogDumpRunner>(async () => (typeof out === 'string' ? out : out()))
  const input = (run: CatalogDumpRunner, over: Record<string, unknown> = {}) => ({
    binary: { path: bin },
    env: { CODEX_HOME: home, ORGAI_CODEX_API_KEY: 'sk-test' },
    config: ['features.multi_agent=false', 'model_provider="orgai"'],
    expectedHome: home,
    run,
    ...over
  })
  const written = () => (existsSync(home) ? readdirSync(home).filter((n) => n.startsWith(CATALOG_FILE_PREFIX)) : [])

  it('writes the transformed catalog into CODEX_HOME and returns the model_catalog_json entry', async () => {
    const run = runner(v2)
    const r = await nativeAgentsCatalogConfig(input(run))
    expect(r.status).toBe('written')
    if (r.status !== 'written') return
    expect(r.path.startsWith(home)).toBe(true)
    expect(r.config).toEqual([modelCatalogEntry(r.path)])
    expect(JSON.parse(readFileSync(r.path, 'utf8')).models.map((m: { multi_agent_version: string }) => m.multi_agent_version)).toEqual(['v1', 'v1'])
    // The dump ran with the app-server's environment and only the provider lines.
    expect(run).toHaveBeenCalledWith({ path: bin }, ['debug', 'models', '-c', 'model_provider="orgai"'], expect.objectContaining({ CODEX_HOME: home, ORGAI_CODEX_API_KEY: 'sk-test' }), expect.any(Number))
    expect(written()).toHaveLength(1)
  })

  it('reuses the file for an unchanged binary (no second dump)', async () => {
    const run = runner(v2)
    const first = await nativeAgentsCatalogConfig(input(run))
    const second = await nativeAgentsCatalogConfig(input(run))
    expect(second.status).toBe('cached')
    expect(second.config).toEqual(first.config)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('regenerates when the binary changes (size or mtime), when the provider changes and when Codex refreshed its models cache', async () => {
    const run = runner(v2)
    const a = await nativeAgentsCatalogConfig(input(run))
    writeFileSync(bin, 'binary v2, longer')
    const b = await nativeAgentsCatalogConfig(input(run))
    expect(b.status).toBe('written')
    expect(b.config).not.toEqual(a.config)
    const t = new Date(Date.now() - 60_000)
    utimesSync(bin, t, t)
    expect((await nativeAgentsCatalogConfig(input(run))).status).toBe('written')
    expect((await nativeAgentsCatalogConfig(input(run, { config: ['model_provider="other"'] }))).status).toBe('written')
    writeFileSync(join(home, CODEX_MODELS_CACHE_FILE), '{"models":[]}')
    expect((await nativeAgentsCatalogConfig(input(run))).status).toBe('written')
    expect(run).toHaveBeenCalledTimes(5)
  })

  it('regenerates a file older than the maximum age', async () => {
    const run = runner(v2)
    let now = Date.now()
    await nativeAgentsCatalogConfig(input(run, { now: () => now }))
    now += CATALOG_MAX_AGE_MS + 1000
    expect((await nativeAgentsCatalogConfig(input(run, { now: () => now }))).status).toBe('written')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('concurrent launches share one dump', async () => {
    let release!: (s: string) => void
    const run = runner(() => new Promise<string>((r) => (release = r)))
    const p1 = nativeAgentsCatalogConfig(input(run))
    const p2 = nativeAgentsCatalogConfig(input(run))
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    release(v2)
    const [a, b] = await Promise.all([p1, p2])
    expect(a.config).toEqual(b.config)
    expect(a.config).toHaveLength(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  describe('the run\'s model ids', () => {
    it('all known: the override applies, first and cached', async () => {
      const run = runner(v2)
      expect((await nativeAgentsCatalogConfig(input(run, { models: ['gpt-a', 'gpt-b'] }))).status).toBe('written')
      expect((await nativeAgentsCatalogConfig(input(run, { models: ['gpt-a'] }))).status).toBe('cached')
    })

    it('an id the catalog does not know (a proxy model) skips the override, first and cached, and names it', async () => {
      const run = runner(v2)
      const first = await nativeAgentsCatalogConfig(input(run, { models: ['gpt-a', 'litellm/my-model'] }))
      expect(first).toMatchObject({ status: 'skipped', config: [] })
      expect(first.status === 'skipped' && first.reason).toBe("Codex's catalog does not know litellm/my-model")
      expect((await nativeAgentsCatalogConfig(input(run, { models: ['litellm/my-model'] }))).status).toBe('skipped')
      // The file is still written for the binary: another run with known models reuses it.
      expect((await nativeAgentsCatalogConfig(input(run, { models: ['gpt-b'] }))).status).toBe('cached')
      expect(run).toHaveBeenCalledTimes(1)
    })

    it('a new process reads the slugs back from the written file', async () => {
      const run = runner(v2)
      await nativeAgentsCatalogConfig(input(run))
      clearNativeCatalogMemory()
      expect((await nativeAgentsCatalogConfig(input(run, { models: ['gpt-a'] }))).status).toBe('cached')
      clearNativeCatalogMemory()
      expect((await nativeAgentsCatalogConfig(input(run, { models: ['nope'] }))).status).toBe('skipped')
      expect(run).toHaveBeenCalledTimes(1)
    })
  })

  it('nothing to change: no override and no file, and no second dump for the same binary', async () => {
    const run = runner(catalog([model('luna', { multi_agent_version: 'v1' })]))
    const r = await nativeAgentsCatalogConfig(input(run))
    expect(r).toMatchObject({ status: 'unchanged', config: [] })
    expect(written()).toHaveLength(0)
    expect((await nativeAgentsCatalogConfig(input(run))).status).toBe('unchanged')
    expect(run).toHaveBeenCalledTimes(1)
  })

  describe('fails open', () => {
    it('a missing command', async () => {
      const run = vi.fn<CatalogDumpRunner>(async () => {
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      })
      const r = await nativeAgentsCatalogConfig(input(run))
      expect(r).toMatchObject({ status: 'failed', config: [] })
      expect(r.status === 'failed' && r.reason).toContain('ENOENT')
    })

    it('a timeout', async () => {
      const run = vi.fn<CatalogDumpRunner>(async () => {
        throw Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' })
      })
      const r = await nativeAgentsCatalogConfig(input(run))
      expect(r.status === 'failed' && r.reason).toBe('codex debug models timed out')
    })

    it('the real runner times out on a binary that hangs (POSIX)', async () => {
      if (process.platform === 'win32') return
      const hang = join(dir, 'hang.sh')
      writeFileSync(hang, '#!/bin/sh\nsleep 5\n', { mode: 0o755 })
      const t0 = Date.now()
      const r = await nativeAgentsCatalogConfig({ binary: { path: hang }, env: { CODEX_HOME: home, PATH: process.env.PATH }, config: [], timeoutMs: 200 })
      expect(r.status).toBe('failed')
      expect(Date.now() - t0).toBeLessThan(3000)
    })

    it('a non-zero exit, without leaking the command line or stderr into the reason', async () => {
      const run = vi.fn<CatalogDumpRunner>(async () => {
        throw Object.assign(new Error('Command failed: codex debug models -c model_providers.orgai.base_url="http://secret@host"\nstderr'), { code: 2 })
      })
      const r = await nativeAgentsCatalogConfig(input(run))
      expect(r.status === 'failed' && r.reason).toBe('codex debug models failed (2)')
    })

    it('unparseable output and an unexpected shape', async () => {
      for (const out of ['Error: unknown subcommand', '{"data":[]}']) {
        const r = await nativeAgentsCatalogConfig(input(runner(out)))
        expect(r.status).toBe('failed')
        expect(r.status === 'failed' && r.reason).toContain('unexpected catalog')
      }
      expect(written()).toHaveLength(0)
    })

    it('a failed write', async () => {
      const fs = { ...nodeCatalogFs, write: () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }) } }
      const r = await nativeAgentsCatalogConfig(input(runner(v2), { fs }))
      expect(r).toMatchObject({ status: 'failed', config: [] })
      expect(r.status === 'failed' && r.reason).toContain('EACCES')
    })

    it('no OrgAI CODEX_HOME: never writes into the user\'s own Codex home', async () => {
      const run = runner(v2)
      const r = await nativeAgentsCatalogConfig(input(run, { env: { PATH: '/bin' } }))
      expect(r.status).toBe('failed')
      expect(run).not.toHaveBeenCalled()
    })

    it('a binary that is not there', async () => {
      const run = runner(v2)
      const r = await nativeAgentsCatalogConfig(input(run, { binary: { path: join(dir, 'missing') } }))
      expect(r.status).toBe('failed')
      expect(run).not.toHaveBeenCalled()
    })
  })

  describe('a cached file is checked once per process before reuse', () => {
    const cachedPath = async (run: CatalogDumpRunner): Promise<string> => {
      const r = await nativeAgentsCatalogConfig(input(run))
      if (r.status !== 'written') throw new Error(r.status)
      clearNativeCatalogMemory()
      return r.path
    }

    it('a truncated file is regenerated, not handed to Codex', async () => {
      const run = runner(v2)
      const path = await cachedPath(run)
      writeFileSync(path, readFileSync(path, 'utf8').slice(0, 40))
      const r = await nativeAgentsCatalogConfig(input(run))
      expect(r.status).toBe('written')
      expect(run).toHaveBeenCalledTimes(2)
      expect(JSON.parse(readFileSync(path, 'utf8')).models).toHaveLength(2)
    })

    it('a tampered file (a v2 model back, models not a list, a model not an object, empty) is regenerated', async () => {
      for (const tampered of [catalog([model('gpt-a', { multi_agent_version: 'v2' })]), '{"models":{}}', '{"models":[1]}', '{"models":[]}', '[]']) {
        const run = runner(v2)
        const path = await cachedPath(run)
        writeFileSync(path, tampered)
        expect((await nativeAgentsCatalogConfig(input(run))).status).toBe('written')
        expect(run).toHaveBeenCalledTimes(2)
        expect(JSON.parse(readFileSync(path, 'utf8')).models.map((m: { multi_agent_version: string }) => m.multi_agent_version)).toEqual(['v1', 'v1'])
        writeFileSync(bin, `binary ${Math.random()}`)
      }
    })

    it('a valid file is parsed once, then reused on stats alone', async () => {
      const run = runner(v2)
      const path = await cachedPath(run)
      const fs = { ...nodeCatalogFs, read: vi.fn(nodeCatalogFs.read) }
      expect((await nativeAgentsCatalogConfig(input(run, { fs }))).status).toBe('cached')
      expect((await nativeAgentsCatalogConfig(input(run, { fs }))).status).toBe('cached')
      expect(fs.read).toHaveBeenCalledTimes(1)
      expect(fs.read).toHaveBeenCalledWith(path)
      expect(run).toHaveBeenCalledTimes(1)
    })
  })

  describe("only OrgAI's own Codex home", () => {
    it('a foreign CODEX_HOME (an inherited ~/.codex) gets no file and no override', async () => {
      const run = runner(v2)
      const foreign = join(dir, 'user-home', '.codex')
      const r = await nativeAgentsCatalogConfig(input(run, { env: { CODEX_HOME: foreign } }))
      expect(r).toMatchObject({ status: 'failed', config: [] })
      expect(r.status === 'failed' && r.reason).toBe("CODEX_HOME is not OrgAI's own Codex home")
      expect(existsSync(foreign)).toBe(false)
      expect(run).not.toHaveBeenCalled()
    })

    it('an unknown expected home gets no override; the same folder written differently passes', async () => {
      const run = runner(v2)
      const r = await nativeAgentsCatalogConfig(input(run, { expectedHome: undefined }))
      expect(r.status === 'failed' && r.reason).toBe("OrgAI's Codex home is not known to the adapter")
      expect((await nativeAgentsCatalogConfig(input(run, { expectedHome: join(home, '..', 'codex', '.') }))).status).toBe('written')
    })
  })

  describe('a catalog Codex refused to start with', () => {
    it('is kept on disk (another app-server may read it) but never offered again in this process, even regenerated', async () => {
      const run = runner(v2)
      const r = await nativeAgentsCatalogConfig(input(run))
      if (r.status !== 'written') throw new Error(r.status)
      const text = readFileSync(r.path, 'utf8')
      rejectNativeCatalog(r.path)
      expect(isNativeCatalogRejected(r.path)).toBe(true)
      expect(readFileSync(r.path, 'utf8')).toBe(text)
      const again = await nativeAgentsCatalogConfig(input(run))
      expect(again).toMatchObject({ status: 'failed', config: [] })
      expect(again.status === 'failed' && again.reason).toBe('Codex did not start with this catalog earlier in this process')
      expect(run).toHaveBeenCalledTimes(1)
      // A changed binary is a new catalog: offered again.
      writeFileSync(bin, 'binary after an update')
      expect((await nativeAgentsCatalogConfig(input(run))).status).toBe('written')
    })

    it('a new process (memory cleared) validates the kept file again and reuses it', async () => {
      const run = runner(v2)
      const r = await nativeAgentsCatalogConfig(input(run))
      if (r.status !== 'written') throw new Error(r.status)
      rejectNativeCatalog(r.path)
      clearNativeCatalogMemory()
      expect(isNativeCatalogRejected(r.path)).toBe(false)
      expect(await nativeAgentsCatalogConfig(input(run))).toMatchObject({ status: 'cached', path: r.path })
      expect(run).toHaveBeenCalledTimes(1)
    })
  })

  it('deletes stale catalogs of other keys but keeps recent ones', async () => {
    const run = runner(v2)
    const old = join(home, `${CATALOG_FILE_PREFIX}0000000000000000.json`)
    const recent = join(home, `${CATALOG_FILE_PREFIX}1111111111111111.json`)
    await nativeAgentsCatalogConfig(input(run))
    writeFileSync(old, '{}')
    writeFileSync(recent, '{}')
    const t = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    utimesSync(old, t, t)
    writeFileSync(bin, 'changed binary')
    await nativeAgentsCatalogConfig(input(run))
    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })
})

describe('catalogStartFailure (why a start with the override failed)', () => {
  it('transient: the sqlite start race (seen at the lab stub) and SQLite busy texts', () => {
    expect(catalogStartFailure('codex app-server exited (code 1) during initialize: Error: failed to initialize sqlite state runtime')).toBe('transient')
    expect(catalogStartFailure('error: database is locked')).toBe('transient')
    expect(catalogStartFailure('SQLITE_BUSY')).toBe('transient')
  })

  it('catalog: the option named, or a configuration load or parse failure', () => {
    expect(catalogStartFailure('codex app-server exited (code 1) during initialize: Error: failed to parse model_catalog_json /d/codex/orgai-model-catalog-ab.json: missing field `slug`')).toBe('catalog')
    expect(catalogStartFailure('failed to load configuration: No such file or directory (os error 2)')).toBe('catalog')
    expect(catalogStartFailure('Failed to parse config: invalid type')).toBe('catalog')
  })

  it('other: anything else, conservatively (unknown text is not the catalog)', () => {
    expect(catalogStartFailure('codex app-server exited (code 1) during initialize: unknown model catalog field')).toBe('other')
    expect(catalogStartFailure('initialize timed out after 30 s')).toBe('other')
    expect(catalogStartFailure('The Codex CLI is not installed for this platform')).toBe('other')
    expect(catalogStartFailure('')).toBe('other')
  })

  it('a transient match wins over a catalog match', () => {
    expect(catalogStartFailure('failed to initialize sqlite state runtime; failed to load configuration')).toBe('transient')
  })
})
