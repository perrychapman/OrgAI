import { describe, expect, it } from 'vitest'
import { LITELLM_KEY, mcpLibrarySecretKey, mcpSecretKey } from '../main/store/secrets'
import {
  SECRET_ENV_IGNORED_WARNING,
  SECRET_ENV_REFUSAL,
  collectSecretOverlay,
  isHostlessCommand,
  parseSecretEnvSpec,
  planSecretEnv,
  proxyKeyName,
  scrubSecretEnv
} from './secretOverlay'
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

  it('refuses secret overrides for a command that only reads saved data, with the exact message', () => {
    expect(SECRET_ENV_REFUSAL).toBe(
      "Environment secret overrides (--secret-env / ORGAI_SECRET_*) work only for a command that runs a host. This one only reads saved data. To store a secret, use 'orgai connections set-secret' or 'orgai mcp set-secret'."
    )
  })

  it('scrubs ORGAI_SECRET_* and consumed variables from the environment', () => {
    const env: NodeJS.ProcessEnv = { ORGAI_SECRET_LITELLM_API_KEY: 'a', ORGAI_SECRET_OTHER: 'b', GH: 'c', PATH: '/bin' }
    scrubSecretEnv(env, ['GH'])
    expect(env).toEqual({ PATH: '/bin' })
  })
})

describe('environment secrets per command (cli-standalone-default.md 4.3)', () => {
  const hostless = (line: string): boolean => {
    const [name, ...args] = line.split(' ')
    return isHostlessCommand(name === '' ? undefined : name, args)
  }

  it('the read-only commands never start a host', () => {
    for (const line of ['status', 'runs list', 'runs show R1', 'doctor', 'completions bash', 'projects list', 'projects show p1']) {
      expect(hostless(line), line).toBe(true)
    }
  })

  it('every other command runs a host (bare orgai included)', () => {
    for (const line of ['', 'exec hi', 'resume R1', 'tui', 'init', 'projects create', 'projects set p1', 'usage show', 'secrets status', 'usage csv', 'usage refresh', 'secrets init', 'secrets reset', 'org show', 'connections list', 'mcp list', 'skills list', 'worktrees list']) {
      expect(hostless(line), line).toBe(false)
    }
    // Words after `--` are not subcommands.
    expect(isHostlessCommand('projects', ['--', 'list'])).toBe(false)
  })

  it('planSecretEnv: a host command collects; a read-only one refuses an explicit flag and ignores an ambient variable with a warning', () => {
    const ambient = { ORGAI_SECRET_LITELLM_API_KEY: 'sk' }
    const flag = ['mcp:p:s:env:X=V']
    expect(planSecretEnv(false, { PATH: '/bin' }, [])).toEqual({ collect: false })
    expect(planSecretEnv(false, ambient, [])).toEqual({ collect: true })
    expect(planSecretEnv(false, {}, flag)).toEqual({ collect: true })
    expect(planSecretEnv(true, { PATH: '/bin' }, [])).toEqual({ collect: false })
    expect(planSecretEnv(true, {}, flag)).toEqual({ collect: false, refusal: SECRET_ENV_REFUSAL })
    expect(planSecretEnv(true, ambient, flag)).toEqual({ collect: false, refusal: SECRET_ENV_REFUSAL })
    // An ignored ambient secret is scrubbed but its overlay dropped.
    expect(planSecretEnv(true, ambient, [])).toEqual({ collect: true, dropOverlay: true, warning: SECRET_ENV_IGNORED_WARNING })
    expect(SECRET_ENV_IGNORED_WARNING).toBe('ORGAI_SECRET_* ignored: this command does not start a host')
  })
})
