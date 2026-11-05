/**
 * WP-A: the install channel (install.json, src/cli/installInfo.ts), every `orgai` on PATH in order with channel and
 * version (a shadowed newer one flagged), and the Node floor for system certificates (cli-standalone.md 3.5, 7.1, 8.2).
 *
 * Checks (never 'fail': none of them stops a command from working):
 * - install-channel: channel, version and commit of this CLI's bundle; warn for an unreadable install.json or a version
 *   that differs from the CLI's own.
 * - orgai-on-path: every orgai on PATH in order, each with its channel and version, "this one" marked; warn when a
 *   later one is newer than the one a shell runs.
 * - node-certs: warn when this Node lacks tls.getCACertificates or tls.setDefaultCACertificates (systemCerts.ts
 *   feature-detects them): corporate root certificates are then not trusted.
 */
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { findOrgaiOnPath, orgaiSourceWords, samePathKey, shadowedNewer, type FindOrgaiOptions, type OrgaiOnPathEntry } from '../../main/host/orgaiOnPath'
import type { InstallInfo } from '../../shared/types'
import type { DoctorCheck } from '../commands/doctor'
import { readInstallInfo } from '../installInfo'
import type { DoctorCheckGroup } from './types'

/**
 * The lowest Node of each supported line with both tls APIs (7.1): @types/node 22.20.5 dates setDefaultCACertificates
 * to v22.19.0 (getCACertificates v22.15.0); 24.5.0 is from the Node changelog as remembered (UNVERIFIED).
 * scripts/lib/npmPackage.mjs NODE_FLOOR_22 / NODE_FLOOR_24 publish the same values as engines.node.
 */
export const NODE_CERT_FLOOR = '22.19.0 or 24.5.0'

/** Injectable probes (tests). */
export const installProbes = {
  installInfo: (): InstallInfo => readInstallInfo(),
  nodeVersion: (): string => process.versions.node,
  tls: (): { getCACertificates?: unknown; setDefaultCACertificates?: unknown } => tls as unknown as { getCACertificates?: unknown; setDefaultCACertificates?: unknown },
  bundleDir: (): string => {
    try {
      return dirname(fileURLToPath(import.meta.url))
    } catch {
      return process.cwd()
    }
  },
  realpath: (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  },
  home: (): string => homedir(),
  findOnPath: (opts: FindOrgaiOptions): OrgaiOnPathEntry[] => findOrgaiOnPath(opts)
}

/** install-channel. */
export function installChannelCheck(cliVersion: string): DoctorCheck {
  const info = installProbes.installInfo()
  if (info.source === 'invalid') return { id: 'install-channel', status: 'warn', detail: `channel dev: ${info.problem ?? 'install.json is not valid'}` }
  if (info.source === 'absent') return { id: 'install-channel', status: 'ok', detail: 'channel dev (no install.json: a checkout or a hand-made bundle)' }
  const parts = [`channel ${info.channel}`, info.version ? `version ${info.version}` : undefined, info.commit ? `commit ${info.commit}` : undefined].filter(Boolean).join(', ')
  if (info.version && info.version !== cliVersion) {
    return { id: 'install-channel', status: 'warn', detail: `${parts}; this CLI says it is ${cliVersion} (a bundle and install.json from different builds)` }
  }
  return { id: 'install-channel', status: 'ok', detail: parts }
}

function describeEntry(e: OrgaiOnPathEntry): string {
  const what = e.kind === 'unknown' ? 'not an OrgAI install OrgAI recognises' : `${orgaiSourceWords(e)}${e.version ? ` ${e.version}` : ''}`
  return `${e.path} (${what})`
}

/** orgai-on-path. */
export function orgaiOnPathCheck(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): DoctorCheck {
  const pathList = platform === 'win32' ? (env.Path ?? env.PATH ?? Object.entries(env).find(([k]) => k.toLowerCase() === 'path')?.[1]) : env.PATH
  const entries = installProbes.findOnPath({ platform, pathList, env, home: installProbes.home() })
  const own = samePathKey(platform, installProbes.realpath(installProbes.bundleDir()))
  const isOwn = (e: OrgaiOnPathEntry): boolean => e.bundleDir !== undefined && samePathKey(platform, installProbes.realpath(e.bundleDir)) === own
  if (entries.length === 0) return { id: 'orgai-on-path', status: 'ok', detail: `No orgai on PATH; this one runs from ${installProbes.bundleDir()}` }
  const shadowed = new Set(shadowedNewer(entries))
  const lines = entries.map((e, i) => {
    const notes = [i === 0 ? 'runs' : undefined, isOwn(e) ? 'this one' : undefined, shadowed.has(e) ? 'newer, shadowed' : undefined].filter(Boolean)
    return `${i + 1}. ${describeEntry(e)}${notes.length ? ` [${notes.join(', ')}]` : ''}`
  })
  if (shadowed.size > 0) {
    const first = entries[0]
    const newest = [...shadowed][0]
    return {
      id: 'orgai-on-path',
      status: 'warn',
      detail: `${lines.join('; ')}. ${first.path} runs, but ${newest.path} is newer (${newest.version}); reorder PATH or remove the older one`
    }
  }
  return { id: 'orgai-on-path', status: 'ok', detail: lines.join('; ') }
}

/** node-certs (7.1). */
export function nodeCertsCheck(): DoctorCheck {
  const api = installProbes.tls()
  const v = installProbes.nodeVersion()
  if (typeof api.getCACertificates !== 'function' || typeof api.setDefaultCACertificates !== 'function') {
    return { id: 'node-certs', status: 'warn', detail: `Corporate root certificates will not be trusted on Node ${v}; upgrade to ${NODE_CERT_FLOOR} or later` }
  }
  return { id: 'node-certs', status: 'ok', detail: `Node ${v} can add the system's root certificates` }
}

export const installChecks: DoctorCheckGroup = async ({ ctx }) => {
  const checks: DoctorCheck[] = []
  const safe = (fn: () => DoctorCheck, id: string): void => {
    try {
      checks.push(fn())
    } catch (e) {
      checks.push({ id, status: 'warn', detail: `Could not check: ${(e as Error)?.message ?? String(e)}` })
    }
  }
  safe(() => installChannelCheck(ctx.version), 'install-channel')
  safe(() => orgaiOnPathCheck(ctx.platform, ctx.env), 'orgai-on-path')
  safe(() => nodeCertsCheck(), 'node-certs')
  return checks
}
