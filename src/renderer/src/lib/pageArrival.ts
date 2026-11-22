/**
 * Page arrival (docs/design/dashboard-usage-redesign/project/motion.md "Page arrival"): the Dashboard and Usage stage
 * their arrival once when the person navigates to them or the app opens on them. Returning within the same session
 * without a data change skips the staging; the page appears at rest. Pure memory here; the hook is usePageArrival.ts.
 */

export type ArrivalPage = 'dashboard' | 'usage'

/** From navigation to rest: the hero rises, six bands stagger, charts draw. Classes drop after this. */
export const ARRIVAL_REST_MS = 800

/** The data signature each page last showed in this session (module memory; a reload starts again). */
export class ArrivalMemory {
  private readonly seen = new Map<ArrivalPage, string>()

  /** Whether a mount of `page` showing `signature` stages its arrival. */
  shouldStage(page: ArrivalPage, signature: string): boolean {
    const last = this.seen.get(page)
    return last === undefined || last !== signature
  }

  /** What the page shows now (call on every signature change while mounted, so a return compares the latest). */
  record(page: ArrivalPage, signature: string): void {
    this.seen.set(page, signature)
  }

  clear(): void {
    this.seen.clear()
  }
}

export const arrivalMemory = new ArrivalMemory()

/**
 * Whether a mount stages its arrival. Only when the saved appearance is known (theme.ts isAppearanceKnown: the startup
 * cache or the settings reply), so a still-unknown saved Reduce motion never lets one through; then only with motion on
 * (the slow duration token is at least 1 ms; Reduce motion collapses it) and a fresh signature (ArrivalMemory.shouldStage).
 */
export function stagesArrival(input: { appearanceKnown: boolean; slowMs: number; fresh: boolean }): boolean {
  return input.appearanceKnown && input.slowMs >= 1 && input.fresh
}
