import { describe, expect, it, vi } from 'vitest'

// ipc.ts needs electron; host/args.ts must not (noElectronImport.test.ts checks that separately).
vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0', isPackaged: false, on: () => {} },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {} },
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false },
  nativeTheme: { on: () => {} },
  Notification: class {},
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} }
}))
vi.mock('../log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, logPath: () => '', logsDir: () => '' }))

const args = await import('./args')
const ipc = await import('../ipc')

/** Every builder the existing ipc*.test.ts files import from './ipc', now living in host/args.ts. */
const MOVED = [
  'ASSIST_INSTRUCTION_MAX_CHARS',
  'CONNECTION_SECRET_MAX_CHARS',
  'CONNECTOR_TOKEN_MAX_CHARS',
  'OVERRIDES_MAX_KEYS',
  'PERMISSION_RULE_MAX_CHARS',
  'PROPOSAL_SECRETS_MAX',
  'capabilityArgs',
  'checkQuickContinue',
  'connectionIdArg',
  'connectionSecretArgs',
  'connectorArgs',
  'effectiveRemoveRuns',
  'harnessProjectFor',
  'knowledgeArgs',
  'mcpAssistArgs',
  'mcpCopyArgs',
  'mcpLibrarySecretArgs',
  'mcpOverridesArgs',
  'mcpSecretArgs',
  'modelsQueryArg',
  'permissionAddRefusal',
  'permissionRuleArgs',
  'presetRemoveArgs',
  'projectRemoveArgs',
  'proposalDecideArgs',
  'quickArgs',
  'removalFacts',
  'settingsSetArgs',
  'skillAssistArgs',
  'templateEngagementArgs',
  'withEffectiveDefault'
] as const

describe('moved argument builders', () => {
  it.each(MOVED)('%s is exported by host/args and re-exported unchanged by ipc', (name) => {
    const fromArgs = (args as Record<string, unknown>)[name]
    expect(fromArgs).toBeDefined()
    expect((ipc as Record<string, unknown>)[name]).toBe(fromArgs)
  })

  it('the desktop-only helpers stay in ipc.ts', () => {
    for (const name of ['PickedFolders', 'PICKED_FOLDERS_PER_SENDER', 'openPathRefusal', 'OPEN_PATH_REFUSAL', 'lstatDirectory']) {
      expect((ipc as Record<string, unknown>)[name], name).toBeDefined()
      expect((args as Record<string, unknown>)[name], name).toBeUndefined()
    }
  })

  it('a moved builder still behaves (smoke)', () => {
    expect(args.connectionIdArg('openai')).toBe('openai')
    expect(() => args.connectionIdArg('toString')).toThrow('Unknown connection')
    expect(args.presetRemoveArgs({ id: 'my-preset', x: 1 })).toEqual({ id: 'my-preset' })
    expect(args.obj(null)).toEqual({})
    expect(() => args.projectIdArg('quick')).toThrow('Project not found')
    expect(() => args.storedIdArg('../x')).toThrow('Project not found')
  })
})
