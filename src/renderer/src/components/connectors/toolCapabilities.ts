import type { ConnectorInfo, ConnectorVariant } from '@shared/types'

/**
 * "The team can / cannot" for a service on Tools and services (ui-overhaul Tools board), from data the renderer
 * already has and nothing else: the connector variant's own label and description, its readOnly flag (the server
 * exposes only read tools, or the requested scopes are read-only: ConnectorVariant), the projects that link the
 * library entry and its OAuth token expiry. Nothing here claims a limit main does not enforce: "cannot" lines only
 * restate what the variant is set up for, and say so.
 */
export interface ToolCapabilities {
  /** 'can' once added (it is in the library), 'could' while still in the catalog. */
  mode: 'can' | 'could'
  can: string[]
  cannot: string[]
  /** Projects that link the library entry (names). Empty when none or not added. */
  projects: string[]
  /** One line about the sign-in, when known (expiry of the stored access token). */
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
  const added = info.state !== 'available'
  const can: string[] = []
  const cannot: string[] = []
  if (v) {
    const what = v.description ? sentence(v.description) : `Use ${info.connector.name}'s tools (${v.label})`
    can.push(what)
    if (v.readOnly) {
      can.push('Read tools only')
      cannot.push('Use write tools: this connection is set up read-only')
    } else {
      can.push('Read and write, as far as the service and your account allow')
    }
  }
  const projects = (info.library?.usedBy ?? []).map((u) => u.projectName)
  let signIn: string | undefined
  const exp = info.library?.auth.expiresAt
  if (exp) {
    const when = shortDate(exp, locale)
    const past = new Date(exp).getTime() <= now
    if (when) signIn = past ? `The sign-in token expired on ${when}.` : `The current sign-in token expires on ${when}.`
  }
  return { mode: added ? 'can' : 'could', can, cannot, projects, signIn }
}
