import { describe, expect, it } from 'vitest'
import { custodianEnvFor } from './env'

const host = {
  HOME: '/Users/me',
  USER: 'me',
  LOGNAME: 'me',
  TMPDIR: '/var/folders/x',
  PATH: '/usr/bin:/bin',
  SHELL: '/bin/zsh',
  NODE_OPTIONS: '--require /evil.js',
  ORGAI_VAULT_KEY_FILE: '/Users/me/key',
  ORGAI_SECRET_LITELLM: 'sk-secret',
  ANTHROPIC_API_KEY: 'sk-ant',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  XDG_RUNTIME_DIR: '/run/user/1000',
  DISPLAY: ':0'
}

describe('custodianEnvFor (cli-standalone.md 5.3 allowlists)', () => {
  it('keeps only the keychain allowlist on macOS', () => {
    expect(custodianEnvFor('keychain', host, 'darwin')).toEqual({
      HOME: '/Users/me',
      USER: 'me',
      LOGNAME: 'me',
      TMPDIR: '/var/folders/x',
      PATH: '/usr/bin:/bin'
    })
  })

  it('keeps the Secret Service variables on Linux and nothing else', () => {
    const env = custodianEnvFor('secret-service', host, 'linux')
    expect(Object.keys(env).sort()).toEqual(['DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'HOME', 'LOGNAME', 'PATH', 'USER', 'XDG_RUNTIME_DIR'])
  })

  it('never passes NODE_OPTIONS or ORGAI_* in any scheme or platform', () => {
    for (const scheme of ['keychain', 'dpapi-user', 'secret-service', 'key-file'] as const) {
      for (const platform of ['darwin', 'linux', 'win32'] as const) {
        const env = custodianEnvFor(scheme, { ...host, node_options: 'x', Orgai_Secret_X: 'y' }, platform)
        for (const k of Object.keys(env)) {
          expect(k.toUpperCase()).not.toBe('NODE_OPTIONS')
          expect(k.toUpperCase().startsWith('ORGAI_')).toBe(false)
        }
        expect(Object.values(env)).not.toContain('sk-secret')
        expect(Object.values(env)).not.toContain('sk-ant')
      }
    }
  })

  it('matches names case-insensitively on Windows, keeping the allowlist spelling (Path survives)', () => {
    const env = custodianEnvFor(
      'dpapi-user',
      { PATH: 'C:\\Windows\\System32', SYSTEMROOT: 'C:\\Windows', windir: 'C:\\Windows', userprofile: 'C:\\Users\\me', NODE_OPTIONS: 'x' },
      'win32'
    )
    expect(env).toEqual({ Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me' })
  })

  it('matches exactly elsewhere', () => {
    expect(custodianEnvFor('keychain', { path: '/bin', Home: '/x' }, 'darwin')).toEqual({})
  })

  it('drops empty values and values with NUL', () => {
    expect(custodianEnvFor('keychain', { HOME: '', PATH: 'a\0b', USER: 'me' }, 'darwin')).toEqual({ USER: 'me' })
  })

  it('gives key-file no environment outside Windows, and only the system and temp folders on Windows', () => {
    expect(custodianEnvFor('key-file', host, 'darwin')).toEqual({})
    expect(custodianEnvFor('key-file', { SystemRoot: 'C:\\Windows', TEMP: 'C:\\t', Path: 'C:\\x', USERPROFILE: 'C:\\u' }, 'win32')).toEqual({
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\t'
    })
  })
})
