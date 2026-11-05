/**
 * `orgai mcp auth` and `orgai mcp revoke` (cli-spec 6.3(5)). auth subscribes to the 'connections' topic first, then
 * calls mcp:authorize with announceUrl, so the host sends the authorization URL as connections:event `mcp.authorize`.
 * The URL is printed (it carries the PKCE challenge and state, never a token or verifier); in an SSH session the host
 * does not open a browser and the user also gets the `ssh -L` command that forwards the loopback callback. Ctrl+C
 * cancels the flow (mcp:cancelAuthorize) and exits 130. Tokens are never printed.
 */
import type { ConnectionEvent, McpAuthStatus, McpAuthTarget, McpAuthorizeInput, McpAuthorizeUrlUpdate } from '../../../shared/types'
import { parseFlags } from '../../flags'
import { confirm, hostCall, hostError, isRemoteSession, readSecretValue, requireProject, sshForwardCommand, subscribeTopics, withHost } from '../../manage'
import { emit, isJsonOutput, safeLine, warn } from '../../output'
import { CliError, EXIT, type CliContext, type HostClient } from '../../types'
import { CONFIGURE, authText, findLibrary, findServer } from './common'

/** The OAuth flow's own callback wait (src/main/mcp/oauth.ts DEFAULT_AUTH_TIMEOUT_MS, 5 minutes) plus a margin. */
export const AUTHORIZE_TIMEOUT_MS = 5 * 60_000 + 2 * 60_000

const usage = (m: string): CliError => new CliError(m, EXIT.usage)

/** The same target (library entry, or project and server). */
export function sameTarget(a: McpAuthTarget | undefined, b: McpAuthTarget): boolean {
  if (!a || typeof a !== 'object') return false
  if ('libraryId' in b) return 'libraryId' in a && a.libraryId === b.libraryId
  return 'projectId' in a && !('libraryId' in a) && a.projectId === b.projectId && a.serverId === b.serverId
}

interface Resolved {
  target: McpAuthTarget
  name: string
}

/** <server> (this project; a linked one through its library entry) or --library <id-or-name>. */
async function resolveTarget(ctx: CliContext, client: HostClient, server: string | undefined, library: string | undefined, verb: string): Promise<Resolved> {
  if ((server === undefined) === (library === undefined)) throw usage(`Usage: orgai mcp ${verb} <server> | --library <id-or-name>`)
  if (library !== undefined) {
    const lib = await findLibrary(client, library)
    return { target: { libraryId: lib.entry.id }, name: lib.entry.name }
  }
  const project = await requireProject(ctx, client)
  const s = await findServer(client, project.id, server!)
  if (s.spec.libraryId) return { target: { libraryId: s.spec.libraryId }, name: s.spec.name }
  return { target: { projectId: project.id, serverId: s.spec.id }, name: s.spec.name }
}

/** Lines for the announced URL: the forward command over SSH first, then the URL. */
export function announcementLines(ctx: CliContext, u: McpAuthorizeUrlUpdate): string[] {
  const lines: string[] = []
  const ssh = !!(ctx.env.SSH_CONNECTION || ctx.env.SSH_TTY)
  const forward = ssh && typeof u.redirectUri === 'string' ? sshForwardCommand(u.redirectUri, ctx.env) : null
  if (forward) lines.push(`Forward the callback first: ${forward}`, '(run that on your own computer and keep it open while you sign in)')
  lines.push(u.openedBrowser ? 'Opened your browser to sign in. If it did not open, use this URL:' : 'Open this URL in a browser to sign in:')
  lines.push(`  ${safeLine(u.url)}`)
  lines.push('Waiting for the sign-in to finish (Ctrl+C cancels)...')
  return lines
}

export async function mcpAuth(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, {
    library: { type: 'string' },
    'client-id': { type: 'string' },
    'client-secret-from-env': { type: 'string' },
    'client-secret-stdin': { type: 'boolean' },
    'no-browser': { type: 'boolean' },
    browser: { type: 'boolean' }
  })
  if (positionals.length > 1) throw usage(`Unexpected argument "${safeLine(positionals[1]).slice(0, 60)}".`)
  if (values['no-browser'] && values.browser) throw usage('Give --browser or --no-browser, not both.')
  const remote = isRemoteSession(ctx.env, ctx.platform)
  const openBrowser = !(values['no-browser'] || (remote && !values.browser))
  const wantsSecret = values['client-secret-from-env'] !== undefined || !!values['client-secret-stdin']
  if (values['client-id'] !== undefined && !values['client-id'].trim()) throw usage('--client-id needs a value.')
  // Read (and taken out of the environment) before withHost may start a host, which would inherit it (review M13).
  const clientSecret = wantsSecret ? await readSecretValue(ctx, { fromEnv: values['client-secret-from-env'], stdin: values['client-secret-stdin'], what: 'the OAuth client secret' }) : undefined
  return withHost(ctx, [...CONFIGURE], async (client) => {
    const { target, name } = await resolveTarget(ctx, client, positionals[0], values.library, 'auth')
    let announced: McpAuthorizeUrlUpdate | undefined
    const say = (lines: string[]): void => {
      // JSON output stays one document on stdout: the instructions go to stderr there.
      if (isJsonOutput(ctx)) for (const l of lines) warn(ctx, l)
      else ctx.io.stdout.write(`${lines.join('\n')}\n`)
    }
    const off = await subscribeTopics(client, ['connections'], (_channel, payload) => {
      const ev = payload as ConnectionEvent | undefined
      if (!ev || ev.type !== 'mcp.authorize' || !ev.authorize || typeof ev.authorize.url !== 'string') return
      if (!sameTarget(ev.authorize.target, target)) return
      announced = ev.authorize
      say(announcementLines(ctx, ev.authorize))
    })
    let interrupted = false
    let cancelling: Promise<unknown> | undefined
    const offSignal = ctx.signals.onInterrupt(() => {
      if (interrupted) return
      interrupted = true
      cancelling = client.call('mcp:cancelAuthorize', [target]).catch(() => undefined)
    })
    const input: McpAuthorizeInput = {
      ...target,
      ...(values['client-id'] !== undefined ? { clientId: values['client-id'].trim() } : {}),
      ...(clientSecret !== undefined ? { clientSecret } : {}),
      announceUrl: true,
      openBrowser
    }
    try {
      if (!isJsonOutput(ctx)) ctx.io.stdout.write(`Authorizing ${safeLine(name)}...\n`)
      let status: McpAuthStatus
      try {
        status = await client.call<McpAuthStatus>('mcp:authorize', [input], { timeoutMs: AUTHORIZE_TIMEOUT_MS })
      } catch (e) {
        if (interrupted) {
          await cancelling
          warn(ctx, 'Authorization cancelled.')
          return EXIT.sigint
        }
        throw hostError(e)
      }
      if (interrupted) {
        await cancelling
        warn(ctx, 'Authorization cancelled.')
        return EXIT.sigint
      }
      const value = { target, name, status, ...(announced ? { authorizeUrl: announced.url, ...(announced.redirectUri ? { redirectUri: announced.redirectUri } : {}), openedBrowser: announced.openedBrowser } : {}) }
      if (status.state === 'error') {
        emit(ctx, { ...value, ok: false }, () => {
          const lines = [`Could not authorize ${safeLine(name)}: ${safeLine(status.error ?? 'the authorization failed')}`]
          if (status.needsClientId) lines.push('This server has no automatic client registration: pass --client-id <id> (and --client-secret-from-env <VAR> or --client-secret-stdin if it needs a secret).')
          return lines
        })
        return EXIT.auth
      }
      emit(ctx, { ...value, ok: true }, () => `${safeLine(name)}: ${authText(status)}.`)
      return EXIT.ok
    } finally {
      offSignal()
      off()
    }
  })
}

export async function mcpRevoke(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { library: { type: 'string' }, yes: { type: 'boolean', short: 'y' } })
  if (positionals.length > 1) throw usage(`Unexpected argument "${safeLine(positionals[1]).slice(0, 60)}".`)
  return withHost(ctx, [...CONFIGURE], async (client) => {
    const { target, name } = await resolveTarget(ctx, client, positionals[0], values.library, 'revoke')
    const shared = 'libraryId' in target ? ' (every project that links it signs out too)' : ''
    if (!(await confirm(ctx, `Sign ${safeLine(name)} out and delete its stored tokens${shared}?`, !!values.yes))) {
      emit(ctx, { revoked: false }, () => 'Nothing changed.')
      return EXIT.failure
    }
    const status = await hostCall<McpAuthStatus>(client, 'mcp:revokeAuth', [target])
    emit(ctx, { target, name, revoked: true, status }, () => `Signed ${safeLine(name)} out (${authText(status)}).`)
    return EXIT.ok
  })
}
