// Which stations the cue layer keeps off the floor this frame (docs/design/factory-floor.md section 5.2): a new worker's
// station is not there while the tote carrying its work flies to it, nor while its arrive waits for that tote; it shows
// again as it starts to rise. Pure. The engine (engine/cueRender.ts) hides the station's instances, and the nameplate
// layer (FactoryLabels) hides the plate, from the same answer, so a plate never floats over an empty slot.
import type { ActiveCue } from './types'

export function hiddenStations(cues: readonly Pick<ActiveCue, 'kind' | 'from' | 'to' | 'progress'>[]): Set<string> {
  const hidden = new Set<string>()
  const rising = new Set<string>()
  for (const c of cues) {
    if (c.kind === 'tote' && typeof c.to === 'string' && c.to !== 'dock') hidden.add(c.to)
    else if (c.kind === 'arrive' && c.from) {
      if (c.progress <= 0) hidden.add(c.from)
      else rising.add(c.from)
    }
  }
  for (const id of rising) hidden.delete(id)
  return hidden
}

/** Order-free key of a hidden set (to tell whether the labels need placing again). */
export function hiddenKey(hidden: ReadonlySet<string>): string {
  return [...hidden].sort().join('\n')
}
