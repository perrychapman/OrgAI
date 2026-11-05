import { describe, expect, it, vi } from 'vitest'
import { trustSystemCertificates, type CertApi } from './systemCerts'

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

describe('trustSystemCertificates', () => {
  it('sets defaults first, then new system certs, deduplicated', () => {
    const { api, set, logger } = fake(['A', 'B'], ['B', 'C', 'C', 'D'])
    const r = trustSystemCertificates(api, logger)
    expect(set).toHaveBeenCalledWith(['A', 'B', 'C', 'D'])
    expect(r.added).toBe(2)
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()
    expect(String(logger.info.mock.calls[0][0])).not.toContain('C')
  })

  it('leaves defaults alone when the system store adds nothing', () => {
    const { api, set, logger } = fake(['A'], ['A'])
    expect(trustSystemCertificates(api, logger).added).toBe(0)
    expect(set).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('fails open when the system store is empty', () => {
    const { api, set, logger } = fake(['A'], [])
    trustSystemCertificates(api, logger)
    expect(set).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('fails open when reading the system store throws', () => {
    const { api, set, logger } = fake(['A'], new Error('boom'))
    expect(() => trustSystemCertificates(api, logger)).not.toThrow()
    expect(set).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('fails open when setting throws', () => {
    const { api, set, logger } = fake(['A'], ['B'])
    set.mockImplementation(() => {
      throw new Error('nope')
    })
    const r = trustSystemCertificates(api, logger)
    expect(r.added).toBe(0)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('fails open when the API is missing', () => {
    const logger = { info: vi.fn(), warn: vi.fn() }
    expect(trustSystemCertificates({}, logger).skipped).toMatch(/no certificate API/)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('survives a throwing logger', () => {
    const logger = {
      info: () => {
        throw new Error('log')
      },
      warn: () => {
        throw new Error('log')
      }
    }
    expect(() => trustSystemCertificates({}, logger)).not.toThrow()
  })
})
