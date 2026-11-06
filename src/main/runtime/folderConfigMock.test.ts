import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, RunEvent } from '@shared/types'
import { applyFolderConfigTrust, folderConfigReview, folderConfigStateOf, initialFolderConfigTrust } from './folderConfigTrust'
import { FOLDER_CONFIG_TOKEN, MOCK_FOLDER_CONFIG_IGNORED, MOCK_FOLDER_CONFIG_LOADED, MockAdapter } from './mock'
import { listRules, settingsLocalPath } from './permissionRules'
import { RunManager } from './runManager'
import { RunStore } from '../store/runs'
import { appRulesFile } from '../store/projectData'
import type { SetupService } from '../setup/service'
import { project as makeProject } from './testHelpers'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

/** The whole path under the real RunManager and the real mock adapter, on a folder shaped like mock-org/with-agents. */
let dir: string
let data: string
let work: string
let events: RunEvent[]
let stored: Project

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-folder-mock-')))
  data = join(dir, 'data')
  work = join(dir, 'work')
  mkdirSync(join(work, '.claude'), { recursive: true })
  writeFileSync(join(work, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash(npm test:*)"]}}\n')
  writeFileSync(join(work, 'AGENTS.md'), 'Be careful.\n')
  events = []
  stored = makeProject({ id: 'p1', path: work, isolateWriters: false })
  stored = { ...stored, folderConfigTrust: initialFolderConfigTrust(stored) }
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function rig(): RunManager {
  const setup = { applyProposal: vi.fn(), markScaffolded: vi.fn(), markArchitectureUpdated: vi.fn(), hiddenContext: vi.fn(() => ''), complete: vi.fn() } as unknown as SetupService
  return new RunManager({ mock: new MockAdapter({ script: { delayMs: 0 } }) }, (e) => void events.push(e), new RunStore(data), setup, () => 100, {
    dataDir: data,
    resolveProject: (id) => (id === stored.id ? stored : null)
  })
}
const texts = (): string[] => events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'text' ? [e.entry.block.text] : []))
const warnings = (): string[] => events.flatMap((e) => (e.type === 'log' && e.level === 'warn' ? [e.message] : []))
const cards = (): Extract<RunEvent, { type: 'permission.request' }>[] => events.filter((e): e is Extract<RunEvent, { type: 'permission.request' }> => e.type === 'permission.request')
const accept = (): void => {
  stored = applyFolderConfigTrust(stored, { trust: true, digest: folderConfigReview(stored).digest }, { rulesFile: appRulesFile(data, stored.id) })
}
async function runOnce(m: RunManager): Promise<string> {
  const run = await m.start({ project: stored, prompt: `Run the tests ${FOLDER_CONFIG_TOKEN}`, kind: 'work' })
  await vi.waitFor(() => expect(texts().some((t) => t === MOCK_FOLDER_CONFIG_LOADED || t === MOCK_FOLDER_CONFIG_IGNORED)).toBe(true), { timeout: 5000 })
  return run.id
}

describe('folder config trust on the mock adapter', () => {
  it('untrusted: the rule is ignored, the command asks, and one warning names the files', async () => {
    const m = rig()
    expect(folderConfigStateOf(stored)).toBe('untrusted')
    const id = await runOnce(m)
    expect(texts()).toContain(MOCK_FOLDER_CONFIG_IGNORED)
    await vi.waitFor(() => expect(cards()).toHaveLength(1), { timeout: 5000 })
    const warned = warnings().filter((w) => w.includes('was not loaded'))
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('.claude/settings.json')
    expect(warned[0]).toContain('AGENTS.md')
    await m.stop(id)
  })

  it('accepted: the rule loads and no card shows; a later edit sends it back to ignored with a warning', async () => {
    accept()
    const m = rig()
    const first = await runOnce(m)
    expect(texts()).toContain(MOCK_FOLDER_CONFIG_LOADED)
    await vi.waitFor(() => expect(texts()).toContain('Mock: the folder-config script is done.'), { timeout: 5000 })
    expect(cards()).toHaveLength(0)
    expect(warnings().filter((w) => w.includes('not loaded'))).toHaveLength(0)
    await m.stop(first)

    // A git pull, or an agent in that run, changes the config.
    writeFileSync(join(work, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash(npm test:*)"]},"hooks":{"Stop":[]}}\n')
    expect(folderConfigStateOf(stored)).toBe('changed')
    events = []
    const second = await runOnce(m)
    expect(texts()).toContain(MOCK_FOLDER_CONFIG_IGNORED)
    expect(warnings().filter((w) => w.includes('changed since you accepted'))).toHaveLength(1)
    await m.stop(second)
  })

  it('"Always allow for project" on a gated project saves to the data folder and leaves the state alone', async () => {
    accept()
    writeFileSync(join(work, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash(npm run lint:*)"]}}\n')
    accept()
    const digest = stored.folderConfigTrust?.digest
    const m = rig()
    const id = await runOnce(m)
    await vi.waitFor(() => expect(cards()).toHaveLength(1), { timeout: 5000 })
    m.decide(id, cards()[0].request.id, { behavior: 'allow', scope: 'project' })
    await vi.waitFor(() => expect(texts()).toContain('Mock: the folder-config script is done.'), { timeout: 5000 })
    expect(listRules({ file: appRulesFile(data, stored.id) }).length).toBeGreaterThan(0)
    expect(existsSync(settingsLocalPath(work))).toBe(false)
    expect(folderConfigStateOf(stored)).toBe('trusted')
    expect(folderConfigReview(stored).digest).toBe(digest)
    await m.stop(id)
  })
})
