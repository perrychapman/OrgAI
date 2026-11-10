/**
 * `orgai connections` (cli-spec 6.3, Wave 5): the app-wide model connections (anthropic, openai, litellm).
 *
 *   list | show <id>                      read
 *   test <id>                             operate: exit 0 connected, 5 disconnected or an auth error, 1 otherwise
 *   connect <id>                          configure: enables, probes, discovers models and remaps roles
 *   login openai [--device-code|--browser] configure: the ChatGPT sign-in (cli-spec 6.3(5)); device code by default
 *                                         over SSH or on Linux without a display
 *   logout <id> [--yes] | set-default <id|auto> | set-secret <proxy id> (--from-env VAR | --stdin | --clear)
 *   update <id> [--base-url <url|none>] [--enable|--disable]
 *   proxy add --name N --anthropic-url U [--openai-url U] [--models-url U] [--kind litellm|openai-compatible]
 *             [--key-env VAR | --key-stdin] [--connect]
 *   proxy edit <id> [--name N] [--anthropic-url U] [--openai-url U|none] [--models-url U|none] [--enable|--disable]
 *   proxy remove <id> [--yes]
 *   tier <id>                             read: top / deep / everyday / fast with each model's catalog source and
 *                                         context window; an unmapped tier shows as unmapped
 *   tier <id> <tier>=<model> ... [--reset <tier>] [--force] [--dry-run]
 *                                         configure (read with --dry-run): each model must be in the connection's
 *                                         catalog (close matches listed; --force sends an id that is not); saved
 *                                         through connections:update, whose tier change remaps the roles on that
 *                                         connection (the host's own remap, as the desktop tier editor does); the
 *                                         touched roles are printed. --reset puts a tier back on discovery's choice
 *                                         (suggestTierModels, the function ConnectionService.retier uses).
 *
 * Any number of named proxies exist besides anthropic and openai; ids are 'litellm' (the migrated one) or
 * `proxy-<8 hex>`. Secrets never travel on argv and are never printed (a proxy key goes in through readSecretValue only).
 */
import { BUILTIN_CONNECTION_IDS, MODEL_TIERS, PROXY_KINDS, isBuiltinConnectionId, isModelTier, isProxyConnection, isProxyConnectionId, type AppSettings, type ConnectionEvent, type ConnectionId, type ConnectionInfo, type ConnectionLoginMethod, type ConnectionLoginStart, type ConnectionLoginUpdate, type ConnectionStatus, type HostScope, type ModelRef, type ModelTier, type Project, type ProviderConnection, type ProviderModel, type ProxyConnection, type ProxyCreateInput, type ProxyKind, type ProxyRemoveResult, type RemapResult } from '../../shared/types'
import { projectConnection, roleConnection } from '../../shared/defaults'
import { formatDateTime } from '../../shared/view/dates'
import { suggestTierModels } from '../../main/connections/catalog'
import { remapProject } from '../../main/connections/remap'
import { parseFlags } from '../flags'
import { confirm, hostCall, isRemoteSession, readSecretValue, runSubcommands, subscribeTopics, withHost } from '../manage'
import { emit, emitLine, isJsonOutput, printText, safeLine, styleFor, table, termWidth, warn, type Json } from '../output'
import { CliError, EXIT, type CliContext, type CommandFn, type HostClient } from '../types'

export const READ: HostScope[] = ['read']
export const OPERATE: HostScope[] = ['read', 'operate']
export const CONFIGURE: HostScope[] = ['read', 'configure']

/** Display names of the fixed ids. A proxy is named by its record (`connectionLabel`); an id with no entry shows as itself. */
export const CONNECTION_LABELS: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', litellm: 'LiteLLM' }

/** The name to show for a connection id (proxy names need the record; see `connectionLabel`). */
export function labelOfId(id: string, names?: Readonly<Record<string, string>>): string {
  return names?.[id] ?? CONNECTION_LABELS[id] ?? safeLine(id)
}

/** The name to show for a connection record: a proxy's own name, else the built-in label. */
export function connectionLabel(c: ProviderConnection): string {
  return isProxyConnection(c) ? safeLine(c.name) : labelOfId(c.id)
}

const USAGE = 'connections <list|show|test|connect|login|logout|set-default|set-secret|update|proxy|tier> [options]'
const PROXY_USAGE = 'connections proxy <add|edit|remove> [options]'

/**
 * A connection id argument: anthropic, openai or a proxy id by shape ('litellm' or proxy-<8 hex>); anything else is
 * exit 2. Whether the proxy exists is the host's answer.
 */
export function connectionArg(raw: string | undefined, what = 'a connection'): ConnectionId {
  const hint = `${BUILTIN_CONNECTION_IDS.join(', ')}, litellm or a proxy id (see \`orgai connections list\`)`
  if (raw === undefined) throw new CliError(`Name ${what}: ${hint}.`, EXIT.usage)
  if (!isBuiltinConnectionId(raw) && !isProxyConnectionId(raw)) throw new CliError(`Unknown connection "${safeLine(raw).slice(0, 40)}". Use one of: ${hint}.`, EXIT.usage)
  return raw
}

/** A proxy id argument; a built-in or any other shape is exit 2. */
export function proxyArg(raw: string | undefined): string {
  if (raw === undefined) throw new CliError('Name a proxy by its id (see `orgai connections list`).', EXIT.usage)
  if (!isProxyConnectionId(raw)) throw new CliError(`"${safeLine(raw).slice(0, 40)}" is not a proxy id (litellm or proxy-<8 hex>).`, EXIT.usage)
  return raw
}

function onePositional(positionals: string[], what: string): string | undefined {
  if (positionals.length > 1) throw new CliError(`Unexpected argument "${safeLine(positionals[1]).slice(0, 40)}" after ${what}.`, EXIT.usage)
  return positionals[0]
}

function noPositionals(positionals: string[]): void {
  if (positionals.length > 0) throw new CliError(`Unexpected argument "${safeLine(positionals[0]).slice(0, 40)}".`, EXIT.usage)
}

/**
 * A host call whose refusal is a failure (exit 1), not a usage error: the host answers a service's plain Error (e.g.
 * "OpenAI is not connected...", the engagement plan's stale refusal) as bad_request, which hostError maps to 2.
 */
export async function refusable<T>(client: HostClient, method: string, params: unknown[], opts?: { timeoutMs?: number }): Promise<T> {
  try {
    return await hostCall<T>(client, method, params, opts)
  } catch (e) {
    if (e instanceof CliError && e.exitCode === EXIT.usage) throw new CliError(e.message, EXIT.failure)
    throw e
  }
}

/** Ctrl+C / SIGTERM exit codes. */
export const signalExit = (sig: 'SIGINT' | 'SIGTERM'): number => (sig === 'SIGINT' ? EXIT.sigint : EXIT.sigterm)

// ---------- Views ----------

/** Words that make an error status an authentication problem (exit 5). */
const AUTH_WORDS = /\b(auth\w*|log ?in|sign(ed)? ?in|signed out|401|unauthori[sz]ed|forbidden|api key|token|credential\w*|expired)\b/i

/** cli-spec 6.1 exit code of a connection status: connected 0, disconnected or an auth error 5, any other 1. */
export function statusExit(status: ConnectionStatus): number {
  if (status.state === 'connected') return EXIT.ok
  if (status.state === 'disconnected') return EXIT.auth
  if (status.state === 'error' && AUTH_WORDS.test(status.detail ?? '')) return EXIT.auth
  return EXIT.failure
}

const STATE_WORDS: Record<ConnectionStatus['state'], string> = { connected: 'Connected', connecting: 'Connecting', disconnected: 'Not connected', error: 'Error' }

/** 'chosen' when the user picked the default (settings defaultConnectionChosen), else 'automatic'. */
export type DefaultMode = 'chosen' | 'automatic'

export function defaultModeOf(settings: Pick<AppSettings, 'defaultConnectionChosen'> | undefined): DefaultMode {
  return settings?.defaultConnectionChosen === true ? 'chosen' : 'automatic'
}

/** One connection as JSON: the record's non-secret fields and its live status (never a key, never the key's hash). */
export function connectionJson(info: ConnectionInfo, mode?: DefaultMode): Json {
  const c = info.connection
  return {
    id: c.id,
    label: connectionLabel(c),
    enabled: c.enabled,
    status: info.status.state,
    ...(info.status.detail ? { detail: info.status.detail } : {}),
    ...(info.status.account ? { account: info.status.account } : {}),
    ...(info.status.checkedAt ? { checkedAt: info.status.checkedAt } : {}),
    isDefault: info.isDefault,
    ...(info.isDefault && mode ? { defaultMode: mode } : {}),
    modelCount: info.modelCount,
    ...(info.modelsRefreshedAt ? { modelsRefreshedAt: info.modelsRefreshedAt } : {}),
    ...(info.modelsError ? { modelsError: info.modelsError } : {}),
    tierModels: { ...c.tierModels },
    ...(c.id === 'anthropic' && !isProxyConnection(c) ? { auth: c.auth.kind } : {}),
    ...(c.id === 'openai' && !isProxyConnection(c) ? { auth: c.auth.kind, ...(c.auth.kind === 'apiKey' ? { envVar: c.auth.envVar } : {}) } : {}),
    ...(isProxyConnection(c)
      ? {
          kind: c.kind,
          anthropicBaseUrl: c.anthropicBaseUrl,
          // Kept for scripts written against the single LiteLLM connection.
          baseUrl: c.anthropicBaseUrl,
          ...(c.openaiBaseUrl ? { openaiBaseUrl: c.openaiBaseUrl } : {}),
          ...(c.modelsUrl ? { modelsUrl: c.modelsUrl } : {}),
          hasApiKey: c.hasApiKey
        }
      : {})
  }
}

const defaultWord = (mode: DefaultMode): string => (mode === 'chosen' ? 'Default (Chosen)' : 'Default (Automatic)')

function statusLine(s: ConnectionStatus): string {
  return [STATE_WORDS[s.state] ?? safeLine(s.state), s.detail ? safeLine(s.detail) : ''].filter(Boolean).join(': ')
}

async function settingsOf(client: HostClient): Promise<AppSettings | undefined> {
  return client.call<AppSettings>('settings:get', []).catch(() => undefined)
}

async function listInfos(client: HostClient): Promise<ConnectionInfo[]> {
  const list = await hostCall<ConnectionInfo[]>(client, 'connections:list', [])
  return Array.isArray(list) ? list : []
}

// ---------- list / show ----------

async function labelFor(client: HostClient, id: string): Promise<string> {
  return isBuiltinConnectionId(id) ? labelOfId(id) : labelOfId(id, await proxyNames(client))
}

/** Built-ins first (anthropic, openai), then the proxies in the order the host listed them. */
function orderedInfos(infos: ConnectionInfo[]): ConnectionInfo[] {
  const builtin = infos.filter((i) => isBuiltinConnectionId(i.connection.id))
  return [...builtin, ...infos.filter((i) => !isBuiltinConnectionId(i.connection.id))]
}

/** id -> name of every proxy the host lists; best effort (a failed list gives {}). */
async function proxyNames(client: HostClient): Promise<Record<string, string>> {
  const names: Record<string, string> = {}
  try {
    for (const i of await listInfos(client)) if (isProxyConnection(i.connection)) names[i.connection.id] = i.connection.name
  } catch {
    // Names are cosmetic.
  }
  return names
}

const runList = async (ctx: CliContext, args: string[]): Promise<number> => {
  noPositionals(parseFlags(args, {}).positionals)
  return withHost(ctx, READ, async (client) => {
    const infos = await listInfos(client)
    const mode = defaultModeOf(await settingsOf(client))
    emit(ctx, { connections: orderedInfos(infos).map((i) => connectionJson(i, mode)) }, () => {
      const st = styleFor(ctx)
      return table(
        [{ header: 'CONNECTION', min: 9 }, { header: 'ENABLED', min: 3 }, { header: 'STATUS', min: 6 }, { header: 'ACCOUNT', flex: true, min: 6 }, { header: 'DEFAULT', min: 7 }],
        orderedInfos(infos).map((i) => [
          `${i.connection.id} (${connectionLabel(i.connection)})`,
          i.connection.enabled ? 'yes' : 'no',
          STATE_WORDS[i.status.state] ?? safeLine(i.status.state),
          safeLine(i.status.account ?? ''),
          i.isDefault ? defaultWord(mode) : ''
        ]),
        termWidth(ctx),
        st
      )
    })
    return EXIT.ok
  })
}

function showLines(info: ConnectionInfo, mode: DefaultMode): string[] {
  const c = info.connection
  const lines = [`${connectionLabel(c)} (${c.id})`, `  Enabled: ${c.enabled ? 'yes' : 'no'}`, `  Status: ${statusLine(info.status)}`]
  if (info.status.account) lines.push(`  Account: ${safeLine(info.status.account)}`)
  if (info.isDefault) lines.push(`  ${defaultWord(mode)}`)
  if (isProxyConnection(c)) {
    lines.push(`  Kind: ${safeLine(c.kind)}`)
    lines.push(`  Anthropic URL: ${c.anthropicBaseUrl ? safeLine(c.anthropicBaseUrl) : '(not set)'}`)
    if (c.openaiBaseUrl) lines.push(`  OpenAI URL: ${safeLine(c.openaiBaseUrl)}`)
    if (c.modelsUrl) lines.push(`  Models URL: ${safeLine(c.modelsUrl)}`)
    lines.push(`  API key: ${c.hasApiKey ? 'stored' : 'not set'}`)
  } else if (c.id === 'anthropic') lines.push(`  Auth: ${safeLine(c.auth.kind)}`)
  else if (c.id === 'openai') lines.push(`  Auth: ${c.auth.kind === 'apiKey' ? `API key from ${safeLine(c.auth.envVar)}` : 'ChatGPT sign-in'}`)
  lines.push(`  Models: ${info.modelCount}${info.modelsRefreshedAt ? `, refreshed ${formatDateTime(info.modelsRefreshedAt)}` : ''}`)
  if (info.modelsError) lines.push(`  Last refresh failed: ${safeLine(info.modelsError)}`)
  const tiers = Object.entries(c.tierModels).filter(([, m]) => !!m)
  if (tiers.length) lines.push(`  Tiers: ${tiers.map(([t, m]) => `${t} = ${safeLine(m)}`).join(', ')}`)
  return lines
}

const runShow = async (ctx: CliContext, args: string[]): Promise<number> => {
  const id = connectionArg(onePositional(parseFlags(args, {}).positionals, 'the connection'))
  return withHost(ctx, READ, async (client) => {
    const info = (await listInfos(client)).find((i) => i.connection.id === id)
    if (!info) throw new CliError(`The host did not list ${labelOfId(id)}.`, EXIT.failure)
    const mode = defaultModeOf(await settingsOf(client))
    emit(ctx, { connection: connectionJson(info, mode) }, () => showLines(info, mode))
    return EXIT.ok
  })
}

// ---------- test / connect ----------

const runTest = async (ctx: CliContext, args: string[]): Promise<number> => {
  const id = connectionArg(onePositional(parseFlags(args, {}).positionals, 'the connection'))
  return withHost(ctx, OPERATE, async (client) => {
    const status = await hostCall<ConnectionStatus>(client, 'connections:test', [id])
    const code = statusExit(status)
    const label = await labelFor(client, id)
    emit(ctx, { id, status: status.state, ...(status.detail ? { detail: status.detail } : {}), ...(status.account ? { account: status.account } : {}), ok: code === EXIT.ok }, () => [
      `${label}: ${statusLine(status)}`,
      ...(status.account ? [`Account: ${safeLine(status.account)}`] : [])
    ])
    return code
  })
}

function remapLines(results: RemapResult[], projects: Project[]): string[] {
  const lines: string[] = []
  for (const r of results) {
    const p = projects.find((x) => x.id === r.projectId)
    lines.push(`Remapped ${r.changes.length} role model${r.changes.length === 1 ? '' : 's'} in ${safeLine(p?.name ?? r.projectId)}:`)
    for (const c of r.changes) {
      const role = p?.roles.find((x) => x.id === c.roleId)
      lines.push(`  ${safeLine(role?.name ?? c.roleId)}: ${safeLine(c.from)} -> ${safeLine(c.to)}`)
    }
  }
  return lines
}

const runConnect = async (ctx: CliContext, args: string[]): Promise<number> => {
  const id = connectionArg(onePositional(parseFlags(args, {}).positionals, 'the connection'))
  return withHost(ctx, CONFIGURE, async (client) => {
    const remaps: RemapResult[] = []
    const off = await subscribeTopics(client, ['connections'], (_ch, payload) => {
      const e = payload as ConnectionEvent | undefined
      if (e?.type === 'projects.remapped' && Array.isArray(e.results)) remaps.push(...e.results.filter((r) => r.connection === id))
    })
    try {
      const info = await hostCall<ConnectionInfo>(client, 'connections:connect', [id])
      // The remap broadcast goes out before the reply on the same socket; one more tick for safety.
      await new Promise((r) => setTimeout(r, 20))
      const projects = remaps.length ? await client.call<Project[]>('projects:list', []).catch(() => [] as Project[]) : []
      const code = statusExit(info.status)
      emit(ctx, { connection: connectionJson(info), remapped: remaps }, () => [`${connectionLabel(info.connection)}: ${statusLine(info.status)}`, ...remapLines(remaps, Array.isArray(projects) ? projects : [])])
      return code
    } finally {
      off()
    }
  })
}

// ---------- login ----------

/** Swappable in tests: how long a sign-in may wait for its result. */
export const loginDeps = { timeoutMs: 15 * 60_000 }

const ANTHROPIC_LOGIN_HINT = 'Anthropic has no sign-in here: run `claude` and type /login, or set an API key, then `orgai connections test anthropic`.'
const loginHint = (id: string): string =>
  id === 'anthropic' ? ANTHROPIC_LOGIN_HINT : `A proxy has no sign-in: store its key with \`orgai connections set-secret ${id} --from-env VAR\` (or --stdin).`

/** deviceCode with --device-code or on a remote session (SSH, Linux without a display); browser otherwise. */
export function loginMethodFor(flags: { deviceCode?: boolean; browser?: boolean }, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ConnectionLoginMethod {
  if (flags.deviceCode) return 'deviceCode'
  if (flags.browser) return 'browser'
  return isRemoteSession(env, platform) ? 'deviceCode' : 'browser'
}

function startLines(start: ConnectionLoginStart, remote: boolean): string[] {
  if (start.method === 'deviceCode') {
    return [
      `To sign in to OpenAI, open ${safeLine(start.verificationUrl)} in any browser and enter the code:`,
      '',
      `  ${safeLine(start.userCode)}`,
      '',
      ...(start.expiresAt ? [`The code works until ${formatDateTime(start.expiresAt)}.`] : []),
      'Waiting for the sign-in... (Ctrl+C cancels)'
    ]
  }
  return [
    `Opening your browser; if it does not open, visit: ${safeLine(start.authUrl)}`,
    ...(remote ? ['Note: this is an SSH session; the browser opens on the machine running OrgAI, not yours. Use --device-code to sign in from here.'] : []),
    'Waiting for the sign-in... (Ctrl+C cancels)'
  ]
}

function startJson(start: ConnectionLoginStart): Json {
  return start.method === 'deviceCode'
    ? { loginId: start.loginId, method: start.method, verificationUrl: start.verificationUrl, userCode: start.userCode, ...(start.expiresAt ? { expiresAt: start.expiresAt } : {}) }
    : { loginId: start.loginId, method: start.method, authUrl: start.authUrl }
}

const runLogin = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { 'device-code': { type: 'boolean' }, browser: { type: 'boolean' } })
  const id = connectionArg(onePositional(positionals, 'the connection'))
  if (id !== 'openai') throw new CliError(loginHint(id), EXIT.usage)
  if (values['device-code'] && values.browser) throw new CliError('Give --device-code or --browser, not both.', EXIT.usage)
  const remote = isRemoteSession(ctx.env, ctx.platform)
  const method = loginMethodFor({ deviceCode: values['device-code'], browser: values.browser }, ctx.env, ctx.platform)

  return withHost(ctx, CONFIGURE, async (client) => {
    // Events can arrive before connections:login answers: keep them until the login id is known.
    const early: ConnectionLoginUpdate[] = []
    let onUpdate: ((u: ConnectionLoginUpdate) => void) | undefined
    const off = await subscribeTopics(client, ['connections'], (_ch, payload) => {
      const e = payload as ConnectionEvent | undefined
      if (e?.type !== 'connection.login' || !e.login || typeof e.login !== 'object') return
      if (onUpdate) onUpdate(e.login)
      else early.push(e.login)
    })
    let loginId: string | undefined
    let offSignal: (() => void) | undefined
    let offClose: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const start = await hostCall<ConnectionLoginStart>(client, 'connections:login', ['openai', method])
      loginId = start.loginId
      if (ctx.globals.outputFormat === 'stream-json') emitLine(ctx, { type: 'login.started', ...startJson(start) })
      else if (isJsonOutput(ctx)) for (const l of startLines(start, remote)) warn(ctx, l)
      else printText(ctx, startLines(start, remote))

      const cancel = async (): Promise<void> => {
        await client.call('connections:cancelLogin', [start.loginId], { timeoutMs: 5000 }).catch(() => undefined)
      }
      type Outcome = { kind: 'update'; update: ConnectionLoginUpdate } | { kind: 'signal'; sig: 'SIGINT' | 'SIGTERM' } | { kind: 'timeout' } | { kind: 'closed' }
      const outcome = await new Promise<Outcome>((resolve) => {
        const take = (u: ConnectionLoginUpdate): void => {
          if (u.loginId !== start.loginId) return
          if (u.state === 'success' || u.state === 'error' || u.state === 'cancelled') resolve({ kind: 'update', update: u })
        }
        onUpdate = take
        for (const u of early.splice(0)) take(u)
        offSignal = ctx.signals.onInterrupt((sig) => resolve({ kind: 'signal', sig }))
        offClose = client.onClose(() => resolve({ kind: 'closed' }))
        timer = setTimeout(() => resolve({ kind: 'timeout' }), loginDeps.timeoutMs)
      })

      const result = (state: string, extra: Json = {}): Json => ({ ...(ctx.globals.outputFormat === 'stream-json' ? { type: 'login.result' } : startJson(start)), loginId: start.loginId, state, ...extra })
      const done = (value: Json, text: string[]): void => {
        if (ctx.globals.outputFormat === 'stream-json') emitLine(ctx, value)
        else emit(ctx, value, () => text)
      }
      switch (outcome.kind) {
        case 'signal':
          await cancel()
          done(result('cancelled'), ['Sign-in cancelled.'])
          return signalExit(outcome.sig)
        case 'timeout':
          await cancel()
          done(result('timeout'), ['No sign-in result after 15 minutes; cancelled. Run the command again to retry.'])
          return EXIT.failure
        case 'closed':
          done(result('closed'), ['The connection to the OrgAI host closed before the sign-in finished.'])
          return EXIT.failure
        case 'update': {
          const u = outcome.update
          if (u.state === 'success') {
            done(result('success', u.account ? { account: u.account } : {}), [`Signed in to OpenAI${u.account ? ` as ${safeLine(u.account)}` : ''}.`])
            return EXIT.ok
          }
          if (u.state === 'cancelled') {
            done(result('cancelled'), ['The sign-in was cancelled.'])
            return EXIT.failure
          }
          done(result('error', u.detail ? { detail: u.detail } : {}), [`Sign-in failed${u.detail ? `: ${safeLine(u.detail)}` : '.'}`])
          return EXIT.auth
        }
      }
    } finally {
      if (timer) clearTimeout(timer)
      offSignal?.()
      offClose?.()
      off()
    }
  })
}

// ---------- logout / set-default ----------

const runLogout = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { yes: { type: 'boolean', short: 'y' } })
  const id = connectionArg(onePositional(positionals, 'the connection'))
  if (!(await confirm(ctx, `Sign out of ${labelOfId(id)}?`, !!values.yes))) {
    printText(ctx, 'Nothing changed.')
    return EXIT.failure
  }
  return withHost(ctx, CONFIGURE, async (client) => {
    const info = await hostCall<ConnectionInfo>(client, 'connections:logout', [id])
    emit(ctx, { connection: connectionJson(info) }, () => [`${connectionLabel(info.connection)}: ${statusLine(info.status)}`])
    return EXIT.ok
  })
}

const runSetDefault = async (ctx: CliContext, args: string[]): Promise<number> => {
  const raw = onePositional(parseFlags(args, {}).positionals, 'the connection')
  const input: ConnectionId | null = raw === 'auto' || raw === 'automatic' ? null : connectionArg(raw, 'a connection or auto')
  return withHost(ctx, CONFIGURE, async (client) => {
    const infos = await refusable<ConnectionInfo[]>(client, 'connections:setDefault', [input])
    const list = Array.isArray(infos) ? infos : []
    const def = list.find((i) => i.isDefault)
    const mode: DefaultMode = input === null ? 'automatic' : 'chosen'
    emit(ctx, { defaultConnection: def?.connection.id ?? null, defaultMode: mode, connections: list.map((i) => connectionJson(i, mode)) }, () =>
      def ? `Default connection: ${connectionLabel(def.connection)} (${mode === 'chosen' ? 'Chosen' : 'Automatic'}).` : 'Default connection updated.'
    )
    return EXIT.ok
  })
}

// ---------- set-secret / update ----------

const runSetSecret = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { 'from-env': { type: 'string' }, stdin: { type: 'boolean' }, clear: { type: 'boolean' } })
  // Never echo a second word: it may be a key typed on the command line.
  if (positionals.length > 1) throw new CliError('set-secret takes the connection only; secrets are never taken as arguments. Use --from-env <VAR> or --stdin.', EXIT.usage)
  const id = connectionArg(positionals[0])
  if (!isProxyConnectionId(id)) throw new CliError(`Only a proxy keeps a key in OrgAI. ${id === 'anthropic' ? ANTHROPIC_LOGIN_HINT : 'Sign in to OpenAI with `orgai connections login openai`.'}`, EXIT.usage)
  if (values.clear && (values['from-env'] !== undefined || values.stdin)) throw new CliError('--clear takes no key; leave out --from-env and --stdin.', EXIT.usage)
  const apiKey = values.clear ? null : await readSecretValue(ctx, { fromEnv: values['from-env'], stdin: values.stdin, what: 'the proxy API key' })
  return withHost(ctx, CONFIGURE, async (client) => {
    const info = await refusable<ConnectionInfo>(client, 'connections:setSecret', [{ id, apiKey }])
    const message = apiKey === null ? 'Key removed.' : 'Key saved. Test and connect to apply.'
    emit(ctx, { id, hasApiKey: isProxyConnection(info.connection) ? info.connection.hasApiKey : apiKey !== null, message, status: info.status.state }, () => message)
    return EXIT.ok
  })
}

/** A URL flag value: 'none' (or '') clears it; else an http(s) URL without credentials, trailing slashes dropped. */
function urlFlag(flag: string, raw: string): string {
  if (raw === 'none' || raw === '') return ''
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new CliError(`${flag} needs an http or https URL (or none), not "${safeLine(raw).slice(0, 80)}".`, EXIT.usage)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CliError(`${flag} needs an http or https URL (or none).`, EXIT.usage)
  if (url.username || url.password) throw new CliError(`${flag} must not carry a user name or password; store the key with set-secret.`, EXIT.usage)
  return raw.replace(/\/+$/, '')
}

/** A --base-url value: 'none' clears it; else an http(s) URL without credentials. */
export function baseUrlArg(raw: string): string {
  return urlFlag('--base-url', raw)
}

/** What `update` and `proxy edit` may change. A '' URL clears it. */
export interface ConnectionChange {
  /** Legacy `update --base-url`: the proxy's Anthropic URL. */
  baseUrl?: string
  anthropicUrl?: string
  openaiUrl?: string
  modelsUrl?: string
  name?: string
  enabled?: boolean
}

/** The connection record with the requested changes. */
export function updatedConnection(c: ProviderConnection, change: ConnectionChange): ProviderConnection {
  const next = { ...c, ...(change.enabled !== undefined ? { enabled: change.enabled } : {}) } as ProviderConnection
  const proxyChange = change.baseUrl !== undefined || change.anthropicUrl !== undefined || change.openaiUrl !== undefined || change.modelsUrl !== undefined || change.name !== undefined
  if (!proxyChange) return next
  if (!isProxyConnection(next)) throw new CliError('Only a proxy has a name or URLs.', EXIT.usage)
  const p: ProxyConnection = { ...next }
  const anthropic = change.anthropicUrl ?? change.baseUrl
  if (anthropic !== undefined) p.anthropicBaseUrl = anthropic
  if (change.openaiUrl !== undefined) {
    if (change.openaiUrl === '') delete p.openaiBaseUrl
    else p.openaiBaseUrl = change.openaiUrl
  }
  if (change.modelsUrl !== undefined) {
    if (change.modelsUrl === '') delete p.modelsUrl
    else p.modelsUrl = change.modelsUrl
  }
  if (change.name !== undefined) p.name = change.name
  return p
}

const runUpdate = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { 'base-url': { type: 'string' }, enable: { type: 'boolean' }, disable: { type: 'boolean' } })
  const id = connectionArg(onePositional(positionals, 'the connection'))
  if (values.enable && values.disable) throw new CliError('Give --enable or --disable, not both.', EXIT.usage)
  if (values['base-url'] === undefined && !values.enable && !values.disable) throw new CliError('Nothing to change: give --base-url, --enable or --disable.', EXIT.usage)
  if (values['base-url'] !== undefined && !isProxyConnectionId(id)) throw new CliError('Only a proxy has a base URL.', EXIT.usage)
  const change: ConnectionChange = { ...(values['base-url'] !== undefined ? { baseUrl: baseUrlArg(values['base-url']) } : {}), ...(values.enable ? { enabled: true } : values.disable ? { enabled: false } : {}) }
  return applyChange(ctx, id, change)
}

async function applyChange(ctx: CliContext, id: ConnectionId, change: ConnectionChange): Promise<number> {
  return withHost(ctx, CONFIGURE, async (client) => {
    const current = (await listInfos(client)).find((i) => i.connection.id === id)
    if (!current) throw new CliError(`The host did not list ${labelOfId(id)}.`, EXIT.failure)
    const info = await refusable<ConnectionInfo>(client, 'connections:update', [updatedConnection(current.connection, change)])
    const mode = defaultModeOf(await settingsOf(client))
    emit(ctx, { connection: connectionJson(info, mode) }, () => showLines(info, mode))
    return EXIT.ok
  })
}

// ---------- proxy add / edit / remove ----------

function kindFlag(raw: string | undefined): ProxyKind | undefined {
  if (raw === undefined) return undefined
  if (!(PROXY_KINDS as readonly string[]).includes(raw)) throw new CliError(`--kind must be one of: ${PROXY_KINDS.join(', ')}.`, EXIT.usage)
  return raw as ProxyKind
}

const runProxyAdd = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, {
    name: { type: 'string' },
    'anthropic-url': { type: 'string' },
    'openai-url': { type: 'string' },
    'models-url': { type: 'string' },
    kind: { type: 'string' },
    'key-env': { type: 'string' },
    'key-stdin': { type: 'boolean' },
    connect: { type: 'boolean' }
  })
  // Never echo a positional: it may be a key typed on the command line.
  if (positionals.length > 0) throw new CliError('proxy add takes options only; the key is never an argument. Use --key-env <VAR> or --key-stdin.', EXIT.usage)
  if (values.name === undefined || values.name.trim() === '') throw new CliError('Give the proxy a name with --name.', EXIT.usage)
  if (values['anthropic-url'] === undefined) throw new CliError('Give the proxy address with --anthropic-url.', EXIT.usage)
  const anthropicBaseUrl = urlFlag('--anthropic-url', values['anthropic-url'])
  if (anthropicBaseUrl === '') throw new CliError('--anthropic-url needs a URL.', EXIT.usage)
  const input: ProxyCreateInput = { name: values.name, anthropicBaseUrl }
  const kind = kindFlag(values.kind)
  if (kind) input.kind = kind
  const openai = values['openai-url'] === undefined ? '' : urlFlag('--openai-url', values['openai-url'])
  if (openai) input.openaiBaseUrl = openai
  const models = values['models-url'] === undefined ? '' : urlFlag('--models-url', values['models-url'])
  if (models) input.modelsUrl = models
  const wantsKey = values['key-env'] !== undefined || values['key-stdin']
  // Before withHost: reading takes the variable out of the environment so a host this command starts never inherits it.
  if (wantsKey) input.apiKey = await readSecretValue(ctx, { fromEnv: values['key-env'], stdin: values['key-stdin'], what: 'the proxy API key' })
  return withHost(ctx, CONFIGURE, async (client) => {
    const created = await refusable<ConnectionInfo>(client, 'connections:createProxy', [input])
    const id = created.connection.id
    let info = created
    let code: number = EXIT.ok
    if (values.connect) {
      info = await refusable<ConnectionInfo>(client, 'connections:connect', [id])
      code = statusExit(info.status)
    }
    const message = values.connect ? statusLine(info.status) : 'Added. Test and connect to apply.'
    emit(ctx, { id, added: true, connection: connectionJson(info), message }, () => [`Added ${connectionLabel(info.connection)} (${id}).`, values.connect ? statusLine(info.status) : 'Test and connect it to apply: orgai connections connect ' + id])
    return code
  })
}

const runProxyEdit = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, {
    name: { type: 'string' },
    'anthropic-url': { type: 'string' },
    'openai-url': { type: 'string' },
    'models-url': { type: 'string' },
    enable: { type: 'boolean' },
    disable: { type: 'boolean' }
  })
  const id = proxyArg(onePositional(positionals, 'the proxy'))
  if (values.enable && values.disable) throw new CliError('Give --enable or --disable, not both.', EXIT.usage)
  const change: ConnectionChange = {}
  if (values.name !== undefined) {
    if (values.name.trim() === '') throw new CliError('--name cannot be empty.', EXIT.usage)
    change.name = values.name
  }
  if (values['anthropic-url'] !== undefined) {
    change.anthropicUrl = urlFlag('--anthropic-url', values['anthropic-url'])
    if (change.anthropicUrl === '') throw new CliError('--anthropic-url needs a URL.', EXIT.usage)
  }
  if (values['openai-url'] !== undefined) change.openaiUrl = urlFlag('--openai-url', values['openai-url'])
  if (values['models-url'] !== undefined) change.modelsUrl = urlFlag('--models-url', values['models-url'])
  if (values.enable) change.enabled = true
  if (values.disable) change.enabled = false
  if (Object.keys(change).length === 0) throw new CliError('Nothing to change: give --name, --anthropic-url, --openai-url, --models-url, --enable or --disable.', EXIT.usage)
  return applyChange(ctx, id, change)
}

const runProxyRemove = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { yes: { type: 'boolean', short: 'y' } })
  const id = proxyArg(onePositional(positionals, 'the proxy'))
  if (!(await confirm(ctx, `Remove the proxy ${id}? Its stored key and model list go with it.`, !!values.yes))) {
    printText(ctx, 'Nothing changed.')
    return EXIT.failure
  }
  return withHost(ctx, CONFIGURE, async (client) => {
    const result = await refusable<ProxyRemoveResult>(client, 'connections:removeProxy', [id])
    const list = Array.isArray(result?.connections) ? result.connections : []
    emit(ctx, { id, removed: true, connections: orderedInfos(list).map((i) => connectionJson(i)) }, () => `Removed ${id}.`)
    return EXIT.ok
  })
}

const runProxy = async (ctx: CliContext, args: string[]): Promise<number> =>
  runSubcommands(ctx, args, { add: runProxyAdd, edit: runProxyEdit, remove: runProxyRemove }, PROXY_USAGE)

// ---------- tier ----------

type Tiers = Partial<Record<ModelTier, ModelRef>>

/** A model id the CLI sends as a tier mapping: one printable line without spaces, at most 200 characters. */
const MODEL_ID_RE = /^[!-~]{1,200}$/

/** `<tier>=<model>` pairs; a tier named twice, an unknown tier or an empty model is exit 2. */
export function parseTierPairs(positionals: readonly string[]): Tiers {
  const out: Tiers = {}
  for (const raw of positionals) {
    const eq = raw.indexOf('=')
    const tier = eq === -1 ? raw : raw.slice(0, eq)
    const model = eq === -1 ? '' : raw.slice(eq + 1).trim()
    if (!isModelTier(tier)) throw new CliError(`"${safeLine(raw).slice(0, 60)}" is not <tier>=<model>; the tiers are ${MODEL_TIERS.join(', ')}.`, EXIT.usage)
    if (eq === -1 || model === '') throw new CliError(`Give the model for ${tier}: ${tier}=<model id> (or --reset ${tier}).`, EXIT.usage)
    if (!MODEL_ID_RE.test(model)) throw new CliError(`"${safeLine(model).slice(0, 60)}" is not a model id (one word, at most 200 characters).`, EXIT.usage)
    if (out[tier] !== undefined) throw new CliError(`${tier} is given twice.`, EXIT.usage)
    out[tier] = model
  }
  return out
}

/** Levenshtein distance (short model ids only). */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = up
    }
  }
  return prev[b.length]
}

/** Up to five catalog ids close to `wanted`: ids containing it, ids it contains, then by edit distance. */
export function closeModelIds(wanted: string, ids: readonly string[]): string[] {
  const w = wanted.toLowerCase()
  const limit = Math.max(2, Math.floor(w.length / 3))
  return ids
    .map((id) => {
      const l = id.toLowerCase()
      return { id, rank: l.includes(w) ? 0 : w.includes(l) ? 1 : 2, d: editDistance(w, l) }
    })
    .filter((x) => x.rank < 2 || x.d <= limit)
    .sort((a, b) => a.rank - b.rank || a.d - b.d || a.id.localeCompare(b.id))
    .slice(0, 5)
    .map((x) => x.id)
}

/** One tier row of `connections tier`: the mapped model with its catalog facts, or unmapped. */
export interface TierRow {
  tier: ModelTier
  model: string | null
  automatic: boolean
  inCatalog: boolean
  source: ProviderModel['source'] | null
  contextWindow: number | null
}

export function tierRows(connection: ProviderConnection, catalog: readonly ProviderModel[]): TierRow[] {
  const byId = new Map(catalog.map((m) => [m.id, m]))
  return MODEL_TIERS.map((tier) => {
    const model = connection.tierModels[tier]?.trim() || null
    const m = model ? byId.get(model) : undefined
    return { tier, model, automatic: !!model && (connection.autoTiers?.includes(tier) ?? false), inCatalog: !!m, source: m?.source ?? null, contextWindow: m?.contextWindow ?? null }
  })
}

const contextText = (n: number | null): string => (n === null ? 'context unknown' : n >= 1_000_000 && n % 1_000_000 === 0 ? `${n / 1_000_000}M context` : n >= 1000 ? `${Math.round(n / 1000)}k context` : `${n} context`)

function tierRowLines(rows: readonly TierRow[]): string[] {
  const width = Math.max(...MODEL_TIERS.map((t) => t.length))
  return rows.map((r) => {
    const name = r.tier.padEnd(width)
    if (!r.model) return `  ${name}  unmapped`
    const facts = r.inCatalog ? [r.source ?? '', contextText(r.contextWindow)].filter(Boolean) : ['not in the catalog']
    if (r.automatic) facts.push('automatic')
    return `  ${name}  ${safeLine(r.model)}  (${facts.join(', ')})`
  })
}

const tierRowJson = (r: TierRow): Json => ({ ...r })

/** One role a tier change touches. */
export interface AffectedRole {
  projectId: string
  projectName: string
  roleId: string
  roleName: string
  tier: ModelTier
  /** 'remapped': its model moved; 'kept': picked by hand, left on its model. */
  outcome: 'remapped' | 'kept'
  from: string
  to: string
}

/**
 * The roles on `connection` whose tier changed, with what the remap did to each (`changes`, keyed by project id; the
 * host's projects.remapped results, or the preview). Pure; exported for tests.
 */
export function affectedRoles(projects: readonly Project[], connection: ConnectionId, changed: readonly ModelTier[], changes: ReadonlyMap<string, RemapResult['changes']>): AffectedRole[] {
  const out: AffectedRole[] = []
  for (const p of projects) {
    const moved = changes.get(p.id) ?? []
    for (const r of p.roles ?? []) {
      if (!r.tier || !changed.includes(r.tier) || r.model === 'inherit' || roleConnection(r, p) !== connection) continue
      const hit = moved.find((c) => c.roleId === r.id)
      out.push({ projectId: p.id, projectName: p.name, roleId: r.id, roleName: r.name, tier: r.tier, outcome: hit ? 'remapped' : 'kept', from: hit?.from ?? r.model, to: hit?.to ?? r.model })
    }
  }
  return out
}

function affectedLines(rows: readonly AffectedRole[], dryRun: boolean): string[] {
  if (rows.length === 0) return ['No project role uses the changed tiers.']
  return [
    dryRun ? 'Roles this would touch:' : 'Roles on the changed tiers:',
    ...rows.map((a) =>
      a.outcome === 'remapped'
        ? `  ${safeLine(a.projectName)} / ${safeLine(a.roleName)} (${a.tier}): ${safeLine(a.from)} -> ${safeLine(a.to)}`
        : `  ${safeLine(a.projectName)} / ${safeLine(a.roleName)} (${a.tier}): kept ${safeLine(a.from)} (picked by hand)`
    )
  ]
}

/** Swappable in tests: discovery's tier choice (main/connections/catalog.ts, what ConnectionService.retier uses). */
export const tierDeps = { suggest: suggestTierModels }

const runTier = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { reset: { type: 'string', multiple: true }, force: { type: 'boolean' }, 'dry-run': { type: 'boolean' } })
  const id = connectionArg(positionals[0])
  const pairs = parseTierPairs(positionals.slice(1))
  const resets: ModelTier[] = []
  for (const t of values.reset ?? []) {
    if (!isModelTier(t)) throw new CliError(`--reset takes a tier: ${MODEL_TIERS.join(', ')}.`, EXIT.usage)
    if (pairs[t] !== undefined) throw new CliError(`${t} is both set and reset.`, EXIT.usage)
    if (!resets.includes(t)) resets.push(t)
  }
  const changing = Object.keys(pairs).length > 0 || resets.length > 0
  if (!changing && (values.force || values['dry-run'])) throw new CliError('--force and --dry-run go with <tier>=<model> or --reset.', EXIT.usage)

  return withHost(ctx, changing && !values['dry-run'] ? CONFIGURE : READ, async (client) => {
    const current = (await listInfos(client)).find((i) => i.connection.id === id)
    if (!current) throw new CliError(`The host did not list ${labelOfId(id)}.`, EXIT.failure)
    const label = connectionLabel(current.connection)
    const catalogRaw = await hostCall<ProviderModel[]>(client, 'models:list', [{ connection: id }])
    const catalog = (Array.isArray(catalogRaw) ? catalogRaw : []).filter((m) => m.connection === id)

    if (!changing) {
      const rows = tierRows(current.connection, catalog)
      emit(ctx, { connection: id, label, tiers: rows.map(tierRowJson) }, () => [`${label} (${id}) tiers:`, ...tierRowLines(rows)])
      return EXIT.ok
    }

    // Validate every pair against the catalog before anything is sent.
    const ids = catalog.map((m) => m.id)
    const known = new Set(ids)
    const forced: string[] = []
    for (const [tier, model] of Object.entries(pairs) as [ModelTier, string][]) {
      if (known.has(model)) continue
      if (values.force) {
        forced.push(model)
        continue
      }
      const close = closeModelIds(model, ids)
      throw new CliError(
        `${safeLine(model)} (${tier}) is not in ${label}'s catalog.${close.length ? ` Close matches: ${close.map(safeLine).join(', ')}.` : ''} See \`orgai models list --connection ${id}\`; --force sends it anyway.`,
        EXIT.usage
      )
    }
    const suggestion = resets.length ? tierDeps.suggest(id, catalog) : {}
    const before: Tiers = { ...current.connection.tierModels }
    const next: Tiers = { ...before, ...pairs }
    const unresolved: ModelTier[] = []
    for (const t of resets) {
      const want = suggestion[t]
      if (want) next[t] = want
      else {
        delete next[t]
        unresolved.push(t)
      }
    }
    const changed = MODEL_TIERS.filter((t) => (next[t] ?? '') !== (before[t] ?? ''))
    const changeJson = changed.map((t) => ({ tier: t, from: before[t] ?? null, to: next[t] ?? null }))
    const changeLines = changed.map((t) => `  ${t}: ${safeLine(before[t] ?? 'unmapped')} -> ${safeLine(next[t] ?? 'unmapped')}`)
    const notes = [
      ...(forced.length ? [`Not in the catalog (sent with --force): ${forced.map(safeLine).join(', ')}.`] : []),
      ...(unresolved.length ? [`Discovery has no model for ${unresolved.join(', ')}; ${unresolved.length === 1 ? 'it is' : 'they are'} left unmapped.`] : [])
    ]

    if (changed.length === 0) {
      emit(ctx, { connection: id, label, applied: false, dryRun: !!values['dry-run'], changes: [], affected: [], notes, tiers: tierRows(current.connection, catalog).map(tierRowJson) }, () => [
        `${label}: no tier changes.`,
        ...notes
      ])
      return EXIT.ok
    }

    if (values['dry-run']) {
      // The same pure remap the host runs on a tier change (ConnectionService.remapConnectionProjects).
      const projects = await hostCall<Project[]>(client, 'projects:list', [])
      const list = (Array.isArray(projects) ? projects : []).filter((p) => projectConnection(p) === id || p.roles.some((r) => roleConnection(r, p) === id))
      const changes = new Map<string, RemapResult['changes']>()
      for (const p of list) {
        const out = remapProject(p, { connection: id, tierModels: next, previousTierModels: before, catalog, reason: 'tierModels', include: (r) => roleConnection(r, p) === id })
        changes.set(p.id, out.result.changes)
      }
      const affected = affectedRoles(list, id, changed, changes)
      emit(ctx, { connection: id, label, applied: false, dryRun: true, changes: changeJson, affected: affected as unknown as Json[], notes }, () => [
        `${label}: would change`,
        ...changeLines,
        ...affectedLines(affected, true),
        ...notes,
        'Nothing was saved. Run again without --dry-run to apply.'
      ])
      return EXIT.ok
    }

    const remaps: RemapResult[] = []
    const off = await subscribeTopics(client, ['connections'], (_ch, payload) => {
      const e = payload as ConnectionEvent | undefined
      if (e?.type === 'projects.remapped' && Array.isArray(e.results)) remaps.push(...e.results.filter((r) => r.connection === id))
    })
    try {
      const info = await refusable<ConnectionInfo>(client, 'connections:update', [{ ...current.connection, tierModels: next } as ProviderConnection])
      // The remap broadcast goes out before the reply on the same socket; one more tick for safety.
      await new Promise((r) => setTimeout(r, 20))
      const projects = await client.call<Project[]>('projects:list', []).catch(() => [] as Project[])
      const changes = new Map<string, RemapResult['changes']>()
      for (const r of remaps) changes.set(r.projectId, [...(changes.get(r.projectId) ?? []), ...r.changes])
      const affected = affectedRoles(Array.isArray(projects) ? projects : [], id, changed, changes)
      const rows = tierRows(info.connection, catalog)
      emit(ctx, { connection: id, label, applied: true, dryRun: false, changes: changeJson, affected: affected as unknown as Json[], remapped: remaps as unknown as Json[], notes, tiers: rows.map(tierRowJson) }, () => [
        `${label}: tiers saved`,
        ...changeLines,
        ...affectedLines(affected, false),
        ...notes,
        `${label} (${id}) tiers:`,
        ...tierRowLines(rows)
      ])
      return EXIT.ok
    } finally {
      off()
    }
  })
}

export const runConnections: CommandFn = (ctx, args) =>
  runSubcommands(
    ctx,
    args,
    { list: runList, show: runShow, test: runTest, connect: runConnect, login: runLogin, logout: runLogout, 'set-default': runSetDefault, 'set-secret': runSetSecret, update: runUpdate, proxy: runProxy, tier: runTier },
    USAGE
  )
