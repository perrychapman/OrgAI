/**
 * `orgai secrets` (Wave 7, cli-standalone.md 5.6, 5.7): secure storage of the orgai command, over
 * the secrets:* host channels. No subcommand ever prints a value: key names, counts, states, paths and reasons only.
 *
 *   secrets status [--probe]                       read: state, scheme, counts, pending, soft deletes, orphans
 *   secrets init [--key-file <path> [--import]]    configure: create the vault (or open a locked one)
 *   secrets reset [--yes]                          configure: move vault.json aside (asks on /dev/tty without --yes)
 *   secrets undelete <key>                         configure: restore one soft-deleted secret
 *   secrets keep-removed [<key>...] [--yes]        configure: keep removed secrets removed (all removed by an older OrgAI when no key)
 *
 * A key file path is resolved against the current folder and must lie outside OrgAI's data folder (5.3.1; the host
 * checks again, canonically). Exit codes: 0 done, 1 refused by the host or not confirmed, 2 bad usage.
 */
import * as path from 'node:path'
import type { SecretsConfirmDeleteResult, SecretsInitInput, SecretsInitResult, SecretsResetResult, SecretsSoftDelete, SecretsStatusResult, SecretsUndeleteResult } from '../../shared/types'
import { formatDateTime } from '../../shared/view/dates'
import { CLI_VAULT_MESSAGES as VAULT_MESSAGES } from '../../main/store/vaultTypes'
import { parseFlags } from '../flags'
import { confirm, runSubcommands, withHost } from '../manage'
import { offlineSecretsChecks } from '../doctor/secretsChecks'
import { ownerSnapshot } from '../runRef'
import { emit, printText, safeLine, warn, type Json } from '../output'
import { CliError, EXIT, type CliContext, type CommandFn } from '../types'
import { CONFIGURE, READ, refusable } from './connections'

const USAGE = 'secrets status [--probe] | init [--key-file <path> [--import]] | reset [--yes] | undelete <key> | keep-removed [<key>...] [--yes]'

/** What `secrets init --key-file` prints with the result (5.3.1: the README and the init output say it). */
export const KEY_FILE_BACKUP_WARNING = 'A backup or sync that holds both the key file and the data folder holds every secret.'

export const STATE_TEXT: Record<SecretsStatusResult['state'], string> = {
  absent: 'not created yet',
  open: 'open',
  locked: 'locked',
  'missing-key': 'key not available',
  'key-mismatch': 'key does not match',
  corrupt: 'damaged'
}

const SCHEME_TEXT: Record<NonNullable<SecretsStatusResult['scheme']>, string> = {
  keychain: 'macOS keychain',
  'dpapi-user': 'Windows DPAPI (this user)',
  'secret-service': 'Secret Service keyring',
  'key-file': 'key file'
}

const LEGACY_TEXT: Record<SecretsStatusResult['legacyFile'], string> = {
  ok: 'present',
  missing: 'missing',
  corrupt: 'damaged (never changed; `orgai secrets reset` starts over)',
  retired: 'retired'
}

function unexpected(positionals: string[], from = 0): void {
  if (positionals.length > from) throw new CliError(`Unexpected argument "${safeLine(positionals[from]).slice(0, 40)}".`, EXIT.usage)
}

/** The scheme words for a status (or "none usable"). */
export function schemeText(s: SecretsStatusResult['scheme']): string {
  return s ? SCHEME_TEXT[s] : 'none usable on this host'
}

function softDeleteJson(d: SecretsSoftDelete): Json {
  return { key: d.key, by: d.by, at: d.at, restorable: d.restorable, ...(d.expiresAt !== undefined ? { expiresAt: d.expiresAt } : {}) }
}

/** The status as JSON: everything SecretsStatusResult carries (it never holds a value). */
export function statusJson(s: SecretsStatusResult): Json {
  return {
    state: s.state,
    scheme: s.scheme,
    ...(s.reason ? { reason: s.reason } : {}),
    ...(s.probe ? { probe: s.probe.ok ? { ok: true } : { ok: false, kind: s.probe.kind, reason: s.probe.reason } } : {}),
    ...(s.keyFile ? { keyFile: s.keyFile } : {}),
    ...(s.vaultId ? { vaultId: s.vaultId } : {}),
    counts: { vault: s.counts.vault, legacy: s.counts.legacy, unreadable: s.counts.unreadable, overlay: s.counts.overlay },
    pendingLegacy: s.pendingLegacy,
    softDeletes: s.softDeletes.map(softDeleteJson),
    orphanedKeys: s.orphanedKeys,
    orphanedVaults: s.orphanedVaults.map((o) => ({ vaultId: o.vaultId, scheme: o.scheme, file: o.file })),
    legacyFile: s.legacyFile,
    canWriteBack: s.canWriteBack
  }
}

const RESTORE_TEXT: Record<SecretsSoftDelete['restorable'], string> = { here: 'restorable', app: 'not restorable here', none: 'nothing kept' }

/** Text lines of a status (names, counts and reasons; never a value). */
export function statusLines(s: SecretsStatusResult): string[] {
  const lines = [`Storage:      ${STATE_TEXT[s.state]} (${schemeText(s.scheme)})`]
  if (s.reason) lines.push(`Why:          ${safeLine(s.reason)}`)
  if (s.probe) lines.push(`Key store:    ${s.probe.ok ? 'reachable' : `${s.probe.kind}: ${safeLine(s.probe.reason)}`}`)
  if (s.keyFile) lines.push(`Key file:     ${safeLine(s.keyFile)}`)
  if (s.vaultId) lines.push(`Storage id:   ${safeLine(s.vaultId)}`)
  const counts = [`${s.counts.vault} in secure storage`, `${s.counts.legacy} in the older secrets.json (${LEGACY_TEXT[s.legacyFile]})`]
  if (s.counts.unreadable) counts.push(`${s.counts.unreadable} unreadable here`)
  if (s.counts.overlay) counts.push(`${s.counts.overlay} from the environment (never saved)`)
  lines.push(`Secrets:      ${counts.join(', ')}`)
  if (s.pendingLegacy) lines.push(`Pending:      ${s.pendingLegacy} ${s.pendingLegacy === 1 ? 'secret' : 'secrets'}: ${VAULT_MESSAGES.pendingLegacy}`)
  if (s.softDeletes.length) {
    lines.push('', 'Removed secrets (restore one with `orgai secrets undelete <key>`, or `orgai secrets keep-removed` to drop them for good):')
    for (const d of s.softDeletes) {
      const who = d.by === 'legacy' ? 'removed by an older OrgAI' : 'deleted'
      const until = d.expiresAt !== undefined ? `, kept until ${formatDateTime(d.expiresAt)}` : ''
      lines.push(`  ${safeLine(d.key)}  ${who} ${formatDateTime(d.at)}, ${RESTORE_TEXT[d.restorable]}${until}`)
    }
  }
  if (s.orphanedKeys) lines.push(`Left in place: ${s.orphanedKeys} ${s.orphanedKeys === 1 ? 'secret' : 'secrets'} that a removal could not delete from here. Remove them again to clear them.`)
  if (s.orphanedVaults.length) {
    lines.push('', 'Keys of secure storage that was moved aside (left in the OS key store; delete them there if no copy needs them):')
    for (const o of s.orphanedVaults) lines.push(`  ${safeLine(o.vaultId)}  ${schemeText(o.scheme)}  ${safeLine(o.file)}`)
  }
  return lines
}

// ---------- status ----------

const runStatus = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { probe: { type: 'boolean' } })
  unexpected(positionals)
  // Beside another orgai: what the files say (vault.json metadata, key names and counts), never a host or a key store.
  if (await ownerSnapshot(ctx)) {
    const checks = offlineSecretsChecks(ctx.paths.dataDir)
    emit(ctx, { snapshot: true, checks }, () => checks.map((c) => `${c.status.padEnd(4)}  ${c.id.padEnd(16)} ${safeLine(c.detail)}`))
    return EXIT.ok
  }
  return withHost(ctx, READ, async (client) => {
    const s = await refusable<SecretsStatusResult>(client, 'secrets:status', [values.probe ? { probe: true } : {}])
    emit(ctx, { secrets: statusJson(s) }, () => statusLines(s))
    return EXIT.ok
  })
}

// ---------- init ----------

/** The --key-file path, absolute, and refused inside OrgAI's data folder (5.3.1; the host checks canonically too). */
export function keyFileArg(ctx: CliContext, raw: string): string {
  if (!raw.trim()) throw new CliError('--key-file needs a path.', EXIT.usage)
  const p = path.resolve(ctx.cwd, raw)
  const root = path.resolve(ctx.paths.userDataDir)
  const rel = path.relative(root, p)
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  if (inside) throw new CliError(`The key file must be outside OrgAI's data folder (${safeLine(root)}); a copy of that folder would hold the key too.`, EXIT.usage)
  return p
}

const INIT_TEXT: Record<SecretsInitResult['action'], string> = {
  created: 'Created secure storage',
  opened: 'Opened secure storage',
  unchanged: 'Secure storage is already open'
}

const runInit = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { 'key-file': { type: 'string' }, import: { type: 'boolean' } })
  unexpected(positionals)
  if (values.import && values['key-file'] === undefined) throw new CliError('--import needs --key-file <path>.', EXIT.usage)
  const input: SecretsInitInput = values['key-file'] !== undefined ? { keyFile: keyFileArg(ctx, values['key-file']), ...(values.import ? { importKeyFile: true } : {}) } : {}
  return withHost(ctx, CONFIGURE, async (client) => {
    const r = await refusable<SecretsInitResult>(client, 'secrets:init', [input])
    const keyFile = r.status.scheme === 'key-file'
    emit(ctx, { action: r.action, secrets: statusJson(r.status), ...(keyFile ? { warning: KEY_FILE_BACKUP_WARNING } : {}) }, () => [
      `${INIT_TEXT[r.action]} (${schemeText(r.status.scheme)}${r.status.keyFile ? `: ${safeLine(r.status.keyFile)}` : ''}).`,
      ...(keyFile ? [KEY_FILE_BACKUP_WARNING] : []),
      ...(r.status.pendingLegacy ? [`${r.status.pendingLegacy} ${r.status.pendingLegacy === 1 ? 'secret' : 'secrets'} ${r.status.pendingLegacy === 1 ? 'is' : 'are'} not readable: ${VAULT_MESSAGES.pendingLegacy}.`] : [])
    ])
    return EXIT.ok
  })
}

// ---------- reset ----------

const runReset = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { yes: { type: 'boolean', short: 'y' } })
  unexpected(positionals)
  // Said before asking (5.6 Reset), in every format: a script passing --yes still sees what it gives up.
  warn(ctx, VAULT_MESSAGES.resetWarning)
  if (!(await confirm(ctx, 'Reset secure storage?', !!values.yes))) {
    printText(ctx, 'Nothing changed.')
    return EXIT.failure
  }
  return withHost(ctx, CONFIGURE, async (client) => {
    const r = await refusable<SecretsResetResult>(client, 'secrets:reset', [{ confirm: true }])
    emit(ctx, { movedTo: r.movedTo, secrets: statusJson(r.status) }, () => [
      r.movedTo ? `Moved secure storage aside to ${safeLine(r.movedTo)} in the data folder.` : 'There was nothing to reset.',
      ...(r.movedTo ? ['Its key stays in the OS key store in case another copy needs it. `orgai secrets status` lists it.'] : []),
      `Storage now: ${STATE_TEXT[r.status.state]} (${schemeText(r.status.scheme)}).`
    ])
    return EXIT.ok
  })
}

// ---------- undelete ----------

const runUndelete = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { positionals } = parseFlags(args, {})
  unexpected(positionals, 1)
  const key = positionals[0]
  if (key === undefined || !key.trim()) throw new CliError('Name the secret: orgai secrets undelete <key> (keys are listed by `orgai secrets status`).', EXIT.usage)
  return withHost(ctx, CONFIGURE, async (client) => {
    const r = await refusable<SecretsUndeleteResult>(client, 'secrets:undelete', [{ key }])
    emit(ctx, { key, restored: r.restored === true, ...(r.reason ? { reason: r.reason } : {}) }, () =>
      r.restored ? `Restored ${safeLine(key)}.` : `Not restored: ${safeLine((r.reason ?? 'nothing is kept for that key').replace(/[.\s]+$/, ''))}. List what can be restored with \`orgai secrets status\`.`
    )
    return r.restored ? EXIT.ok : EXIT.failure
  })
}

// ---------- keep-removed ----------

/** `secrets keep-removed`: the "Keep removed" answer of the app notice, from a terminal. Drops the kept values, so it asks first. */
const runKeepRemoved = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { yes: { type: 'boolean', short: 'y' } })
  const named = [...new Set(positionals.map((k) => k.trim()))].filter((k) => k)
  return withHost(ctx, CONFIGURE, async (client) => {
    let keys = named
    if (!keys.length) {
      const s = await refusable<SecretsStatusResult>(client, 'secrets:status', [{}])
      keys = s.softDeletes.filter((d) => d.by === 'legacy').map((d) => d.key)
    }
    if (!keys.length) {
      emit(ctx, { confirmed: [] }, () => 'No secrets removed by an older OrgAI are waiting.')
      return EXIT.ok
    }
    const what = `${keys.length} removed ${keys.length === 1 ? 'secret' : 'secrets'}`
    if (!(await confirm(ctx, `Keep ${what} removed? They can no longer be restored.`, !!values.yes))) {
      printText(ctx, 'Nothing changed.')
      return EXIT.failure
    }
    const r = await refusable<SecretsConfirmDeleteResult>(client, 'secrets:confirmDelete', [{ keys }])
    emit(ctx, { confirmed: r.confirmed }, () => [
      `Kept ${r.confirmed.length} ${r.confirmed.length === 1 ? 'secret' : 'secrets'} removed.`,
      ...(r.confirmed.length < keys.length ? [`${keys.length - r.confirmed.length} had nothing kept to confirm.`] : [])
    ])
    return EXIT.ok
  })
}

export const runSecrets: CommandFn = (ctx, args) => runSubcommands(ctx, args, { status: runStatus, init: runInit, reset: runReset, undelete: runUndelete, 'keep-removed': runKeepRemoved }, USAGE)
