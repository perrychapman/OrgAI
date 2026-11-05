import { describe, expect, it, vi } from 'vitest'

// The CLI is plain Node (cli-spec 3.1.1, 7): any module that loads electron, directly or transitively, fails here.
vi.mock('electron', () => {
  throw new Error('electron must not be imported by the CLI')
})

const CLI_MODULES = [
  './index',
  './context',
  './inprocHost',
  './secretOverlay',
  './openUrl',
  './flags',
  './commandTable',
  './client/hostClient',
  './client/locate',
  './client/resolveProject',
  './client/readOnlyStore',
  './client/launcher',
  './commands/status',
  './commands/runs',
  './commands/watch',
  './commands/inbox',
  './commands/daemon',
  './commands/app',
  './commands/doctor',
  './commands/completions'
]

describe('CLI modules load without electron', () => {
  it.each(CLI_MODULES)('%s', async (path) => {
    await expect(import(path)).resolves.toBeDefined()
  })
})
