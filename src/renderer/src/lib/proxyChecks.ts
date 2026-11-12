import type { ConnectionChecks } from '@shared/types'

export interface CheckLine {
  /** reached | key | models */
  check: 'reached' | 'key' | 'models'
  /** true = passed, false = failed, null = not determined */
  ok: boolean | null
  text: string
}

/** The up-to-three result lines of Test and connect. Empty when the status carries no checks. */
export function checkLines(checks: ConnectionChecks | undefined, host: string): CheckLine[] {
  if (!checks) return []
  const lines: CheckLine[] = [
    { check: 'reached', ok: checks.reached, text: checks.reached ? `Reached ${host || 'the proxy'}` : `Could not reach ${host || 'the proxy'}` }
  ]
  if (checks.reached) {
    if (checks.keyAccepted === true) lines.push({ check: 'key', ok: true, text: 'Key accepted' })
    else if (checks.keyAccepted === false) lines.push({ check: 'key', ok: false, text: 'The key was refused' })
    if (checks.modelCount !== null) {
      lines.push({ check: 'models', ok: checks.modelCount > 0, text: checks.modelCount === 1 ? '1 model listed' : `${checks.modelCount} models listed` })
    }
  }
  return lines
}

/** One sentence on what the proxy reports, or null when nothing is known yet. */
export function reportsNote(checks: ConnectionChecks | undefined): string | null {
  if (!checks || !checks.reached) return null
  const { reportsPrices: prices, reportsSpend: spend } = checks
  if (prices === false && spend === false) return 'This proxy does not report prices or spend. Costs for its models show as unknown until you set a price.'
  if (prices === true && spend === true) return 'This proxy reports prices and spend.'
  if (prices === true && spend === false) return 'This proxy reports prices but not spend. Run costs are estimated from its prices.'
  if (prices === false && spend === true) return 'This proxy reports spend but not prices. Costs for its models show as unknown until you set a price.'
  if (prices === false) return 'This proxy does not report prices. Costs for its models show as unknown until you set a price.'
  if (spend === false) return 'This proxy does not report spend.'
  if (prices === true) return 'This proxy reports prices.'
  if (spend === true) return 'This proxy reports spend.'
  return null
}

/** Main's detail when it dropped the stored key because the address moved to another host. */
export const KEY_REMOVED_RE = /saved key was removed/i
