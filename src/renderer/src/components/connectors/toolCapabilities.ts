import type { ConnectorInfo, ConnectorVariant } from '@shared/types'

/**
 * "The team can / could" for a service on Tools and services (ui-overhaul Tools board), from data the renderer
 * already has and nothing else: the service's own description, the connector variant's label and readOnly flag, the
 * projects that link the library entry and its OAuth token expiry. OrgAI passes the whole server to every role that
 * may use it; it does not filter tools. So nothing here is worded as an OrgAI-enforced limit: a read-only variant is
 * "declared read-only by the preset; the service enforces it".
 */
export interface ToolCapabilities {
  /** 'can' only when connected and at least one project uses it; 'could' otherwise. */
  mode: 'can' | 'could'
  can: string[]
  /** What the preset declares the connection is not set up for (enforced by the service, not by OrgAI). */
  cannot: string[]
  /** Projects that link the library entry (names). Empty when none or not added. */
  projects: string[]
  /** One line about the sign-in when it needs attention (an expired token on an entry that is not connected). */
  signIn?: string
}

export function variantOf(info: ConnectorInfo): ConnectorVariant | undefined {
  const def = info.connector
  const id = info.variant ?? def.defaultVariant
  return def.variants.find((v) => v.id === id) ?? def.variants[0]
}

function sentence(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ')
  return t.endsWith('.') ? t.slice(0, -1) : t
}

/** Format an ISO timestamp as "18 Nov 2026" (local date). Unknown or invalid: undefined. */
export function shortDate(iso: string | undefined, locale?: string): string | undefined {
  if (!iso) return undefined
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return undefined
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function toolCapabilities(info: ConnectorInfo, now: number = Date.now(), locale?: string): ToolCapabilities {
  const v = variantOf(info)
  const projects = (info.library?.usedBy ?? []).map((u) => u.projectName)
  const can: string[] = []
  const cannot: string[] = []
  // The service's own one-liner says what it does; a variant's description can be a host name, so it is not used here.
  if (info.connector.description) can.push(sentence(info.connector.description))
  if (v) {
    if (v.readOnly) {
      can.push(`Read tools only (${v.label})`)
      cannot.push('Use write tools: the preset declares this connection read-only, and the service enforces it')
    } else {
      can.push(`Read and write, as far as the service and your account allow (${v.label})`)
    }
  }
  let signIn: string | undefined
  const exp = info.library?.auth.expiresAt
  // A connected entry's access token is refreshed by main, so its expiry is only worth a word when something is wrong.
  if (exp && (info.state === 'needsSetup' || info.state === 'error')) {
    const when = shortDate(exp, locale)
    if (when) signIn = new Date(exp).getTime() <= now ? `The sign-in expired on ${when}.` : `The sign-in is valid until ${when}.`
  }
  return { mode: info.state === 'connected' && projects.length > 0 ? 'can' : 'could', can, cannot, projects, signIn }
}
