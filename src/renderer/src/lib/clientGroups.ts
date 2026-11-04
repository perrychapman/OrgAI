import { projectKindOf } from '@shared/defaults'

/** Sidebar grouping of engagements by client. Pure; client text is the user's own words and is only ever shown as text. */

export const CLIENT_GROUPS_KEY = 'orgai.sidebarClientGroups'
export const OTHER_GROUP_KEY = '\u0000other'
export const CODE_GROUP_KEY = '\u0000code'

export interface ClientGroupItem {
  id: string
  kind?: unknown
  client?: unknown
}

export interface ClientGroup<T extends ClientGroupItem> {
  key: string
  /** Header text without the count: the first-seen spelling, "Other" or "Code". */
  label: string
  type: 'client' | 'other' | 'code'
  items: T[]
}

export interface ClientGrouping<T extends ClientGroupItem> {
  /** Headers show only with two or more distinct real client names. */
  showHeaders: boolean
  groups: ClientGroup<T>[]
}

/** Trimmed client text, or '' when missing or not a string. */
export function clientOf(item: { client?: unknown }): string {
  return typeof item.client === 'string' ? item.client.trim() : ''
}

/** Case-insensitive group key for a client name. */
export function clientKey(client: string): string {
  return client.trim().toLowerCase()
}

/**
 * Client groups in first-seen order, then "Other" (engagements without a client), then "Code" (code projects).
 * Row order within a group is the input order. With fewer than two distinct clients there is one group per
 * non-empty kind but `showHeaders` is false, so the caller renders today's flat list.
 */
export function groupByClient<T extends ClientGroupItem>(items: T[]): ClientGrouping<T> {
  const clients = new Map<string, ClientGroup<T>>()
  const other: T[] = []
  const code: T[] = []
  for (const it of items) {
    if (projectKindOf(it) !== 'engagement') {
      code.push(it)
      continue
    }
    const name = clientOf(it)
    if (!name) {
      other.push(it)
      continue
    }
    const key = clientKey(name)
    const g = clients.get(key)
    if (g) g.items.push(it)
    else clients.set(key, { key, label: name, type: 'client', items: [it] })
  }
  const groups: ClientGroup<T>[] = [...clients.values()]
  if (other.length > 0) groups.push({ key: OTHER_GROUP_KEY, label: 'Other', type: 'other', items: other })
  if (code.length > 0) groups.push({ key: CODE_GROUP_KEY, label: 'Code', type: 'code', items: code })
  return { showHeaders: clients.size >= 2, groups }
}

/** Read the collapsed keys; junk gives an empty set. */
export function readCollapsedClients(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): Set<string> {
  try {
    const raw = storage?.getItem(CLIENT_GROUPS_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((k): k is string => typeof k === 'string').slice(0, 500))
  } catch {
    return new Set()
  }
}

export function writeCollapsedClients(keys: ReadonlySet<string>, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  try {
    storage?.setItem(CLIENT_GROUPS_KEY, JSON.stringify([...keys].slice(0, 500)))
  } catch {
    // Storage may be unavailable or full; the state then lasts for the session only.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}
