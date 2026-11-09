export interface Point { x: number; y: number }
export interface JourneyTiming { stepMs: number; settleMs: number; maxMs: number }
export const DEFAULT_JOURNEY_TIMING: JourneyTiming = { stepMs: 120, settleMs: 240, maxMs: 10000 }
export type Direction = 'up' | 'down' | 'left' | 'right'
export type JourneyPhase = 'outbound' | 'settle' | 'return' | 'done'

export function journeyDuration(path: readonly Point[], timing = DEFAULT_JOURNEY_TIMING): number | null {
  if (path.length < 2 || path.some((p, i) => i > 0 && Math.abs(p.x - path[i - 1].x) + Math.abs(p.y - path[i - 1].y) !== 1)) return null
  const duration = (path.length - 1) * timing.stepMs * 2 + timing.settleMs
  return duration <= timing.maxMs ? duration : null
}

function facing(a: Point, b: Point): Direction {
  return b.x > a.x ? 'right' : b.x < a.x ? 'left' : b.y > a.y ? 'down' : 'up'
}

/** Source-pixel positions: one tile per step, with an honest arrival and the same route home. */
export function sampleJourney(path: readonly Point[], elapsed: number, timing = DEFAULT_JOURNEY_TIMING): { x: number; y: number; direction: Direction; pose: 'walk-1' | 'walk-2' | 'idle'; phase: JourneyPhase } {
  const leg = Math.max(0, path.length - 1) * timing.stepMs
  const t = Math.max(0, elapsed)
  const phase: JourneyPhase = t < leg ? 'outbound' : t < leg + timing.settleMs ? 'settle' : t < leg * 2 + timing.settleMs ? 'return' : 'done'
  if (path.length < 2) return { x: (path[0]?.x ?? 0) * 16, y: (path[0]?.y ?? 0) * 16, direction: 'down', pose: 'idle', phase: 'done' }
  if (phase === 'settle') return { x: path.at(-1)!.x * 16, y: path.at(-1)!.y * 16, direction: facing(path.at(-2)!, path.at(-1)!), pose: 'idle', phase }
  if (phase === 'done') return { x: path[0].x * 16, y: path[0].y * 16, direction: facing(path[1], path[0]), pose: 'idle', phase }
  const points = phase === 'return' ? [...path].reverse() : path
  const progress = (phase === 'return' ? t - leg - timing.settleMs : t) / timing.stepMs
  const index = Math.min(points.length - 2, Math.floor(progress))
  const fraction = progress - index
  const a = points[index]; const b = points[index + 1]
  return { x: Math.round((a.x + (b.x - a.x) * fraction) * 16), y: Math.round((a.y + (b.y - a.y) * fraction) * 16), direction: facing(a, b), pose: index % 2 ? 'walk-2' : 'walk-1', phase }
}

/** Reserve a full target-width corridor for the whole decorative round trip. */
export function routesConflict(a: readonly Point[], b: readonly Point[]): boolean {
  return a.some(p => b.some(q => Math.abs(p.x - q.x) < 2 && Math.abs(p.y - q.y) < 3))
}
