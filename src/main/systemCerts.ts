import tls from 'node:tls'
import { log } from './log'

/** The parts of node:tls used here (Node 24.5+); injectable for tests. Each may be missing on an older runtime. */
export interface CertApi {
  getCACertificates?: (type?: 'default' | 'system' | 'bundled' | 'extra') => string[]
  setDefaultCACertificates?: (certs: string[]) => void
}

export interface CertLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

export interface TrustResult {
  /** Certificates added on top of the defaults. */
  added: number
  /** Set when the defaults were left untouched. */
  skipped?: string
  elapsedMs: number
}

/**
 * Main-process fetches (undici) trust only Node's bundled roots, so a machine behind an inspecting corporate CA
 * installed in the OS store fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY (issue #16). This sets the default CA list
 * to the defaults (bundled roots plus NODE_EXTRA_CA_CERTS) followed by the system store's extra certificates.
 * Synchronous, never throws, never shrinks trust: any failure leaves the defaults as they were. Logs counts and
 * timing only, never certificate contents.
 */
export function trustSystemCertificates(api: CertApi = tls as unknown as CertApi, logger: CertLogger = log, now: () => number = () => performance.now()): TrustResult {
  const start = now()
  const done = (added: number, skipped?: string): TrustResult => {
    const elapsedMs = Math.round((now() - start) * 10) / 10
    try {
      if (skipped) logger.warn(`System certificates not added: ${skipped} (${elapsedMs} ms)`)
      else logger.info(`System certificates: ${added} added to the default trust list in ${elapsedMs} ms`)
    } catch {
      /* logging must not break boot */
    }
    return { added, skipped, elapsedMs }
  }
  try {
    if (typeof api.getCACertificates !== 'function' || typeof api.setDefaultCACertificates !== 'function') {
      return done(0, 'this runtime has no certificate API')
    }
    const defaults = api.getCACertificates('default')
    const system = api.getCACertificates('system')
    if (!Array.isArray(defaults) || !Array.isArray(system) || system.length === 0) {
      return done(0, 'the system store returned no certificates')
    }
    const seen = new Set<string>()
    const merged: string[] = []
    for (const cert of [...defaults, ...system]) {
      if (typeof cert !== 'string' || seen.has(cert)) continue
      seen.add(cert)
      merged.push(cert)
    }
    const added = merged.length - new Set(defaults.filter((c) => typeof c === 'string')).size
    if (added <= 0) return done(0, 'the system store adds nothing to the defaults')
    api.setDefaultCACertificates(merged)
    return done(added)
  } catch (e) {
    return done(0, `could not read or set certificates (${e instanceof Error ? e.message.slice(0, 120) : 'unknown error'})`)
  }
}
