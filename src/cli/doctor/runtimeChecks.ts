/**
 * WP-C doctor checks (cli-standalone.md 6.1, 6.2): the Claude runtime the resolver finds (claudeBinary.ts
 * claudeExecutable, the same call runs and the connection probe make) and Codex (codexBinary.ts: ORGAI_CODEX_PATH, the
 * bundled package, PATH) with its version against the tested range. Read only: no host, no network; the only process
 * started is `codex --version` on a native binary the lookup found (never a shim). Never throws.
 *
 * Statuses: no Claude runtime fails (every Anthropic run needs one); Codex is optional (only the OpenAI connection
 * uses it), so a missing Codex is ok and a Codex OrgAI would refuse warns.
 */
import { CLAUDE_SOURCE_LABEL, claudeExecutable, claudeResolutionMessage, type ClaudeExecutableResolution } from '../../main/runtime/claudeBinary'
import { CODEX_NOT_INSTALLED_MESSAGE, CODEX_SOURCE_LABEL, checkCodexBinary, lookupCodexBinary, type CodexLookup, type CodexRuntimeCheck, type CodexBinary } from '../../main/runtime/codexBinary'
import type { DoctorCheck } from '../commands/doctor'
import type { DoctorCheckGroup } from './types'

/** Injectable probes (tests). */
export const runtimeCheckProbes = {
  claude: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ClaudeExecutableResolution => claudeExecutable(env, { platform }),
  codexLookup: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): CodexLookup => lookupCodexBinary({ env, platform }),
  codexCheck: (binary: CodexBinary): Promise<CodexRuntimeCheck> => checkCodexBinary(binary)
}

export function claudeRuntimeCheck(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): DoctorCheck {
  const r = runtimeCheckProbes.claude(env, platform)
  if (r.ok) return { id: 'claude-runtime', status: 'ok', detail: `${r.path} (from ${CLAUDE_SOURCE_LABEL[r.source]})` }
  return { id: 'claude-runtime', status: 'fail', detail: claudeResolutionMessage(r) }
}

export async function codexRuntimeCheck(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<DoctorCheck> {
  const found = runtimeCheckProbes.codexLookup(env, platform)
  if (!found.binary) {
    const problem = found.problem ?? CODEX_NOT_INSTALLED_MESSAGE
    // Not installed at all is fine (only the OpenAI connection needs Codex); a Codex OrgAI cannot use is not.
    return problem === CODEX_NOT_INSTALLED_MESSAGE
      ? { id: 'codex-runtime', status: 'ok', detail: `Not installed (only the OpenAI connection needs it). ${CODEX_NOT_INSTALLED_MESSAGE}` }
      : { id: 'codex-runtime', status: 'warn', detail: problem }
  }
  const b = found.binary
  const where = `${b.path} (from ${CODEX_SOURCE_LABEL[b.source ?? 'path']}${b.via ? `, through ${b.via}` : ''})`
  const check = await runtimeCheckProbes.codexCheck(b)
  if (!check.ok) return { id: 'codex-runtime', status: 'warn', detail: `${where}: ${check.reason}` }
  if (check.warning) return { id: 'codex-runtime', status: 'warn', detail: `${where}: ${check.warning}` }
  return { id: 'codex-runtime', status: 'ok', detail: `Codex ${check.version ?? '(version unknown)'} at ${where}` }
}

export const runtimeChecks: DoctorCheckGroup = async ({ ctx }) => {
  const out: DoctorCheck[] = []
  try {
    out.push(claudeRuntimeCheck(ctx.env, ctx.platform))
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
