import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeRuntimeMissingMessage } from '../../main/runtime/claudeBinary'
import { CODEX_NOT_INSTALLED_MESSAGE, lookupCodexBinary } from '../../main/runtime/codexBinary'
import { ELF, FakeLookupFs } from '../../main/runtime/fakeLookupFs'
import { fakeContext } from '../testing/fakeContext'
import { runtimeCheckProbes, runtimeChecks } from './runtimeChecks'

const real = { ...runtimeCheckProbes }
afterEach(() => Object.assign(runtimeCheckProbes, real))

const run = async () => runtimeChecks({ ctx: fakeContext({ env: {} }).ctx })

describe('doctor runtime checks (cli-standalone 6.1, 6.2)', () => {
  beforeEach(() => {
    runtimeCheckProbes.claude = () => ({ ok: true, path: '/n/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude', source: 'sdk' })
  })

  it('names the Claude runtime and its source, and Codex with its version and source', async () => {
    const fs = new FakeLookupFs({ '/usr/local/bin/codex': ELF })
    runtimeCheckProbes.codexLookup = () => lookupCodexBinary({ env: { PATH: '/usr/local/bin' }, platform: 'linux', arch: 'x64', fs, resolveModule: () => undefined, bundleDir: '/b' })
    runtimeCheckProbes.codexCheck = async (binary) => ({ ok: true, binary, version: '0.166.0' })
    expect(await run()).toEqual([
      { id: 'claude-runtime', status: 'ok', detail: "/n/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude (from the Agent SDK's native package)" },
      { id: 'codex-runtime', status: 'ok', detail: 'Codex 0.166.0 at /usr/local/bin/codex (from PATH)' }
    ])
  })

  it('no Claude runtime fails and names an unused PATH claude; no Codex is ok', async () => {
    runtimeCheckProbes.claude = () => ({ ok: false, reason: claudeRuntimeMissingMessage('linux', 'x64'), pathCandidate: '/usr/bin/claude' })
    runtimeCheckProbes.codexLookup = () => ({ problem: CODEX_NOT_INSTALLED_MESSAGE })
    let checked = false
    runtimeCheckProbes.codexCheck = async (binary) => ((checked = true), { ok: true, binary })
    const [claude, codex] = await run()
    expect(claude).toEqual({
      id: 'claude-runtime',
      status: 'fail',
      detail: `${claudeRuntimeMissingMessage('linux', 'x64')} A claude on PATH at /usr/bin/claude is not used; set ORGAI_CLAUDE_PATH to use it.`
    })
    expect(codex).toMatchObject({ id: 'codex-runtime', status: 'ok' })
    expect(codex!.detail).toMatch(/^Not installed \(only the OpenAI connection needs it\)/)
    expect(checked).toBe(false)
  })

  it('a Codex OrgAI refuses or only warns about is a warning, with where it came from', async () => {
    const binary = { path: '/x/vendor/bin/codex', source: 'path' as const, via: '/usr/local/bin/codex' }
    runtimeCheckProbes.codexLookup = () => ({ binary })
    runtimeCheckProbes.codexCheck = async () => ({ ok: false, binary, version: '0.170.0', reason: 'Codex 0.170.0 is not supported; install @openai/codex@0.166.0' })
    expect((await run())[1]).toEqual({
      id: 'codex-runtime',
      status: 'warn',
      detail: '/x/vendor/bin/codex (from PATH, through /usr/local/bin/codex): Codex 0.170.0 is not supported; install @openai/codex@0.166.0'
    })
    runtimeCheckProbes.codexLookup = () => ({ problem: 'ORGAI_CODEX_PATH must be an absolute path (it is codex).' })
    expect((await run())[1]).toEqual({ id: 'codex-runtime', status: 'warn', detail: 'ORGAI_CODEX_PATH must be an absolute path (it is codex).' })
  })

  it('never throws: a throwing probe becomes a warning', async () => {
    runtimeCheckProbes.claude = () => {
      throw new Error('boom')
    }
    runtimeCheckProbes.codexLookup = () => ({ binary: { path: '/c', source: 'package' } })
    runtimeCheckProbes.codexCheck = async () => {
      throw new Error('bang')
    }
    expect(await run()).toEqual([
      { id: 'claude-runtime', status: 'warn', detail: 'Could not look for the Claude runtime: boom' },
      { id: 'codex-runtime', status: 'warn', detail: 'Could not look for Codex: bang' }
    ])
  })
})
