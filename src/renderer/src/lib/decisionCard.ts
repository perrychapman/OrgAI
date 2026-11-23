import { useSyncExternalStore } from 'react'
import type { MergeReview } from '@shared/types'

/**
 * Pure copy and helpers for the decision cards (UI overhaul Components board): how long a card has waited, the
 * "allowed N times" line, the merge review facts and the tray's breakdown line. Every input may be absent; absent means
 * unknown and shows nothing, never a made-up zero.
 */

export type DecisionKindName = 'permission' | 'rules' | 'question' | 'proposal' | 'install' | 'merge'

/** "just now", "2 min", "3 h", "2 d" from a start time; null for a missing, invalid or future time. */
export function waitingLabel(since: number | undefined, now: number): string | null {
  if (typeof since !== 'number' || !Number.isFinite(since) || since <= 0) return null
  const min = Math.floor((now - since) / 60_000)
  if (min < 0) return null
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} h`
  return `${Math.floor(h / 24)} d`
}

/** The absolute time for the title and the accessible description ("Raised Nov 22, 3:04 PM"). */
export function waitingAbsolute(since: number | undefined): string | null {
  if (typeof since !== 'number' || !Number.isFinite(since) || since <= 0) return null
  const d = new Date(since)
  if (Number.isNaN(d.getTime())) return null
  return `Raised ${d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
}

/** "You have allowed this 3 times"; nothing for absent, zero, negative or non-integer counts. */
export function priorAllowsLine(n: number | undefined): string | null {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return null
  return n === 1 ? 'You have allowed this once before' : `You have allowed this ${n} times`
}

export interface MergeFact {
  key: 'tests' | 'review'
  /** Visible label ("Tests"). */
  label: string
  /** Visible words, so the state never rests on colour. */
  text: string
  tone: 'ok' | 'bad' | 'unknown'
  detail?: string
}

/** Tests and review facts. Absent checks give none; 'unknown' says "not known" and is never shown as passed. */
export function mergeFacts(checks: MergeReview['checks']): MergeFact[] {
  if (!checks) return []
  const out: MergeFact[] = []
  if (checks.tests === 'passed') out.push({ key: 'tests', label: 'Tests', text: 'passed', tone: 'ok' })
  else if (checks.tests === 'failed') {
    const detail = typeof checks.testDetail === 'string' && checks.testDetail.trim() ? checks.testDetail.trim() : undefined
    out.push({ key: 'tests', label: 'Tests', text: 'failed', tone: 'bad', detail })
  } else out.push({ key: 'tests', label: 'Tests', text: 'not known', tone: 'unknown' })
  if (checks.review === 'reported') out.push({ key: 'review', label: 'Review', text: 'reported', tone: 'ok' })
  else if (checks.review === 'none') out.push({ key: 'review', label: 'Review', text: 'none reported', tone: 'unknown' })
  else out.push({ key: 'review', label: 'Review', text: 'not known', tone: 'unknown' })
  return out
}

const PLURAL: Record<DecisionKindName, [string, string]> = {
  permission: ['permission', 'permissions'],
  rules: ['rule request', 'rule requests'],
  question: ['question', 'questions'],
  proposal: ['proposal', 'proposals'],
  install: ['new tool', 'new tools'],
  merge: ['merge review', 'merge reviews']
}
const ORDER: DecisionKindName[] = ['permission', 'question', 'rules', 'proposal', 'install', 'merge']

/** "2 permissions · 1 question". Empty string for no kinds. */
export function breakdownLine(kinds: DecisionKindName[]): string {
  const counts = new Map<DecisionKindName, number>()
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1)
  return ORDER.filter((k) => counts.has(k))
    .map((k) => `${counts.get(k)} ${PLURAL[k][(counts.get(k) ?? 0) === 1 ? 0 : 1]}`)
    .join(' · ')
}

// One shared minute clock: every card reads the same snapshot, so a tick re-renders only the cards that show a time,
// once a minute, never per second.
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined
const minuteNow = (): number => Math.floor(Date.now() / 60_000) * 60_000
function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  if (!timer) timer = setInterval(() => listeners.forEach((l) => l()), 15_000)
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }
}
/** Now, rounded down to the minute; the snapshot changes at most once a minute. */
export function useMinuteNow(): number {
  return useSyncExternalStore(subscribe, minuteNow, minuteNow)
}

/** The saved-rule receipt after "Always allow" (the one real undo): the rules that answer added, and where. */
export interface AlwaysAllowReceipt {
  runId: string
  projectId: string
  rules: string[]
}
let receipt: AlwaysAllowReceipt | null = null
const receiptListeners = new Set<() => void>()
export function setAlwaysAllowReceipt(r: AlwaysAllowReceipt | null): void {
  receipt = r
  receiptListeners.forEach((l) => l())
}
export function useAlwaysAllowReceipt(): AlwaysAllowReceipt | null {
  return useSyncExternalStore(
    (cb) => {
      receiptListeners.add(cb)
      return () => receiptListeners.delete(cb)
    },
    () => receipt,
    () => null
  )
}
/** Rules present after but not before; pure. */
export function addedRules(before: string[], after: string[]): string[] {
  const had = new Set(before)
  return after.filter((r) => !had.has(r))
}
