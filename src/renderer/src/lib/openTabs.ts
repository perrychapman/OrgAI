/**
 * Open tabs that survive a relaunch (ux-review-continue M2). Per project, localStorage `orgai.openTabs.<projectId>`
 * holds the chain keys (oldest member id) of the open run tabs and the chain that was viewed. Parsing is defensive:
 * the value is untrusted text from storage.
 */

export interface OpenTabs {
  chains: string[]
  viewed?: string
}

export const OPEN_TABS_MAX = 20
const ID = /^[A-Za-z0-9_-]{1,80}$/

export const openTabsKey = (projectId: string): string => `orgai.openTabs.${projectId}`

const validId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)

/** Parses a stored value; anything malformed reads as empty. Ids that fail the pattern are dropped, duplicates collapse, at most 20 stay. */
export function parseOpenTabs(raw: string | null | undefined): OpenTabs {
  if (!raw || raw.length > 4000) return { chains: [] }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { chains: [] }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { chains: [] }
  const rec = data as Record<string, unknown>
  const chains: string[] = []
  if (Array.isArray(rec.chains)) {
    for (const c of rec.chains) {
      if (chains.length >= OPEN_TABS_MAX) break
      if (validId(c) && !chains.includes(c)) chains.push(c)
    }
  }
  return validId(rec.viewed) ? { chains, viewed: rec.viewed } : { chains }
}

export function serializeOpenTabs(tabs: OpenTabs): string {
  const chains = tabs.chains.filter(validId).slice(0, OPEN_TABS_MAX)
  return JSON.stringify({ chains, ...(tabs.viewed && validId(tabs.viewed) ? { viewed: tabs.viewed } : {}) })
}

export function readOpenTabs(projectId: string): OpenTabs {
  try {
    return parseOpenTabs(localStorage.getItem(openTabsKey(projectId)))
  } catch {
    return { chains: [] }
  }
}

export function writeOpenTabs(projectId: string, tabs: OpenTabs): void {
  try {
    localStorage.setItem(openTabsKey(projectId), serializeOpenTabs(tabs))
  } catch {
    /* storage unavailable: tabs simply do not come back */
  }
}
