import type { McpServerSpec } from './types'

/** One secret env name a server shares with other servers. */
export interface McpSecretClash {
  envName: string
  /** Names of the other servers that need the same secret env name. */
  others: string[]
}

export type McpSecretClashSpec = Pick<McpServerSpec, 'id' | 'name' | 'transport' | 'enabled' | 'secretEnv'>

/**
 * Enabled stdio servers that share a secretEnv name with at least one other enabled stdio server, keyed by server id.
 *
 * One Codex app-server has one environment, so a run can forward only one value per secret env name: the launch
 * (codexProtocol.ts buildLaunchConfig) refuses the later server when the values differ. The renderer never sees
 * secret values, so this reports a shared NAME; whether the values differ is only known at launch. HTTP servers are
 * ignored (their secret headers travel under per-server env names). Pure, no DOM.
 */
export function secretEnvClashes(specs: readonly McpSecretClashSpec[]): Record<string, McpSecretClash[]> {
  const byName = new Map<string, McpSecretClashSpec[]>()
  for (const spec of specs) {
    if (!spec.enabled || spec.transport !== 'stdio') continue
    for (const envName of new Set(spec.secretEnv ?? [])) {
      const list = byName.get(envName) ?? []
      list.push(spec)
      byName.set(envName, list)
    }
  }
  const out: Record<string, McpSecretClash[]> = {}
  for (const [envName, list] of byName) {
    if (list.length < 2) continue
    for (const spec of list) {
      const others = list.filter((s) => s.id !== spec.id).map((s) => s.name)
      if (!others.length) continue
      ;(out[spec.id] ??= []).push({ envName, others })
    }
  }
  return out
}
