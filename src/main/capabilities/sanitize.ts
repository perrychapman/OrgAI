import { createHash } from 'node:crypto'
import { relative, isAbsolute, sep } from 'node:path'
import { CAPABILITY_DESCRIPTION_MAX, type CapabilityKind, type CapabilityOrigin } from '@shared/types'

/**
 * Shared rules for untrusted capability text (config files, SKILL.md, registry and GitHub answers). Pure; never
 * throws. Every string a source puts on a CapabilityItem goes through clampText; every URL through scrubUrl; every
 * stdio arg through isKeyLikeArg.
 */

/** One line, control and bidi characters removed, at most `max` chars. Non-strings become ''. */
export function clampText(s: unknown, max = CAPABILITY_DESCRIPTION_MAX): string {
  if (typeof s !== 'string') return ''
  // C0/C1 controls, zero-width and bidi overrides/isolates.
  const cleaned = s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]+/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length > max ? `${cleaned.slice(0, Math.max(0, max - 1)).trimEnd()}…` : cleaned
}

/**
 * Origin and path only: no userinfo, query or fragment. Only http(s); anything else (or a parse failure) is null.
 * Path segments that look like keys are replaced with "[redacted]".
 */
export function scrubUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const path = u.pathname
    .split('/')
    .map((seg) => (isKeyLikeValue(decodeSafe(seg)) ? '[redacted]' : seg))
    .join('/')
  return `${u.protocol}//${u.host}${path}`
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** A value that looks like a credential: sk-/pk-/rk-/ghp_/github_pat_/xox?- prefixes, a JWT, or a long high-entropy token. */
export function isKeyLikeValue(v: string): boolean {
  if (typeof v !== 'string' || v.length < 8) return false
  if (/^(?:sk|pk|rk)-[\w.*-]{3,}/i.test(v)) return true
  if (/^(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}$/.test(v) || /^github_pat_\w{20,}$/.test(v)) return true
  if (/^xox[abposr]-[\w-]{10,}$/.test(v)) return true
  if (/^eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}$/.test(v)) return true
  if (/^Bearer\s/i.test(v)) return true
  // 32+ chars of key alphabet with both letters and digits and no path or word separators.
  return /^[A-Za-z0-9_\-+/=]{32,}$/.test(v) && /[A-Za-z]/.test(v) && /\d/.test(v) && !v.includes('/')
}

/**
 * A stdio arg that must not be copied: a key-like value, a `--token=...` / `--api-key=...` style flag with a value,
 * or a `KEY=value` pair whose name says key, token, secret or password. The flag alone (`--token`) is kept; the
 * value that follows it is dropped by the caller through `isSecretFlag`.
 */
export function isKeyLikeArg(arg: string): boolean {
  if (typeof arg !== 'string') return true
  if (isKeyLikeValue(arg)) return true
  const eq = /^-{0,2}([\w.-]{1,60})=(.+)$/.exec(arg)
  if (eq && (isSecretName(eq[1]!) || isKeyLikeValue(eq[2]!))) return true
  return false
}

/** A flag that takes a secret as its next arg (`--token`, `--api-key`, `-p` is not one). */
export function isSecretFlag(arg: string): boolean {
  return typeof arg === 'string' && /^-{1,2}[\w.-]{1,60}$/.test(arg) && isSecretName(arg.replace(/^-+/, ''))
}

/** A variable or flag name that says api key, token, secret, password, credential or auth. */
export function isSecretName(name: string): boolean {
  return /(api[_-]?key|token|secret|passw(or)?d|credential|auth|private[_-]?key|access[_-]?key)/i.test(name)
}

/** An env var or header name worth keeping as a slot name: printable, at most 128 chars, no '=' or whitespace. */
export function validKeyName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(name)
}

/** `~/...` for paths under home (separators as '/'), else the path itself. */
export function displayPath(abs: string, homeDir: string): string {
  if (typeof abs !== 'string') return ''
  if (homeDir && isAbsolute(abs)) {
    const rel = relative(homeDir, abs)
    if (rel === '') return '~'
    if (!rel.startsWith('..') && !isAbsolute(rel)) return `~/${rel.split(sep).join('/')}`
  }
  return abs.split(sep).join('/')
}

/** `cap-<24 hex>`: stable for the same origin, kind, source key (path, URL, registry name) and name. */
export function capabilityId(origin: CapabilityOrigin, kind: CapabilityKind, sourceKey: string, name: string): string {
  return `cap-${createHash('sha256').update(`${origin}\0${kind}\0${sourceKey}\0${name}`).digest('hex').slice(0, 24)}`
}
