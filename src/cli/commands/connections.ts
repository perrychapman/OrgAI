/**
 * `orgai connections` (cli-spec 6.3, Wave 5): the app-wide model connections (anthropic, openai, litellm).
 *
 *   list | show <id>                      read
 *   test <id>                             operate: exit 0 connected, 5 disconnected or an auth error, 1 otherwise
 *   connect <id>                          configure: enables, probes, discovers models and remaps roles
 *   login openai [--device-code|--browser] configure: the ChatGPT sign-in (cli-spec 6.3(5)); device code by default
 *                                         over SSH or on Linux without a display
 *   logout <id> [--yes] | set-default <id|auto> | set-secret litellm (--from-env VAR | --stdin | --clear)
 *   update <id> [--base-url <url|none>] [--enable|--disable]
 *
 * Secrets never travel on argv and are never printed (the LiteLLM key goes in through readSecretValue only).
 */
import { CONNECTION_IDS, type AppSettings, type ConnectionEvent, type ConnectionId, type ConnectionInfo, type ConnectionLoginMethod, type ConnectionLoginStart, type ConnectionLoginUpdate, type ConnectionStatus, type HostScope, type Project, type ProviderConnection, type RemapResult } from '../../shared/types'
import { formatDateTime } from '../../shared/view/dates'
import { parseFlags } from '../flags'
import { confirm, hostCall, isRemoteSession, readSecretValue, runSubcommands, subscribeTopics, withHost } from '../manage'
import { emit, emitLine, isJsonOutput, printText, safeLine, styleFor, table, termWidth, warn, type Json } from '../output'
import { CliError, EXIT, type CliContext, type CommandFn, type HostClient } from '../types'

export const READ: HostScope[] = ['read']
export const OPERATE: HostScope[] = ['read', 'operate']
export const CONFIGURE: HostScope[] = ['read', 'configure']

export const CONNECTION_LABELS: Record<ConnectionId, string> = { anthropic: 'Anthropic', openai: 'OpenAI', litellm: 'LiteLLM' }

const USAGE = 'connections <list|show|test|connect|login|logout|set-default|set-secret|update> [options]'

/** A connection id argument; anything else is exit 2. */
export function connectionArg(raw: string | undefined, what = 'a connection'): ConnectionId {
  if (raw === undefined) throw new CliError(`Name ${what}: ${CONNECTION_IDS.join(', ')}.`, EXIT.usage)
  if (!(CONNECTION_IDS as readonly string[]).includes(raw)) throw new CliError(`Unknown connection "${safeLine(raw).slice(0, 40)}". Use one of: ${CONNECTION_IDS.join(', ')}.`, EXIT.usage)
  return raw as ConnectionId
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
    label: CONNECTION_LABELS[c.id],
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
    ...(c.id === 'anthropic' ? { auth: c.auth.kind } : {}),
    ...(c.id === 'openai' ? { auth: c.auth.kind, ...(c.auth.kind === 'apiKey' ? { envVar: c.auth.envVar } : {}) } : {}),
    ...(c.id === 'litellm' ? { baseUrl: c.baseUrl, hasApiKey: c.hasApiKey } : {})
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

const runList = async (ctx: CliContext, args: string[]): Promise<number> => {
  noPositionals(parseFlags(args, {}).positionals)
  return withHost(ctx, READ, async (client) => {
    const infos = await listInfos(client)
    const mode = defaultModeOf(await settingsOf(client))
    emit(ctx, { connections: infos.map((i) => connectionJson(i, mode)) }, () => {
      const st = styleFor(ctx)
      return table(
        [{ header: 'CONNECTION', min: 9 }, { header: 'ENABLED', min: 3 }, { header: 'STATUS', min: 6 }, { header: 'ACCOUNT', flex: true, min: 6 }, { header: 'DEFAULT', min: 7 }],
        infos.map((i) => [
          `${i.connection.id} (${CONNECTION_LABELS[i.connection.id]})`,
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
  const lines = [`${CONNECTION_LABELS[c.id]} (${c.id})`, `  Enabled: ${c.enabled ? 'yes' : 'no'}`, `  Status: ${statusLine(info.status)}`]
  if (info.status.account) lines.push(`  Account: ${safeLine(info.status.account)}`)
  if (info.isDefault) lines.push(`  ${defaultWord(mode)}`)
  if (c.id === 'anthropic') lines.push(`  Auth: ${safeLine(c.auth.kind)}`)
  if (c.id === 'openai') lines.push(`  Auth: ${c.auth.kind === 'apiKey' ? `API key from ${safeLine(c.auth.envVar)}` : 'ChatGPT sign-in'}`)
  if (c.id === 'litellm') {
    lines.push(`  Base URL: ${c.baseUrl ? safeLine(c.baseUrl) : '(not set)'}`)
    lines.push(`  API key: ${c.hasApiKey ? 'stored' : 'not set'}`)
  }
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
    if (!info) throw new CliError(`The host did not list ${CONNECTION_LABELS[id]}.`, EXIT.failure)
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
    emit(ctx, { id, status: status.state, ...(status.detail ? { detail: status.detail } : {}), ...(status.account ? { account: status.account } : {}), ok: code === EXIT.ok }, () => [
      `${CONNECTION_LABELS[id]}: ${statusLine(status)}`,
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
      emit(ctx, { connection: connectionJson(info), remapped: remaps }, () => [`${CONNECTION_LABELS[id]}: ${statusLine(info.status)}`, ...remapLines(remaps, Array.isArray(projects) ? projects : [])])
      return code
    } finally {
      off()
    }
  })
}

// ---------- login ----------

/** Swappable in tests: how long a sign-in may wait for its result. */
export const loginDeps = { timeoutMs: 15 * 60_000 }

const LOGIN_HINTS: Record<Exclude<ConnectionId, 'openai'>, string> = {
  anthropic: 'Anthropic has no sign-in here: run `claude` and type /login, or set an API key, then `orgai connections test anthropic`.',
  litellm: 'LiteLLM has no sign-in: store its key with `orgai connections set-secret litellm --from-env VAR` (or --stdin).'
}

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
  if (id !== 'openai') throw new CliError(LOGIN_HINTS[id], EXIT.usage)
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
  if (!(await confirm(ctx, `Sign out of ${CONNECTION_LABELS[id]}?`, !!values.yes))) {
    printText(ctx, 'Nothing changed.')
    return EXIT.failure
  }
  return withHost(ctx, CONFIGURE, async (client) => {
    const info = await hostCall<ConnectionInfo>(client, 'connections:logout', [id])
    emit(ctx, { connection: connectionJson(info) }, () => [`${CONNECTION_LABELS[id]}: ${statusLine(info.status)}`])
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
      def ? `Default connection: ${CONNECTION_LABELS[def.connection.id]} (${mode === 'chosen' ? 'Chosen' : 'Automatic'}).` : 'Default connection updated.'
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
  if (id !== 'litellm') throw new CliError(`Only LiteLLM keeps a key in OrgAI. ${id === 'anthropic' ? LOGIN_HINTS.anthropic : 'Sign in to OpenAI with `orgai connections login openai`.'}`, EXIT.usage)
  if (values.clear && (values['from-env'] !== undefined || values.stdin)) throw new CliError('--clear takes no key; leave out --from-env and --stdin.', EXIT.usage)
  const apiKey = values.clear ? null : await readSecretValue(ctx, { fromEnv: values['from-env'], stdin: values.stdin, what: 'the LiteLLM API key' })
  return withHost(ctx, CONFIGURE, async (client) => {
    const info = await refusable<ConnectionInfo>(client, 'connections:setSecret', [{ id: 'litellm', apiKey }])
    const message = apiKey === null ? 'Key removed.' : 'Key saved. Test and connect to apply.'
    emit(ctx, { id: 'litellm', hasApiKey: info.connection.id === 'litellm' ? info.connection.hasApiKey : apiKey !== null, message, status: info.status.state }, () => message)
    return EXIT.ok
  })
}

/** A --base-url value: 'none' clears it; else an http(s) URL without credentials. */
export function baseUrlArg(raw: string): string {
  if (raw === 'none' || raw === '') return ''
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new CliError(`--base-url needs an http or https URL (or none), not "${safeLine(raw).slice(0, 80)}".`, EXIT.usage)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CliError('--base-url needs an http or https URL (or none).', EXIT.usage)
  if (url.username || url.password) throw new CliError('--base-url must not carry a user name or password; store the key with set-secret.', EXIT.usage)
  return raw.replace(/\/+$/, '')
}

/** The connection record with the requested changes. */
export function updatedConnection(c: ProviderConnection, change: { baseUrl?: string; enabled?: boolean }): ProviderConnection {
  const next = { ...c, ...(change.enabled !== undefined ? { enabled: change.enabled } : {}) } as ProviderConnection
  if (change.baseUrl !== undefined) {
    if (next.id !== 'litellm') throw new CliError('Only LiteLLM has a base URL.', EXIT.usage)
    return { ...next, baseUrl: change.baseUrl }
  }
  return next
}

const runUpdate = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { 'base-url': { type: 'string' }, enable: { type: 'boolean' }, disable: { type: 'boolean' } })
  const id = connectionArg(onePositional(positionals, 'the connection'))
  if (values.enable && values.disable) throw new CliError('Give --enable or --disable, not both.', EXIT.usage)
  if (values['base-url'] === undefined && !values.enable && !values.disable) throw new CliError('Nothing to change: give --base-url, --enable or --disable.', EXIT.usage)
  if (values['base-url'] !== undefined && id !== 'litellm') throw new CliError('Only LiteLLM has a base URL.', EXIT.usage)
  const change = { ...(values['base-url'] !== undefined ? { baseUrl: baseUrlArg(values['base-url']) } : {}), ...(values.enable ? { enabled: true } : values.disable ? { enabled: false } : {}) }
  return withHost(ctx, CONFIGURE, async (client) => {
    const current = (await listInfos(client)).find((i) => i.connection.id === id)
    if (!current) throw new CliError(`The host did not list ${CONNECTION_LABELS[id]}.`, EXIT.failure)
    const info = await refusable<ConnectionInfo>(client, 'connections:update', [updatedConnection(current.connection, change)])
    const mode = defaultModeOf(await settingsOf(client))
    emit(ctx, { connection: connectionJson(info, mode) }, () => showLines(info, mode))
    return EXIT.ok
  })
}

export const runConnections: CommandFn = (ctx, args) =>
  runSubcommands(
    ctx,
    args,
    { list: runList, show: runShow, test: runTest, connect: runConnect, login: runLogin, logout: runLogout, 'set-default': runSetDefault, 'set-secret': runSetSecret, update: runUpdate },
    USAGE
  )
