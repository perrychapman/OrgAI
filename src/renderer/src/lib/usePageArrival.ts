import { useEffect, useState } from 'react'
import { ARRIVAL_REST_MS, arrivalMemory, type ArrivalPage } from './pageArrival'
import { tokenMs } from './useExitPresence'

/**
 * True while `page` stages its arrival (lib/pageArrival.ts): decided once at mount from the data signature it shows
 * then, false after ARRIVAL_REST_MS, and never under reduced motion (the duration tokens collapse). Put the arrival
 * classes (`motion-arrive-hero`, `motion-arrive-band` with `--i`) and the draw classes on elements only while it is true,
 * and pass it to useCountUp. `signature` should change when what the page shows changes (counts, last run end), not on
 * every render; it is recorded while mounted so a return without a change stays at rest.
 */
export function usePageArrival(page: ArrivalPage, signature: string): boolean {
  const [arriving, setArriving] = useState(() => tokenMs('--dur-slow') >= 1 && arrivalMemory.shouldStage(page, signature))

  useEffect(() => {
    arrivalMemory.record(page, signature)
  }, [page, signature])

  useEffect(() => {
    if (!arriving) return
    const t = window.setTimeout(() => setArriving(false), ARRIVAL_REST_MS)
    return () => window.clearTimeout(t)
  }, [arriving])

  return arriving
}
