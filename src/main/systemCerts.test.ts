import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  childEnvFor,
  parseCertOutput,
  stopSystemCertRead,
  SYSTEM_CERT_MAX_BYTES,
  systemCertTrust,
  trustSystemCertificates,
  type CertApi,
  type CertChild,
  type CertSpawner,
  type TrustResult
} from './systemCerts'

const PEM = (n: string): string => `-----BEGIN CERTIFICATE-----\n${n}\n-----END CERTIFICATE-----\n`

function fake(defaults: string[], system: string[] | Error) {
  const set = vi.fn()
  const api: CertApi = {
    getCACertificates: (type) => {
      if (type === 'system') {
        if (system instanceof Error) throw system
        return system
      }
      return defaults
    },
    setDefaultCACertificates: set
  }
  const logger = { info: vi.fn(), warn: vi.fn() }
  return { api, set, logger }
}

describe('trustSystemCertificates (win32 / linux, synchronous)', () => {
  it('sets defaults first, then new system certs, deduplicated', () => {
    const { api, set, logger } = fake(['A', 'B'], ['B', 'C', 'C', 'D'])
    const r = trustSystemCertificates({ platform: 'win32', api, logger })
    expect(set).toHaveBeenCalledWith(['A', 'B', 'C', 'D'])
    expect(r.added).toBe(2)
    expect(r.state).toBe('applied')
    expect(systemCertTrust()).toBe('applied')
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('counts a store that adds nothing as applied and logs info, not warn', () => {
    const { api, set, logger } = fake(['A'], ['A'])
    const r = trustSystemCertificates({ platform: 'linux', api, logger })
    expect(r.added).toBe(0)
    expect(r.state).toBe('applied')
    expect(set).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledTimes(1)
  })

  it('counts an empty store as applied with an info line', () => {
    const { api, set, logger } = fake(['A'], [])
    trustSystemCertificates({ platform: 'linux', api, logger })
    expect(set).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(systemCertTrust()).toBe('applied')
  })

  it('is unavailable and warns when reading throws', () => {
    const { api, set, logger } = fake(['A'], new Error('boom'))
    expect(() => trustSystemCertificates({ platform: 'win32', api, logger })).not.toThrow()
    expect(set).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(systemCertTrust()).toBe('unavailable')
  })

  it('is unavailable when setting throws', () => {
    const { api, set, logger } = fake(['A'], ['B'])
    set.mockImplementation(() => {
      throw new Error('nope')
    })
    const r = trustSystemCertificates({ platform: 'win32', api, logger })
    expect(r.added).toBe(0)
    expect(r.state).toBe('unavailable')
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('is unavailable when the API is missing, and survives a throwing logger', () => {
    const logger = {
      info: () => {
        throw new Error('log')
      },
      warn: () => {
        throw new Error('log')
      }
    }
    expect(trustSystemCertificates({ platform: 'win32', api: {}, logger }).state).toBe('unavailable')
  })
})

type FakeChild = CertChild & { out: EventEmitter; ev: EventEmitter; killed: number }

function fakeDarwin(defaults: string[] = [PEM('def')]) {
  const set = vi.fn()
  const getCalls: string[] = []
  const api: CertApi = {
    getCACertificates: (type) => {
      getCalls.push(String(type))
      if (type === 'system') throw new Error('must not read the system store on the main thread')
      return defaults
    },
    setDefaultCACertificates: set
  }
  const logger = { info: vi.fn(), warn: vi.fn() }
  const children: FakeChild[] = []
  const spawns: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = []
  const spawner: CertSpawner = (cmd, args, o) => {
    const out = new EventEmitter()
    const ev = new EventEmitter()
    const c: FakeChild = {
      out,
      ev,
      killed: 0,
      stdout: { on: (_e, cb) => out.on('data', cb) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      on: ((e: string, cb: (...a: any[]) => void) => ev.on(e, cb)) as CertChild['on'],
      kill: () => {
        c.killed++
      },
      unref: () => undefined
    }
    children.push(c)
    spawns.push({ cmd, args, env: o.env })
    return c
  }
  const timers: Array<{ cb: () => void; ms: number; cleared: boolean }> = []
  const settled: TrustResult[] = []
  const run = (extra: Partial<Parameters<typeof trustSystemCertificates>[0]> = {}) =>
    trustSystemCertificates({
      platform: 'darwin',
      api,
      logger,
      spawner,
      execPath: '/app/OrgAI',
      env: { HOME: '/Users/x', PATH: '/usr/bin', NODE_OPTIONS: '--evil', ANTHROPIC_API_KEY: 'sk-secret', GITHUB_TOKEN: 't' },
      setTimer: (cb, ms) => {
        const t = { cb, ms, cleared: false }
        timers.push(t)
        return t
      },
      clearTimer: (t) => {
        ;(t as { cleared: boolean }).cleared = true
      },
      onSettled: (r) => settled.push(r),
      ...extra
    })
  return { api, set, logger, children, spawns, timers, settled, run, getCalls }
}

describe('trustSystemCertificates (darwin, child process)', () => {
  it('returns pending, spawns the executable as node with a minimal env, and applies the child output on close', () => {
    const d = fakeDarwin([PEM('def')])
    const r = d.run()
    expect(r.state).toBe('pending')
    expect(systemCertTrust()).toBe('pending')
    expect(d.set).not.toHaveBeenCalled()
    expect(d.spawns[0].cmd).toBe('/app/OrgAI')
    expect(d.spawns[0].args[0]).toBe('-e')
    expect(d.spawns[0].env).toEqual({ HOME: '/Users/x', PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' })
    expect(d.timers[0].ms).toBe(30_000)
    const out = JSON.stringify([PEM('def'), PEM('corp')])
    d.children[0].out.emit('data', Buffer.from(out.slice(0, 20)))
    d.children[0].out.emit('data', Buffer.from(out.slice(20)))
    d.children[0].ev.emit('close', 0, null)
    expect(d.set).toHaveBeenCalledWith([PEM('def'), PEM('corp')])
    expect(systemCertTrust()).toBe('applied')
    expect(d.settled[0].added).toBe(1)
    expect(d.timers[0].cleared).toBe(true)
    expect(d.logger.warn).not.toHaveBeenCalled()
    expect(d.getCalls).toEqual(['default'])
  })

  it('applied with an info line when the child store adds nothing', () => {
    const d = fakeDarwin([PEM('def')])
    d.run()
    d.children[0].out.emit('data', JSON.stringify([PEM('def')]))
    d.children[0].ev.emit('close', 0, null)
    expect(d.set).not.toHaveBeenCalled()
    expect(systemCertTrust()).toBe('applied')
    expect(d.logger.warn).not.toHaveBeenCalled()
    expect(d.logger.info).toHaveBeenCalledTimes(1)
  })

  it('kills a child that outlives the timeout and fails open with one warn', () => {
    const d = fakeDarwin()
    d.run({ timeoutMs: 5 })
    expect(d.timers[0].ms).toBe(5)
    d.timers[0].cb()
    expect(d.children[0].killed).toBe(1)
    expect(systemCertTrust()).toBe('unavailable')
    expect(d.set).not.toHaveBeenCalled()
    expect(d.logger.warn).toHaveBeenCalledTimes(1)
    // a late close changes nothing
    d.children[0].out.emit('data', JSON.stringify([PEM('late')]))
    d.children[0].ev.emit('close', 0, null)
    expect(d.set).not.toHaveBeenCalled()
    expect(d.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('fails open when the spawn throws or the child errors', () => {
    const d = fakeDarwin()
    d.run({
      spawner: () => {
        throw new Error('ENOENT')
      }
    })
    expect(systemCertTrust()).toBe('unavailable')
    expect(d.logger.warn).toHaveBeenCalledTimes(1)
    const e = fakeDarwin()
    e.run()
    e.children[0].ev.emit('error', new Error('spawn EACCES'))
    expect(systemCertTrust()).toBe('unavailable')
    expect(e.logger.warn).toHaveBeenCalledTimes(1)
    expect(e.set).not.toHaveBeenCalled()
  })

  it('fails open on a non-zero exit', () => {
    const d = fakeDarwin()
    d.run()
    d.children[0].out.emit('data', JSON.stringify([PEM('x')]))
    d.children[0].ev.emit('close', 1, null)
    expect(systemCertTrust()).toBe('unavailable')
    expect(d.set).not.toHaveBeenCalled()
    expect(d.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('kills the child and fails open when the output passes the cap', () => {
    const d = fakeDarwin()
    d.run({ maxBytes: 10 })
    d.children[0].out.emit('data', Buffer.alloc(11, 65))
    expect(d.children[0].killed).toBe(1)
    expect(systemCertTrust()).toBe('unavailable')
    expect(d.logger.warn).toHaveBeenCalledTimes(1)
    expect(SYSTEM_CERT_MAX_BYTES).toBe(8 * 1024 * 1024)
  })

  it('fails open on malformed output', () => {
    for (const bad of ['', 'not json', '{"a":1}', '[1,2]', JSON.stringify(['hello']), JSON.stringify([PEM('ok'), 5])]) {
      const d = fakeDarwin()
      d.run()
      d.children[0].out.emit('data', bad)
      d.children[0].ev.emit('close', 0, null)
      expect(systemCertTrust()).toBe('unavailable')
      expect(d.set).not.toHaveBeenCalled()
      expect(d.logger.warn).toHaveBeenCalledTimes(1)
    }
  })

  it('kills the child on quit and cannot hold quit up', () => {
    const d = fakeDarwin()
    d.run()
    stopSystemCertRead()
    expect(d.children[0].killed).toBe(1)
    expect(systemCertTrust()).toBe('unavailable')
    expect(d.timers[0].cleared).toBe(true)
    expect(() => stopSystemCertRead()).not.toThrow()
  })

  it('never throws, even when the logger and callback do', () => {
    const d = fakeDarwin()
    const boom = () => {
      throw new Error('x')
    }
    expect(() => {
      d.run({ logger: { info: boom, warn: boom }, onSettled: boom })
      d.children[0].ev.emit('close', 2, null)
    }).not.toThrow()
  })
})

describe('helpers', () => {
  it('childEnvFor keeps only what the read needs', () => {
    expect(childEnvFor({ HOME: '/h', PATH: 'p', NODE_OPTIONS: 'x', SECRET: 's', TMPDIR: '' })).toEqual({ HOME: '/h', PATH: 'p', ELECTRON_RUN_AS_NODE: '1' })
  })
  it('parseCertOutput accepts only an array of PEM strings', () => {
    expect(parseCertOutput(JSON.stringify([PEM('a')]))).toEqual([PEM('a')])
    expect(parseCertOutput('[]')).toEqual([])
    expect(parseCertOutput('[""]')).toBeNull()
  })
})
