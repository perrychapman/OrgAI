/**
 * `orgai mcp connectors list | add | set-token`, `orgai mcp presets list | add | remove` and `orgai mcp search`
 * (cli-spec 6.3). Connector, preset and registry text is untrusted: every word goes through safeLine in text output.
 */
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { connectorEase, connectorMatches } from '../../../shared/connectors'
import type { ConnectorEase, ConnectorInfo, McpLibraryInfo, McpRegistryEntry, McpRegistrySearchResult, UserConnectorDef } from '../../../shared/types'
import { parseFlags } from '../../flags'
import { confirm, hostCall, readSecretValue, readStdinText, runSubcommands, withHost } from '../../manage'
import { emit, safeLine, styleFor, table, termWidth } from '../../output'
import { CliError, EXIT, type CliContext } from '../../types'
import { CONFIGURE, READ, checkKebabId, noMore } from './common'

const usage = (m: string): CliError => new CliError(m, EXIT.usage)

/** The gallery's ease words (renderer lib/connectors.ts EASE_BADGE). */
export const EASE_WORD: Record<ConnectorEase, string> = {
  signIn: 'Sign in',
  none: 'No sign-in needed',
  token: 'Paste a token',
  ownApp: 'Needs your own app'
}

const STATE_WORD: Record<ConnectorInfo['state'], string> = { available: 'available', needsSetup: 'not signed in', connected: 'connected', error: 'error' }

/** The most a preset file may be. */
export const PRESET_FILE_MAX_BYTES = 256 * 1024

export const CONNECTORS_USAGE = 'mcp connectors list [--filter <word>] | add <id> [--variant <v>] | set-token <id> (--from-env <VAR> | --stdin | --clear)'
export const PRESETS_USAGE = 'mcp presets list | add --file <path|-> | remove <id> [--yes]'

function infoEase(c: ConnectorInfo): ConnectorEase {
  try {
    return connectorEase(c.connector, c.variant)
  } catch {
    return 'token'
  }
}

/** Does this connector match a --filter word: name, aliases, vendor, description, category, ease or state words. */
export function connectorFilter(c: ConnectorInfo, word: string): boolean {
  const w = word.trim().toLowerCase()
  if (!w) return true
  if (connectorMatches(c.connector, w)) return true
  if (c.connector.id.includes(w)) return true
  if (EASE_WORD[infoEase(c)].toLowerCase().includes(w)) return true
  if (STATE_WORD[c.state].includes(w)) return true
  return (w === 'custom' && !!c.custom) || false
}

function connectorJson(c: ConnectorInfo): Record<string, unknown> {
  return {
    id: c.connector.id,
    name: c.connector.name,
    vendor: c.connector.vendor,
    category: c.connector.category,
    description: c.connector.description,
    ease: infoEase(c),
    state: c.state,
    ...(c.variant ? { variant: c.variant } : {}),
    variants: c.connector.variants.map((v) => ({ id: v.id, label: v.label, readOnly: v.readOnly, auth: v.auth.kind })),
    defaultVariant: c.connector.defaultVariant,
    ...(c.library ? { libraryId: c.library.entry.id } : {}),
    ...(c.connectedAt ? { connectedAt: c.connectedAt } : {}),
    ...(c.custom ? { custom: true } : {})
  }
}

async function connectorsList(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { filter: { type: 'string' } })
  noMore(positionals)
  return withHost(ctx, [...READ], async (client) => {
    const all = await hostCall<ConnectorInfo[]>(client, 'connectors:list', [])
    const list = (Array.isArray(all) ? all : []).filter((c) => values.filter === undefined || connectorFilter(c, values.filter))
    emit(ctx, { connectors: list.map(connectorJson) }, () => {
      if (list.length === 0) return [values.filter !== undefined ? `No service matches "${safeLine(values.filter)}".` : 'No connectors.']
      const lines = table(
        [{ header: 'ID', min: 6 }, { header: 'NAME', min: 6 }, { header: 'SIGN-IN', min: 6 }, { header: 'STATE', min: 5 }, { header: 'CATEGORY', min: 4 }, { header: 'DESCRIPTION', flex: true, min: 8 }],
        list.map((c) => [
          `${safeLine(c.connector.id)}${c.custom ? ' *' : ''}`,
          safeLine(c.connector.name),
          EASE_WORD[infoEase(c)],
          STATE_WORD[c.state] ?? safeLine(c.state),
          safeLine(c.connector.category),
          safeLine(c.connector.description)
        ]),
        termWidth(ctx),
        styleFor(ctx)
      )
      if (list.some((c) => c.custom)) lines.push('* your own preset')
      return lines
    })
    return EXIT.ok
  })
}

/** What to do after adding a connector, by how it signs in. */
function nextStep(c: ConnectorInfo | undefined, id: string): string | undefined {
  if (!c) return undefined
  switch (infoEase(c)) {
    case 'none':
      return 'No sign-in needed. Link it to a project with `orgai mcp link ' + id + '`.'
    case 'signIn':
      return 'Sign in with `orgai mcp auth --library ' + id + '`.'
    case 'ownApp':
      return 'Create your own OAuth app first (see the connector setup in the OrgAI app), then `orgai mcp auth --library ' + id + ' --client-id <id> --client-secret-from-env <VAR>`.'
    case 'token':
      return 'Add its token with `orgai mcp connectors set-token ' + id + ' --from-env <VAR>` (or --stdin).'
  }
}

async function connectorsAdd(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { variant: { type: 'string' } })
  const id = checkKebabId(positionals[0], 'connector')
  noMore(positionals, 1)
  if (values.variant !== undefined) checkKebabId(values.variant, 'variant')
  return withHost(ctx, [...CONFIGURE], async (client) => {
    const info = await hostCall<McpLibraryInfo>(client, 'connectors:add', [{ connectorId: id, ...(values.variant !== undefined ? { variant: values.variant } : {}) }])
    const card = (await hostCall<ConnectorInfo[]>(client, 'connectors:list', []).catch(() => [] as ConnectorInfo[])).find((c) => c.connector.id === id)
    const name = info?.entry?.name ?? id
    emit(ctx, { connector: card ? connectorJson(card) : { id }, libraryId: info?.entry?.id, state: card?.state }, () => {
      const lines = [`Added ${safeLine(card?.connector.name ?? id)} to your MCP library as ${safeLine(name)}.`]
      const next = card?.state === 'connected' ? `It is connected. Link it to a project with \`orgai mcp link ${safeLine(name)}\`.` : nextStep(card, safeLine(name))
      if (next) lines.push(next)
      return lines
    })
    return EXIT.ok
  })
}

async function connectorsSetToken(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { 'from-env': { type: 'string' }, stdin: { type: 'boolean' }, clear: { type: 'boolean' } })
  const id = checkKebabId(positionals[0], 'connector')
  noMore(positionals, 1)
  if (values.clear && (values['from-env'] !== undefined || values.stdin)) throw usage('--clear takes no value; drop --from-env / --stdin.')
  const token = values.clear ? null : await readSecretValue(ctx, { fromEnv: values['from-env'], stdin: values.stdin, what: 'the token' })
  return withHost(ctx, [...CONFIGURE], async (client) => {
    const info = await hostCall<McpLibraryInfo>(client, 'connectors:setToken', [{ connectorId: id, token }])
    emit(ctx, { connectorId: id, libraryId: info?.entry?.id, set: token !== null }, () => (token === null ? `Cleared the token of ${safeLine(id)}.` : `Saved the token of ${safeLine(id)}.`))
    return EXIT.ok
  })
}

export function mcpConnectors(ctx: CliContext, args: string[]): Promise<number> {
  return runSubcommands(ctx, args, { list: connectorsList, add: connectorsAdd, 'set-token': connectorsSetToken }, CONNECTORS_USAGE)
}

// ---------- presets ----------

async function presetsList(ctx: CliContext, args: string[]): Promise<number> {
  noMore(parseFlags(args, {}).positionals)
  return withHost(ctx, [...READ], async (client) => {
    const all = await hostCall<UserConnectorDef[]>(client, 'connectorPresets:list', [])
    const list = Array.isArray(all) ? all : []
    emit(ctx, { presets: list }, () => {
      if (list.length === 0) return ['No presets of your own. Add one with `orgai mcp presets add --file <preset.json>`.']
      return table(
        [{ header: 'ID', min: 6 }, { header: 'NAME', min: 6 }, { header: 'CATEGORY', min: 4 }, { header: 'VARIANTS', min: 3 }, { header: 'DESCRIPTION', flex: true, min: 8 }],
        list.map((p) => [safeLine(p.id), safeLine(p.name), safeLine(p.category), String(p.variants?.length ?? 0), safeLine(p.description)]),
        termWidth(ctx),
        styleFor(ctx)
      )
    })
    return EXIT.ok
  })
}

/** The preset JSON from a file (or stdin with '-'), at most PRESET_FILE_MAX_BYTES; the host validates the shape. */
export async function readPresetFile(ctx: CliContext, file: string): Promise<unknown> {
  let text: string
  if (file === '-') {
    if (ctx.io.stdinIsTTY) throw usage('--file - needs the preset JSON piped in; stdin is a terminal.')
    text = await readStdinText(PRESET_FILE_MAX_BYTES, 'The preset on stdin')
  } else {
    const path = isAbsolute(file) ? file : resolve(ctx.cwd, file)
    let size: number
    try {
      size = statSync(path).size
    } catch {
      throw usage(`Cannot read ${safeLine(file)}.`)
    }
    if (size > PRESET_FILE_MAX_BYTES) throw usage(`${safeLine(file)} is larger than ${PRESET_FILE_MAX_BYTES / 1024} KB.`)
    text = readFileSync(path, 'utf8')
  }
  try {
    return JSON.parse(text.replace(/^﻿/, '')) as unknown
  } catch (e) {
    throw usage(`The preset is not valid JSON: ${safeLine(e instanceof Error ? e.message : String(e)).slice(0, 200)}`)
  }
}

async function presetsAdd(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { file: { type: 'string' } })
  noMore(positionals)
  if (!values.file) throw usage('Usage: orgai mcp presets add --file <path|->')
  const preset = await readPresetFile(ctx, values.file)
  if (!preset || typeof preset !== 'object' || Array.isArray(preset)) throw usage('The preset must be one JSON object (a UserConnectorDef).')
  return withHost(ctx, [...CONFIGURE], async (client) => {
    const list = await hostCall<UserConnectorDef[]>(client, 'connectorPresets:upsert', [preset])
    const id = (preset as { id?: unknown }).id
    const saved = (Array.isArray(list) ? list : []).find((p) => p.id === id)
    emit(ctx, { preset: saved ?? null }, () => `Saved the preset ${safeLine(saved?.name ?? String(id ?? ''))}. Add it with \`orgai mcp connectors add ${safeLine(saved?.id ?? String(id ?? ''))}\`.`)
    return EXIT.ok
  })
}

async function presetsRemove(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { yes: { type: 'boolean', short: 'y' } })
  const id = checkKebabId(positionals[0], 'preset')
  noMore(positionals, 1)
  return withHost(ctx, [...CONFIGURE], async (client) => {
    if (!(await confirm(ctx, `Remove your preset ${safeLine(id)}?`, !!values.yes))) {
      emit(ctx, { removed: false }, () => 'Nothing removed.')
      return EXIT.failure
    }
    await hostCall(client, 'connectorPresets:remove', [{ id }])
    emit(ctx, { removed: true, id }, () => `Removed the preset ${safeLine(id)}.`)
    return EXIT.ok
  })
}

export function mcpPresets(ctx: CliContext, args: string[]): Promise<number> {
  return runSubcommands(ctx, args, { list: presetsList, add: presetsAdd, remove: presetsRemove }, PRESETS_USAGE)
}

// ---------- registry search ----------

function transportsOf(e: McpRegistryEntry): string {
  const kinds = new Set<string>()
  for (const p of Array.isArray(e.packages) ? e.packages : []) kinds.add(safeLine(p?.registryType ?? 'package'))
  for (const r of Array.isArray(e.remotes) ? e.remotes : []) kinds.add(safeLine(r?.type ?? 'remote'))
  return [...kinds].join(', ')
}

export async function mcpSearch(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { limit: { type: 'string', short: 'n' }, cursor: { type: 'string' } })
  const query = positionals.join(' ')
  let limit: number | undefined
  if (values.limit !== undefined) {
    limit = Number(values.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw usage('--limit must be a whole number from 1 to 100.')
  }
  return withHost(ctx, [...READ], async (client) => {
    const res = await hostCall<McpRegistrySearchResult>(client, 'mcp:registrySearch', [{ query, ...(limit ? { limit } : {}), ...(values.cursor ? { cursor: values.cursor } : {}) }])
    const entries = Array.isArray(res?.entries) ? res.entries : []
    // Registry content is untrusted: JSON escapes every control character; text goes through safeLine.
    emit(ctx, { query, entries, ...(res?.nextCursor ? { nextCursor: res.nextCursor } : {}) }, () => {
      if (entries.length === 0) return [`The MCP Registry has no server matching "${safeLine(query)}".`]
      const lines = table(
        [{ header: 'NAME', min: 8 }, { header: 'VERSION', min: 4 }, { header: 'KIND', min: 4 }, { header: 'DESCRIPTION', flex: true, min: 8 }],
        entries.map((e) => [safeLine(e.title ? `${e.name} (${e.title})` : e.name), safeLine(e.version), transportsOf(e), `${e.status === 'deprecated' ? '[deprecated] ' : ''}${safeLine(e.description)}`]),
        termWidth(ctx),
        styleFor(ctx)
      )
      lines.push('Registry entries are not reviewed by OrgAI. Add one with `orgai mcp add` after checking it.')
      if (res?.nextCursor) lines.push(`More: --cursor ${safeLine(res.nextCursor)}`)
      return lines
    })
    return EXIT.ok
  })
}
