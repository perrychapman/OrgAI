/**
 * WP-C doctor checks (cli-standalone.md 6.1, 6.2): the Claude runtime the resolver finds (claudeBinary.ts
 * claudeExecutable, the same call runs and the connection probe make) and Codex (codexBinary.ts: ORGAI_CODEX_PATH, the
 * bundled package, PATH) with its version against the tested range. Read only: no host, no network; the only process
 * started is `codex --version` on a native binary the lookup found (never a shim). Never throws.
 *
 * Statuses: no Claude runtime fails (every Anthropic run needs one), but only warns when a running host says the
 * Anthropic connection is not in use (not the default, no project on it; defaults.ts connectionInUse); Codex is
 * optional (only the OpenAI connection uses it), so a missing Codex is ok and a Codex OrgAI would refuse warns.
 *
 * Both checks resolve in this CLI process, with its environment and bundle folder. A running host (the desktop app or
 * the daemon) resolves with its own (ORGAI_CLAUDE_PATH / ORGAI_CODEX_PATH set only in this shell do not reach a
 * Finder-launched app), so every detail says whose view it is (RUNTIME_VIEW_NOTE). No host channel reports the host's
 * own resolution yet.
 */
import { CLAUDE_SOURCE_LABEL, claudeExecutable, claudeResolutionMessage, type ClaudeExecutableResolution } from '../../main/runtime/claudeBinary'
import { CODEX_NOT_INSTALLED_MESSAGE, CODEX_SOURCE_LABEL, checkCodexBinary, lookupCodexBinary, type CodexLookup, type CodexRuntimeCheck, type CodexBinary } from '../../main/runtime/codexBinary'
import { connectionInUse } from '../../shared/defaults'
import type { AppSettings, Project } from '../../shared/types'
import type { HostClient } from '../types'
import type { DoctorCheck } from '../commands/doctor'
import type { DoctorCheckGroup } from './types'

/** Appended to every runtime detail: the resolution is this CLI process's, not the running host's. */
export const RUNTIME_VIEW_NOTE = 'as seen by this CLI process; a running OrgAI resolves with its own environment'

const viewed = (detail: string): string => `${detail} (${RUNTIME_VIEW_NOTE})`

/** Injectable probes (tests). */
export const runtimeCheckProbes = {
  claude: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ClaudeExecutableResolution => claudeExecutable(env, { platform }),
  codexLookup: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): CodexLookup => lookupCodexBinary({ env, platform }),
  codexCheck: (binary: CodexBinary): Promise<CodexRuntimeCheck> => checkCodexBinary(binary)
}

/**
 * Whether the running host uses the Anthropic connection: true / false from its settings and projects (read scope),
 * undefined when no host answered (then a missing runtime still fails: most setups use Anthropic).
 */
export async function anthropicInUse(client: HostClient | undefined): Promise<boolean | undefined> {
  if (!client) return undefined
  try {
    const [settings, projects] = await Promise.all([client.call<AppSettings>('settings:get', []), client.call<Project[]>('projects:list', [])])
    if (!settings || typeof settings !== 'object') return undefined
    const list = (Array.isArray(projects) ? projects : []).filter((p): p is Project => !!p && typeof p === 'object' && !!p.provider && typeof p.provider === 'object')
    return connectionInUse('anthropic', settings, list)
  } catch {
    return undefined
  }
}

/** `inUse` is asked only when no runtime was found (it may call the host). */
export async function claudeRuntimeCheck(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, inUse: () => Promise<boolean | undefined> = async () => undefined): Promise<DoctorCheck> {
  const r = runtimeCheckProbes.claude(env, platform)
  if (r.ok) return { id: 'claude-runtime', status: 'ok', detail: viewed(`${r.path} (from ${CLAUDE_SOURCE_LABEL[r.source]})`) }
  if ((await inUse()) === false) {
    return { id: 'claude-runtime', status: 'warn', detail: viewed(`${claudeResolutionMessage(r)} Only the Anthropic connection needs it, and it is not in use`) }
  }
  return { id: 'claude-runtime', status: 'fail', detail: viewed(claudeResolutionMessage(r)) }
}

export async function codexRuntimeCheck(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<DoctorCheck> {
  const found = runtimeCheckProbes.codexLookup(env, platform)
  if (!found.binary) {
    const problem = found.problem ?? CODEX_NOT_INSTALLED_MESSAGE
    // Not installed at all is fine (only the OpenAI connection needs Codex); a Codex OrgAI cannot use is not.
    return problem === CODEX_NOT_INSTALLED_MESSAGE
      ? { id: 'codex-runtime', status: 'ok', detail: viewed(`Not installed (only the OpenAI connection needs it). ${CODEX_NOT_INSTALLED_MESSAGE}`) }
      : { id: 'codex-runtime', status: 'warn', detail: viewed(problem) }
  }
  const b = found.binary
  const where = `${b.path} (from ${CODEX_SOURCE_LABEL[b.source ?? 'path']}${b.via ? `, through ${b.via}` : ''})`
  const check = await runtimeCheckProbes.codexCheck(b)
  if (!check.ok) return { id: 'codex-runtime', status: 'warn', detail: viewed(`${where}: ${check.reason}`) }
  if (check.warning) return { id: 'codex-runtime', status: 'warn', detail: viewed(`${where}: ${check.warning}`) }
  return { id: 'codex-runtime', status: 'ok', detail: viewed(`Codex ${check.version ?? '(version unknown)'} at ${where}`) }
}

export const runtimeChecks: DoctorCheckGroup = async ({ ctx, client }) => {
  const out: DoctorCheck[] = []
  try {
    out.push(await claudeRuntimeCheck(ctx.env, ctx.platform, () => anthropicInUse(client)))
  } catch (e) {
    out.push({ id: 'claude-runtime', status: 'warn', detail: `Could not look for the Claude runtime: ${(e as Error)?.message ?? String(e)}` })
  }
  try {
    out.push(await codexRuntimeCheck(ctx.env, ctx.platform))
  } catch (e) {
    out.push({ id: 'codex-runtime', status: 'warn', detail: `Could not look for Codex: ${(e as Error)?.message ?? String(e)}` })
  }
  return out
}
