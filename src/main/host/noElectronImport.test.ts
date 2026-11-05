import { describe, expect, it, vi } from 'vitest'

// Any module that loads electron, directly or transitively, fails to import (cli-spec 3.1.1: the host's stores,
// services and runtime must boot in plain Node for `--host inproc`).
vi.mock('electron', () => {
  throw new Error('electron must not be imported outside the Electron entry')
})

const PURE_NODE_MODULES = [
  '../log',
  './ownership',
  './processInfo',
  './identity',
  './runtimeEnv',
  './events',
  './registry',
  './params',
  './dispatcher',
  './activity',
  './args',
  './bootstrap',
  './jsonCodec',
  './types',
  './protocol',
  './socketServer',
  './runSubscriptions',
  './eventJournal',
  './outboundQueue',
  './bulkBudget',
  './peerCheck',
  '../store/projects',
  '../store/settings',
  '../store/runs',
  '../store/secrets',
  '../store/mcpLibrary',
  '../store/knowledge',
  '../runtime/runManager',
  '../runtime/claude',
  '../runtime/codex',
  '../runtime/mock',
  '../mcp/service',
  '../connections/service',
  '../skills/service',
  '../kit/service',
  '../setup/service',
  '../capabilities/service',
  '../quick/quickRuns',
  '../maintenance',
  '../usageMonitor',
  '../quitGate'
]

describe('host modules load without electron', () => {
  it.each(PURE_NODE_MODULES)('%s', async (path) => {
    await expect(import(path)).resolves.toBeDefined()
  })

  it('the mock really refuses electron (electronLogHooks imports it)', async () => {
    await expect(import('../electronLogHooks')).rejects.toThrow()
  })
})
