/**
 * The install channel (Wave 7, docs/design/cli-standalone.md 3.5): `out/cli/install.json` =
 * `{ "channel": "npm" | "app" | "archive", "version", "commit" }`, written by each builder next to the CLI bundle.
 * Absent means 'dev' (a checkout or a hand-made bundle). `--version` and doctor read it.
 *
 * A file that exists but cannot be read or does not validate reads as channel 'dev' with `source: 'invalid'`, which
 * HostLauncher must never treat as a dev checkout (only `source: 'absent'` allows that, 4.1 step 3). Never throws.
 * Electron-free; relative imports only.
 */
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INSTALL_INFO_FILE, type InstallChannel, type InstallInfo } from '../shared/types'

/** The largest install.json read (a builder writes well under 1 KB). */
export const INSTALL_INFO_MAX_BYTES = 4 * 1024

/** Channels a builder may write (absent = 'dev'; 'dev' is never written). */
const WRITTEN_CHANNELS: readonly InstallChannel[] = ['npm', 'app', 'archive']

/** A short printable token: versions like 0.1.6-dev1 and commit shas. */
const TOKEN_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/

export interface ReadInstallInfoOptions {
  /** The folder holding the bundle (out/cli); default this module's folder (the bundle's chunks sit there). */
  bundleDir?: string
  /** File reads (tests). */
  fs?: { size(path: string): number; isFile(path: string): boolean; readText(path: string): string }
}

const realFs: NonNullable<ReadInstallInfoOptions['fs']> = {
  size: (p) => lstatSync(p).size,
  isFile: (p) => lstatSync(p).isFile(),
  readText: (p) => readFileSync(p, 'utf8')
}

function moduleDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return process.cwd()
  }
}

const invalid = (problem: string): InstallInfo => ({ channel: 'dev', source: 'invalid', problem })

/** Reads `<bundleDir>/install.json`. */
export function readInstallInfo(opts: ReadInstallInfoOptions = {}): InstallInfo {
  const fs = opts.fs ?? realFs
  const file = join(opts.bundleDir ?? moduleDir(), INSTALL_INFO_FILE)
  let text: string
  try {
    if (!fs.isFile(file)) return invalid(`${INSTALL_INFO_FILE} is not a regular file`)
    if (fs.size(file) > INSTALL_INFO_MAX_BYTES) return invalid(`${INSTALL_INFO_FILE} is larger than ${INSTALL_INFO_MAX_BYTES} bytes`)
    text = fs.readText(file)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { channel: 'dev', source: 'absent' }
    return invalid(`${INSTALL_INFO_FILE} could not be read: ${(e as Error)?.message ?? String(e)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return invalid(`${INSTALL_INFO_FILE} is not JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid(`${INSTALL_INFO_FILE} is not an object`)
  const { channel, version, commit } = parsed as Record<string, unknown>
  if (typeof channel !== 'string' || !WRITTEN_CHANNELS.includes(channel as InstallChannel)) return invalid(`${INSTALL_INFO_FILE} names no known channel`)
  if (version !== undefined && (typeof version !== 'string' || !TOKEN_RE.test(version))) return invalid(`${INSTALL_INFO_FILE} has a malformed version`)
  if (commit !== undefined && (typeof commit !== 'string' || !TOKEN_RE.test(commit))) return invalid(`${INSTALL_INFO_FILE} has a malformed commit`)
  return {
    channel: channel as InstallChannel,
    ...(typeof version === 'string' ? { version } : {}),
    ...(typeof commit === 'string' ? { commit } : {}),
    source: 'file'
  }
}
