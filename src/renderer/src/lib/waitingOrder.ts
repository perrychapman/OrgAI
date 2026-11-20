/**
 * The order of the Waiting on you rows (docs/design/dashboard-overhaul.md 7.2). Pure: no store, no DOM.
 *
 * By kind weight, then run start (oldest first), then key. A blocked plan or a question stops the whole run, a
 * permission one agent, so the first come first. The order is recomputed only when the set of keys changes: a row
 * that stays keeps its place (an event on another row never moves it under the pointer), and a new key is placed by
 * the rule among the rows already shown.
 */

/** Lower weighs first. 'team' (a team-files approval) has no run behind it and comes last. */
export const WAITING_KIND_WEIGHT: Readonly<Record<string, number>> = {
  plan: 0,
  question: 1,
  permission: 2,
  merge: 3,
  proposal: 4,
  install: 5,
  rules: 6,
  team: 7
}

/** What the order reads of one row. */
export interface WaitingOrderFacts {
  key: string
  kind: string
  /** Start of the run behind the decision (epoch ms); 0 when there is none. */
  start: number
}

const weightOf = (kind: string): number => WAITING_KIND_WEIGHT[kind] ?? Object.keys(WAITING_KIND_WEIGHT).length

/** The rule: kind weight, then run start, then key. */
export function compareWaiting(a: WaitingOrderFacts, b: WaitingOrderFacts): number {
  return weightOf(a.kind) - weightOf(b.kind) || a.start - b.start || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
}

/**
 * `items` arranged for the page. `previous` is the keys in the order last shown: rows still present keep that
 * relative order, rows that left drop out, and each new row goes before the first row it ranks ahead of by
 * `compareWaiting` (else last). With no `previous` this is a plain sort. Duplicate keys keep their first row.
 */
export function waitingOrder<T>(items: readonly T[], facts: (item: T) => WaitingOrderFacts, previous: readonly string[] = []): T[] {
  const byKey = new Map<string, { item: T; facts: WaitingOrderFacts }>()
  for (const item of items) {
    const f = facts(item)
    if (!byKey.has(f.key)) byKey.set(f.key, { item, facts: f })
  }
  const kept: string[] = []
  const placed = new Set<string>()
  for (const key of previous) {
    if (byKey.has(key) && !placed.has(key)) {
      kept.push(key)
      placed.add(key)
    }
  }
  const fresh = [...byKey.values()].filter((e) => !placed.has(e.facts.key)).sort((a, b) => compareWaiting(a.facts, b.facts))
  const order = kept
  for (const e of fresh) {
    const at = order.findIndex((k) => compareWaiting(e.facts, (byKey.get(k) as { facts: WaitingOrderFacts }).facts) < 0)
    if (at < 0) order.push(e.facts.key)
    else order.splice(at, 0, e.facts.key)
  }
  return order.map((k) => (byKey.get(k) as { item: T }).item)
}

/** The keys of an ordered list, to carry as `previous`. */
export function orderKeys<T>(items: readonly T[], facts: (item: T) => WaitingOrderFacts): string[] {
  return items.map((it) => facts(it).key)
}
