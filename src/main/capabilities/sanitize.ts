import { createHash } from 'node:crypto'
import { relative, isAbsolute, sep } from 'node:path'
import { CAPABILITY_DESCRIPTION_MAX, type CapabilityKind, type CapabilityOrigin, type McpServerSpec } from '@shared/types'

/**
 * Shared rules for untrusted capability text (config files, SKILL.md, registry and GitHub answers). Pure; never
 * throws. Every string a source puts on a CapabilityItem goes through clampText; every URL through scrubUrl; every
 * stdio arg through isKeyLikeArg.
 */

// C0/C1 controls, soft hyphen, combining grapheme joiner, Arabic letter mark, Mongolian vowel separator, zero-width,
// bidi overrides/isolates, word joiner and invisible operators, BOM, Hangul fillers and tag characters.
const HIDDEN_BASE = '[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0\u{e0000}-\u{e007f}]'
// One-line fields also refuse the Unicode line and paragraph separators: they end a line in a prompt as much as LF does.
// Built with fromCodePoint so neither appears literally in this file; multi-line fields keep allowing them like LF (the
// renderer's mirror covers that multi-line set, which is unchanged).
const HIDDEN_CLASS = HIDDEN_BASE.replace(']', `${String.fromCodePoint(0x2028, 0x2029)}]`)
/** Runs of those characters, global (replace only: a global regex keeps `lastIndex` between `test` calls). */
export const HIDDEN_RUN = new RegExp(`${HIDDEN_CLASS}+`, 'gu')
/** True when the text holds a control, zero-width, bidi or other invisible character. */
export const HIDDEN_CHARS = new RegExp(HIDDEN_CLASS, 'u')
// The same set with tab, line feed and carriage return allowed (the renderer's lib/hiddenChars.ts mirrors it).
const DISGUISE_CHARS = new RegExp(HIDDEN_BASE.replace('\u0000-\u001f', '\u0000-\u0008\u000b\u000c\u000e-\u001f'), 'u')
// Prose (descriptions): controls other than tab / LF / CR, bidi marks, overrides and isolates, zero-width space, word
// joiner and BOM. ZWJ, ZWNJ, soft hyphen and tag characters stay allowed: emoji sequences and Persian or Indic text
// use them, and stored or registry descriptions with them must keep validating.
const PROSE_HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f؜​‎‏‪-‮⁠⁦-⁩﻿]/u

/**
 * The first hidden character in `s` as "U+XXXX", or null. One-line fields (names, URLs, rules, slugs) refuse every
 * control character; `multiline` fields (descriptions, args, env values) allow tab, line feed and carriage return.
 * Non-strings are null. Used by the proposal gates (validateSpec, skillProposalProblem, allow rules).
 */
export function hiddenCharIn(s: unknown, opts: { multiline?: boolean; prose?: boolean } = {}): string | null {
  if (typeof s !== 'string') return null
  const m = (opts.prose ? PROSE_HIDDEN : opts.multiline ? DISGUISE_CHARS : HIDDEN_CHARS).exec(s)
  if (!m) return null
  return `U+${(m[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
}

/** The refusal text for a field holding a hidden character, or null. `field` names it for the model and the user. */
export function hiddenCharProblem(field: string, s: unknown, opts: { multiline?: boolean; prose?: boolean } = {}): string | null {
  const c = hiddenCharIn(s, opts)
  return c ? `${field} contains a hidden character (${c}, a control, zero-width, bidi or other invisible character); remove it.` : null
}

/** One line, control and bidi characters removed, at most `max` chars. Non-strings become ''. */
export function clampText(s: unknown, max = CAPABILITY_DESCRIPTION_MAX): string {
  if (typeof s !== 'string') return ''
  // C0/C1 controls, zero-width and bidi overrides/isolates.
  const cleaned = s.replace(HIDDEN_RUN, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length > max ? `${cleaned.slice(0, Math.max(0, max - 1)).trimEnd()}…` : cleaned
}

// A path start: a drive path, a home-relative path or one starting with a separator (also `//host/share` and the `//`
// of a URL), not preceded by a word character. It runs through spaces up to the next delimiter (a parenthesis, quote,
// backtick, comma, semicolon) or the end of the line, because folder names hold spaces ("OneDrive - Acme Corp",
// "John Smith") and a path cut at the first space would send the rest to a model.
const PATH_START = /(?<![\w.-])(?:[A-Za-z]:[\\/]|~[\\/]|[\\/]{1,2})/g
const PATH_MARK = '[path]'
const HOST_MARK = '[host]'
// Rule words: `Read(` before a relative path stays readable; trailing closers stay so a rule keeps its shape.
const RULE_PREFIX = /^[A-Za-z][A-Za-z0-9_]*\(/
const CLOSER_CHARS = ')"\'`,;'
/** The trailing run of `) " ' ` , ;` of a word ('' when none). A loop from the end: linear, no regex backtracking. */
export function trailingClosers(w: string): string {
  let i = w.length
  while (i > 0 && CLOSER_CHARS.includes(w[i - 1]!)) i--
  return w.slice(i)
}
/** Remove the trailing closers of a word. */
const stripClosers = (w: string): string => w.slice(0, w.length - trailingClosers(w).length)
const isSep = (c: string): boolean => c === '\\' || c === '/'
const isPathDelim = (c: string): boolean => c === '"' || c === "'" || c === '`' || c === ',' || c === ';'

/**
 * Stage 1 of scrubLocalPaths. Once an absolute path starts, it ends at the first of: the end of the line, a `)` that
 * closes no `(` opened inside it (a balanced `(...)` group is part of the name), or a quote, backtick, comma or
 * semicolon. Exception: when a path separator still follows later on the same line, before that `)` or the end of the
 * line, the quote, comma or semicolon does not end it: it runs through the last separator and the name after it (up to
 * the next quote, comma, semicolon, backtick, unbalanced `)` or line end). One left-to-right pass: linear.
 */
function maskAbsolutePaths(s: string): string {
  PATH_START.lastIndex = 0
  let out = ''
  let pos = 0
  for (let m = PATH_START.exec(s); m; m = PATH_START.exec(s)) {
    const start = m.index
    let j = start + m[0].length
    let depth = 0
    let firstDelim = -1
    let lastSep = isSep(m[0][m[0].length - 1]!) ? j - 1 : -1
    for (; j < s.length; j++) {
      const c = s[j]!
      if (c === '\r' || c === '\n') break
      if (c === '(') depth++
      else if (c === ')') {
        if (depth === 0) break
        depth--
      } else if (isPathDelim(c)) {
        if (firstDelim < 0) firstDelim = j
      } else if (isSep(c)) lastSep = j
    }
    const hardEnd = j
    let end = firstDelim < 0 ? hardEnd : firstDelim
    if (firstDelim >= 0 && lastSep > firstDelim) {
      // Keep going through the name after the last separator.
      end = lastSep + 1
      let d = 0
      while (end < hardEnd) {
        const c = s[end]!
        if (isPathDelim(c)) break
        if (c === '(') d++
        else if (c === ')') {
          if (d === 0) break
          d--
        }
        end++
      }
    }
    out += s.slice(pos, start) + PATH_MARK
    pos = end
    PATH_START.lastIndex = Math.max(end, start + 1)
  }
  return out + s.slice(pos)
}
const IPV4 = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w])/g
const IPV6_FULL = /(?<![\w:.])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])/gi
const IPV6_SHORT = /(?<![\w:.])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?(?![\w:])/gi
const USER_AT_HOST = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)*/g
const PRIVATE_HOST = /(?<![\w.-])(?:[\w-]+\.)+(?:internal|local|corp|lan|home|intranet)(?:\.[\w-]+)*(?![\w-])/gi

/**
 * Text for a model on an automatic pass: nothing that locates a file or a machine. Rules, applied in order, chosen to
 * remove too much rather than too little (the result is a hint for a model, never displayed):
 *  1. a drive, UNC, `~/`, `/` or `//` path becomes "[path]" and swallows everything up to the end of the line or a `)`
 *     that closes no `(` of its own (balanced `(UK)` groups are part of the name, so a folder name with spaces and
 *     parentheses is removed whole, and a following word in the same clause goes with it). A quote, backtick, comma or
 *     semicolon ends it too, unless a path separator still follows on the same line before that `)`/line end: then it
 *     runs through the last separator and the name after it (maskAbsolutePaths);
 *  2. then any whitespace-separated word that still holds a `\` or a `/` becomes "[path]" (relative paths, `..\..\x`,
 *     `a/b`; "and/or" and "read/write" go too), keeping a leading `Name(` and trailing closers; "v1.2.3" and "node.js"
 *     are left alone; adjacent "[path]" words collapse into one;
 *  3. `user@host` and e-mail addresses, IPv4 and IPv6 literals and dotted names ending .internal, .local, .corp, .lan,
 *     .home or .intranet become "[host]".
 * Not caught: a bare private host name without dots or a suffix (`db01`), a relative path whose first word has a space
 * ("My Docs/x"), a bare `~`.
 */
export function scrubLocalPaths(s: string): string {
  const stage1 = maskAbsolutePaths(String(s ?? ''))
  const words = stage1.split(/(\s+)/).map((w, i) => {
    if (i % 2 === 1 || w === PATH_MARK || !/[\\/]/.test(w)) return w
    const prefix = RULE_PREFIX.exec(w)?.[0] ?? ''
    const trail = trailingClosers(w.slice(prefix.length))
    return `${prefix}${PATH_MARK}${trail}`
  })
  return words
    .join('')
    .replace(/\[path\](?:\s+\[path\])+/g, PATH_MARK)
    .replace(USER_AT_HOST, HOST_MARK)
    .replace(IPV4, HOST_MARK)
    .replace(IPV6_FULL, HOST_MARK)
    .replace(IPV6_SHORT, HOST_MARK)
    .replace(PRIVATE_HOST, HOST_MARK)
}

const USERINFO_IN_WORD = /([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s]*@/gi
const CREDENTIAL_HEADER = /\bauthorization["']?\s*[:=]\s*["']?(?:(?:bearer|basic|digest|token|negotiate|ntlm)\s+)?[^\s"',;)]+/gi
// Flags whose value is a login, a password or a header: the value is the next word (or inline after `=`).
const VALUE_FLAGS: ReadonlySet<string> = new Set(['-u', '--user', '--username', '--proxy-user', '--auth', '--bearer', '--basic', '--pass', '--pwd', '--passphrase', '--cookie', '--login'])
const HEADER_FLAGS: ReadonlySet<string> = new Set(['-H', '--header', '--headers'])
const REDACTED = '[redacted]'
const QUOTES = '"\''
// What may stand before a word's own text: quotes, parentheses and a rule's `Name(`.
// A PowerShell `$env:` prefix too, so `$env:DB_PASSWORD="x"` is read as `DB_PASSWORD="x"`.
const WORD_LEAD = /^(?:[A-Za-z][A-Za-z0-9_]*\(|\$env:|[("'`])*/i
// A header name that carries a key, written `Name: value` with no -H flag.
const KEY_HEADER_WORD = /^(?:x-)?(?:api[_-]?key|auth[_-]?token|access[_-]?token|secret[_-]?key):$/i

function isValueFlag(name: string): boolean {
  return VALUE_FLAGS.has(name.toLowerCase()) || HEADER_FLAGS.has(name) || isSecretFlag(name)
}

/** `("x` -> `("` + [redacted] + trailing closers: the value goes, the shape around it stays. */
function maskValueWord(word: string, trailOverride?: string): string {
  const lead = /^[("'`]*/.exec(word)?.[0] ?? ''
  const trail = trailOverride ?? trailingClosers(word.slice(lead.length))
  return `${lead}${REDACTED}${trail}`
}

/**
 * Credentials in free text, word by word (the same logic sanitizeArgs applies to stdio args): URL userinfo is removed
 * (`https://user:pass@host` becomes `https://host`); the value after a credential flag is replaced by "[redacted]" (the
 * next word, or the quoted run when it starts with a quote): `--password`, `--token`, `--api-key` and every flag
 * isSecretFlag names, `-u`, `--user`, `--auth`, `--bearer`, `--cookie`, `-H` / `--header` (with an unquoted
 * `Name: Bearer x` too); the value of `--flag=value` and `NAME=value` when the name says key, token, secret or password
 * or the value looks like a key (isKeyLikeArg); a bare key-like word; `Authorization: ...` headers. Idempotent. Not
 * caught: a password after a flag this list does not know, `user:pass@host` without a scheme, a secret that looks like
 * ordinary words.
 */
export function redactCredentialWords(text: string): string {
  const s = String(text ?? '')
    .replace(USERINFO_IN_WORD, '$1')
    .replace(CREDENTIAL_HEADER, 'Authorization: [redacted]')
  const parts = s.split(/(\s+)/)
  // The value starting at word index `at` (`first` is its text, which may start after an `=`): the index of its last word
  // and the closers to keep. A value that opens a quote it does not close runs to the word that closes it (bounded).
  const take = (at: number, first: string, header: boolean): { end: number; trail: string } => {
    const body = first.replace(/^[(]+/, '')
    const q = body[0] !== undefined && QUOTES.includes(body[0]) ? body[0] : ''
    const closes = (w: string): boolean => w.slice(q ? 1 : 0).includes(q)
    if (q && !closes(body)) {
      for (let j = at + 2, n = 0; j < parts.length && n < 40; j += 2, n++) {
        if (parts[j]!.includes(q)) return { end: j, trail: trailingClosers(parts[j]!) }
      }
      return { end: at, trail: '' }
    }
    let end = at
    if (header && !q && /:$/.test(body)) {
      end = at + 2
      if (parts[end] !== undefined && /^(?:bearer|basic|digest|token|negotiate|ntlm)$/i.test(parts[end]!) && parts[end + 2] !== undefined) end += 2
      if (parts[end] === undefined) end = at
    }
    return { end, trail: trailingClosers(parts[end]!) }
  }
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const w = parts[i]!
    if (i % 2 === 1 || w === '') {
      out.push(w)
      continue
    }
    const lead = WORD_LEAD.exec(w)?.[0] ?? ''
    const core = w.slice(lead.length)
    // `--flag=value` and `NAME=value`.
    const eq = /^(-{0,2}[\w.-]{1,60})=([\s\S]*)$/.exec(core)
    if (eq) {
      const [, name, value] = eq as unknown as [string, string, string]
      const valueCore = stripClosers(value)
      if (value !== '' && (isValueFlag(name) || isSecretName(name) || isKeyLikeValue(valueCore) || isKeyLikeArg(`${name}=${valueCore}`))) {
        const t = take(i, value, HEADER_FLAGS.has(name))
        out.push(`${lead}${name}=${REDACTED}${t.trail}`)
        i = t.end
        continue
      }
      out.push(w)
      continue
    }
    // `-u` glued to its value (`-uuser:pass`).
    if (/^-u[^\s=-][^\s]*:/.test(core)) {
      out.push(`${lead}-u${REDACTED}${trailingClosers(core)}`)
      continue
    }
    // A flag whose value is the next word.
    if (/^-{1,2}[\w.-]{1,60}$/.test(core) && isValueFlag(core)) {
      out.push(w)
      const next = parts[i + 2]
      if (next !== undefined && next !== '' && !next.startsWith('-')) {
        const t = take(i + 2, next, HEADER_FLAGS.has(core))
        out.push(parts[i + 1]!, maskValueWord(next, t.trail))
        i = t.end
      }
      continue
    }
    // `X-Api-Key: value` without -H.
    if (KEY_HEADER_WORD.test(core)) {
      const next = parts[i + 2]
      if (next !== undefined && next !== '') {
        const t = take(i + 2, next, false)
        out.push(w, parts[i + 1]!, maskValueWord(next, t.trail))
        i = t.end
        continue
      }
    }
    // A bare key-like word.
    const bare = stripClosers(core)
    if (bare && isKeyLikeValue(bare)) {
      out.push(`${lead}${REDACTED}${core.slice(bare.length)}`)
      continue
    }
    out.push(w)
  }
  return out.join('')
}

/**
 * Origin and path only: no userinfo, query or fragment. Only http(s); anything else (or a parse failure) is null.
 * Path segments that look like keys, or are 20+ chars mixing letters and digits, are replaced with "[redacted]".
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
    .map((seg) => {
      const d = decodeSafe(seg)
      // Long segments that mix letters and digits are usually ids or tokens; short ones stay readable.
      return isKeyLikeValue(d) || (d.length >= 20 && /[A-Za-z]/.test(d) && /\d/.test(d)) ? '[redacted]' : seg
    })
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

// The scheme is bounded (RFC 3986 allows more, no real one needs it): an unbounded run made this quadratic on a long
// line of letters.
const USERINFO_URL = /[a-z][a-z0-9+.-]{0,31}:\/\/[^/\s]*@/i
const CREDENTIAL_WORDS = /(?:bearer|basic|token)\s+\S{6,}/i
const AUTH_HEADER = /authorization\s*[:=]/i

/** An arg that embeds a credential: a URL with userinfo (any scheme), "Bearer xyz", or an Authorization header. */
export function isCredentialArg(arg: string): boolean {
  if (typeof arg !== 'string') return true
  return USERINFO_URL.test(arg) || CREDENTIAL_WORDS.test(arg) || AUTH_HEADER.test(arg)
}

/** `--header`, `-H`, `--auth`, `--bearer` and their `=value` forms (value inline). */
function secretFlagForm(arg: string): { name: string; inline: boolean } | null {
  const m = /^(-H|--header|--headers|--auth|--bearer)(=.*)?$/.exec(arg)
  if (!m) return null
  return { name: m[1]!, inline: m[2] !== undefined }
}

/**
 * Copies stdio args minus anything that carries a credential. A secret flag (--header, -H, --auth, --bearer and the
 * token-named flags) is dropped together with its following value. `notes` name the flags removed, never a value.
 */
export function sanitizeArgs(rawArgs: unknown[]): { kept: string[]; dropped: number; notes: string[] } {
  const kept: string[] = []
  const flags: string[] = []
  let dropped = 0
  let skipNext = false
  for (const a of rawArgs) {
    if (typeof a !== 'string' || a.includes('\0') || a.length > 2000) {
      dropped++
      skipNext = false
      continue
    }
    if (skipNext) {
      skipNext = false
      if (!a.startsWith('-')) {
        dropped++
        continue
      }
    }
    const sf = secretFlagForm(a)
    if (sf) {
      dropped++
      flags.push(sf.name)
      skipNext = !sf.inline
      continue
    }
    if (isKeyLikeArg(a) || isCredentialArg(a) || (/^https?:\/\//i.test(a) && (a.includes('?') || a.includes('#')))) {
      dropped++
      const eq = /^(-{1,2}[\w.-]{1,60})=/.exec(a)
      if (eq) flags.push(eq[1]!)
      continue
    }
    kept.push(a)
    if (isSecretFlag(a)) {
      flags.push(a)
      skipNext = true
    }
  }
  const notes: string[] = []
  if (dropped) {
    const names = [...new Set(flags)].slice(0, 5)
    notes.push(
      `${dropped} argument${dropped === 1 ? '' : 's'} looked like a key or login and ${dropped === 1 ? 'was' : 'were'} left out${names.length ? ` (${names.join(', ')})` : ''}; add ${dropped === 1 ? 'it' : 'them'} as a secret after adding.`
    )
  }
  return { kept, dropped, notes }
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

/** The longest MCP command or address the Team assistant shows for review; anything longer is blocked, never cut. */
export const MCP_TARGET_MAX = 400

/**
 * The exact review text of an MCP server: `NAME=value command arg arg` (the command and any arg or value that is
 * empty or has whitespace or a quote is JSON-quoted so the split stays visible) or `url -H "Name: value"`. Never
 * truncated: over MCP_TARGET_MAX chars, or with control, zero-width, bidi or other invisible characters, it comes back
 * with a blockedReason (the item cannot be applied) and a clamped display string.
 */
export function reviewTarget(spec: Pick<McpServerSpec, 'transport' | 'command' | 'args' | 'url' | 'env' | 'headers'>): { target: string; blockedReason?: string } {
  const quote = (a: string): string => (a === '' || /[\s"']/.test(a) ? JSON.stringify(a) : a)
  const env = Object.entries(spec.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const headers = Object.entries(spec.headers ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const stdio = spec.transport === 'stdio'
  // Values that reach the server (registry env defaults, fixed headers) are shown too: NAME=value before the command,
  // -H "Name: value" after the URL. Local configs never carry values (names only), so their text is just the command.
  const raw = stdio
    ? [...env.flat(), spec.command ?? '', ...(spec.args ?? [])]
    : [spec.url ?? '', ...headers.flat()]
  const full = stdio
    ? [...env.map(([k, v]) => `${k}=${quote(v)}`), quote(spec.command ?? ''), ...(spec.args ?? []).map(quote)].join(' ')
    : [spec.url ?? '', ...headers.map(([k, v]) => `-H ${JSON.stringify(`${k}: ${v}`)}`)].join(' ')
  if (raw.some((part) => HIDDEN_CHARS.test(part))) return { target: clampText(full, MCP_TARGET_MAX), blockedReason: 'The command contains hidden or control characters.' }
  if (full.length > MCP_TARGET_MAX) {
    return { target: clampText(full, MCP_TARGET_MAX), blockedReason: stdio ? 'Command too long to review' : 'Address too long to review' }
  }
  return { target: full }
}

/**
 * sha256 of everything an applied MCP spec would run or connect to: transport, command, args, URL, env and header
 * names (with the non-secret values a registry entry carries) and the secret slot names. Any change to the tail of
 * the command or to a secret slot changes it, so a re-discovery with a different spec no longer matches.
 */
export function mcpSpecDigest(spec: McpServerSpec): string {
  const pairs = (rec: Record<string, string> | undefined): Array<[string, string]> =>
    Object.entries(rec ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return createHash('sha256')
    .update(
      JSON.stringify({
        transport: spec.transport,
        command: spec.command ?? null,
        args: spec.args ?? [],
        url: spec.url ?? null,
        env: pairs(spec.env),
        headers: pairs(spec.headers),
        secretEnv: [...(spec.secretEnv ?? [])].sort(),
        secretHeaders: [...(spec.secretHeaders ?? [])].sort()
      })
    )
    .digest('hex')
}
