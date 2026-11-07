import { describe, expect, it } from 'vitest'
import { LITELLM_KEY, mcpLibrarySecretKey, mcpSecretKey } from '../main/store/secrets'
import { SECRET_ENV_REFUSAL, collectSecretOverlay, proxyKeyName, parseSecretEnvSpec, scrubSecretEnv, secretEnvRefusal } from './secretOverlay'
import { CliError } from './types'

const exitOf = (fn: () => unknown): number | undefined => {
  try {
    fn()
  } catch (e) {
    return e instanceof CliError ? e.exitCode : -1
  }
  return undefined
}

describe('secret overlay', () => {
  it('maps ORGAI_SECRET_LITELLM_API_KEY and --secret-env specs to store keys', () => {
    const env = { ORGAI_SECRET_LITELLM_API_KEY: 'sk-1', GH: 'ghp', API: 'k', OTHER: 'x' }
    const { overlay, consumedVars } = collectSecretOverlay(env, ['mcp:p1:gh:env:GITHUB_TOKEN=GH', 'mcplib:lib_1:header:X-Api-Key=API'])
    expect(overlay.get(LITELLM_KEY)).toBe('sk-1')
    expect(overlay.get(mcpSecretKey('p1', 'gh', 'env', 'GITHUB_TOKEN'))).toBe('ghp')
    expect(overlay.get(mcpLibrarySecretKey('lib_1', 'header', 'X-Api-Key'))).toBe('k')
    expect(consumedVars.sort()).toEqual(['API', 'GH', 'ORGAI_SECRET_LITELLM_API_KEY'])
  })

  it('maps ORGAI_SECRET_PROXY_<hex>_API_KEY to that proxy\'s key and consumes the variable', () => {
    const env = { ORGAI_SECRET_PROXY_0A1B2C3D_API_KEY: 'sk-2', ORGAI_SECRET_PROXY_ZZ_API_KEY: 'nope' }
    const { overlay, consumedVars } = collectSecretOverlay(env, [])
    expect(overlay.get('connection:proxy-0a1b2c3d:apiKey')).toBe('sk-2')
    expect(overlay.size).toBe(1)
    expect(consumedVars).toEqual(['ORGAI_SECRET_PROXY_0A1B2C3D_API_KEY'])
    expect(proxyKeyName('litellm')).toBe(LITELLM_KEY)
  })

  it('a bad owner, kind or name is a usage error', () => {
    for (const spec of [
      'mcp:p1:env:X=V',
      'other:p1:s:env:X=V',
      'mcp:p/1:s:env:X=V',
      'mcplib:e:file:X=V',
      'mcp:p:s:env:1BAD=V',
      'mcp:p:s:header:Bad Header=V',
      'mcp:p:s:env:X',
      'mcp:p:s:env:X=not-a-var'
    ]) {
      expect(exitOf(() => parseSecretEnvSpec(spec)), spec).toBe(2)
    }
  })

  it('a missing variable is a usage error', () => {
    expect(exitOf(() => collectSecretOverlay({}, ['mcp:p:s:env:X=NOPE']))).toBe(2)
    expect(exitOf(() => collectSecretOverlay({ NOPE: '' }, ['mcp:p:s:env:X=NOPE']))).toBe(2)
  })

  it('refuses secret overrides outside --host inproc with the exact message', () => {
    expect(SECRET_ENV_REFUSAL).toBe(
      "Environment secret overrides (--secret-env / ORGAI_SECRET_*) can only be used with --host inproc. Use 'orgai connections set-secret' or 'orgai mcp set-secret' to store secrets in the host."
    )
    expect(secretEnvRefusal('auto', { ORGAI_SECRET_X: '1' }, [])).toBe(SECRET_ENV_REFUSAL)
    expect(secretEnvRefusal('daemon', {}, ['mcp:p:s:env:X=V'])).toBe(SECRET_ENV_REFUSAL)
    expect(secretEnvRefusal('inproc', { ORGAI_SECRET_X: '1' }, ['mcp:p:s:env:X=V'])).toBeNull()
    expect(secretEnvRefusal('auto', { PATH: '/bin' }, [])).toBeNull()
  })

  it('scrubs ORGAI_SECRET_* and consumed variables from the environment', () => {
    const env: NodeJS.ProcessEnv = { ORGAI_SECRET_LITELLM_API_KEY: 'a', ORGAI_SECRET_OTHER: 'b', GH: 'c', PATH: '/bin' }
    scrubSecretEnv(env, ['GH'])
    expect(env).toEqual({ PATH: '/bin' })
  })
})
