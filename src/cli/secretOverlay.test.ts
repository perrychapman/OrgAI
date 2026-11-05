import { describe, expect, it } from 'vitest'
import { LITELLM_KEY, mcpLibrarySecretKey, mcpSecretKey } from '../main/store/secrets'
import {
  SECRET_ENV_IGNORED_WARNING,
  SECRET_ENV_REFUSAL,
  collectSecretOverlay,
  liveHostSecretAnswer,
  parseSecretEnvSpec,
  planSecretEnv,
  scrubSecretEnv,
  secretEnvCommandClass,
  secretEnvRefusal
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

describe('environment secrets per command (cli-standalone.md 4.1, round 6 item 8)', () => {
  const cls = (line: string): string => {
    const [name, ...args] = line.split(' ')
    return secretEnvCommandClass(name === '' ? undefined : name, args)
  }

  it('commands that never run their own in-process host', () => {
    for (const line of ['status', 'runs list', 'runs show R1', 'runs stop R1', 'runs send R1 hi', 'runs interrupt R1', 'watch', 'inbox', 'decide d1', 'daemon start', 'daemon restart', 'daemon stop', 'daemon logs', 'app', 'doctor', 'completions bash', 'terminal-access on']) {
      expect(cls(line), line).toBe('never-inproc')
    }
  })

  it('projects list|show: hostless in the spec, host-backed here (listing)', () => {
    for (const line of ['projects list', 'projects show p1', 'projects list --json']) expect(cls(line), line).toBe('listing')
    expect(cls('projects create')).toBe('host')
  })

  it('the secret-using table: runs, the Architect, assistants, credential probes and model calls', () => {
    for (const line of [
      '',
      'exec hi',
      'resume R1',
      'resume --exec R1',
      'tui',
      'attach R1',
      'init',
      'init ./x --name y',
      'mcp assist',
      'skills assist --library',
      'org retro R1',
      'connections test anthropic',
      'connections connect openai',
      'models refresh',
      'mcp test gh',
      'mcp library test lib_1',
      'org draft',
      'team review',
      'team recommend',
      'org review',
      'org recommend',
      'skills evaluate',
      'usage refresh'
    ]) {
      expect(cls(line), line).toBe('secret-using')
    }
  })

  it('every other host-backed command', () => {
    for (const line of ['init --skip-architect', 'projects create', 'projects set p1', 'org show', 'org discover', 'team roles', 'mcp list', 'mcp library list', 'mcp set-secret gh', 'skills list', 'connections list', 'connections set-secret litellm', 'models list', 'usage', 'usage csv', 'kit export', 'knowledge list', 'notes list', 'permissions list', 'worktrees list']) {
      expect(cls(line), line).toBe('host')
    }
    // Words after `--` are not subcommands.
    expect(secretEnvCommandClass('init', ['--', '--skip-architect'])).toBe('secret-using')
    expect(secretEnvCommandClass('usage', ['--', 'refresh'])).toBe('host')
  })

  it('planSecretEnv: inproc always collects; daemon refuses; auto refuses an explicit flag on never-inproc commands and warns about an ambient one', () => {
    const ambient = { ORGAI_SECRET_LITELLM_API_KEY: 'sk' }
    const flag = ['mcp:p:s:env:X=V']
    expect(planSecretEnv('inproc', 'never-inproc', ambient, flag)).toEqual({ collect: true })
    expect(planSecretEnv('inproc', 'host', {}, [])).toEqual({ collect: true })
    expect(planSecretEnv('auto', 'secret-using', { PATH: '/bin' }, [])).toEqual({ collect: false })
    expect(planSecretEnv('daemon', 'host', ambient, [])).toEqual({ collect: false, refusal: SECRET_ENV_REFUSAL })
    expect(planSecretEnv('daemon', 'never-inproc', {}, flag)).toEqual({ collect: false, refusal: SECRET_ENV_REFUSAL })
    expect(planSecretEnv('auto', 'never-inproc', {}, flag)).toEqual({ collect: false, refusal: SECRET_ENV_REFUSAL })
    expect(planSecretEnv('auto', 'never-inproc', ambient, flag)).toEqual({ collect: false, refusal: SECRET_ENV_REFUSAL })
    // An ignored ambient secret is scrubbed but its overlay dropped (review round 1: daemon start --foreground).
    expect(planSecretEnv('auto', 'never-inproc', ambient, [])).toEqual({ collect: true, dropOverlay: true, warning: SECRET_ENV_IGNORED_WARNING })
    // listing: explicit refused, ambient like 'host'.
    expect(planSecretEnv('auto', 'listing', {}, flag)).toEqual({ collect: false, refusal: SECRET_ENV_REFUSAL })
    expect(planSecretEnv('auto', 'listing', ambient, [])).toEqual({ collect: true, use: { explicit: false, ambient: true, usesSecrets: false } })
    expect(planSecretEnv('inproc', 'listing', ambient, flag)).toEqual({ collect: true })
    expect(planSecretEnv('auto', 'host', ambient, [])).toEqual({ collect: true, use: { explicit: false, ambient: true, usesSecrets: false } })
    expect(planSecretEnv('auto', 'secret-using', {}, flag)).toEqual({ collect: true, use: { explicit: true, ambient: false, usesSecrets: true } })
  })

  it('liveHostSecretAnswer: explicit is refused, ambient refused only by secret-using commands, else a warning', () => {
    expect(liveHostSecretAnswer(undefined)).toBeNull()
    expect(liveHostSecretAnswer({ explicit: false, ambient: false, usesSecrets: true })).toBeNull()
    expect(liveHostSecretAnswer({ explicit: true, ambient: false, usesSecrets: false })).toBe(SECRET_ENV_REFUSAL)
    expect(liveHostSecretAnswer({ explicit: false, ambient: true, usesSecrets: true })).toBe(SECRET_ENV_REFUSAL)
    expect(liveHostSecretAnswer({ explicit: false, ambient: true, usesSecrets: false })).toBe('warn')
    expect(SECRET_ENV_IGNORED_WARNING).toBe('ORGAI_SECRET_* ignored: a running OrgAI host keeps its own secrets')
  })
})
