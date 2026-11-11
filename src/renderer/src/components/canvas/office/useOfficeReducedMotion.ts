import { useEffect, useState } from 'react'
import { useHtmlAttr } from '../../../lib/canvas'

const QUERY = '(prefers-reduced-motion: reduce)'

/**
 * Reduced motion for the Pocket Office: the OS preference or Settings > Motion = On, the same rule as `useReducedMotion` in
 * `lib/canvas`, with one difference that matters to a scene that is mounted and then sits still. A static office renders
 * rarely, and the OS reading is held in state, so a `change` event that lands between the render that read the preference and
 * the effect that listens for it would be lost for good and the clock would stay off. Reading again once the listener is
 * attached closes that gap (the Settings attribute already does the same inside `useHtmlAttr`).
 */
export function useOfficeReducedMotion(): boolean {
  const attr = useHtmlAttr('data-reduce-motion', '')
  const [os, setOs] = useState(() => window.matchMedia(QUERY).matches)
  useEffect(() => {
    const query = window.matchMedia(QUERY)
    const update = (): void => setOs(query.matches)
    query.addEventListener('change', update)
    update()
    return () => query.removeEventListener('change', update)
  }, [])
  return os || (attr !== '' && attr !== 'false' && attr !== 'off')
}
