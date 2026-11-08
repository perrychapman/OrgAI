import { useCallback, useEffect, useRef, useState } from 'react'
import type { OutputThumb, RunOutput } from '@shared/types'
import { createThumbLoader, NO_THUMB } from '../../lib/outputThumbs'

/** One loader per window: three calls in flight, cached by id + version, failures cached as none. */
const loader = createThumbLoader((ref) => {
  const api = window.orgai?.outputs
  if (!api?.thumb) return Promise.resolve(NO_THUMB)
  return api.thumb(ref)
})

// One shared observer: a row or card asks for its thumbnail only while it is on screen.
let observer: IntersectionObserver | null = null
const watchers = new Map<Element, (visible: boolean) => void>()
function observe(el: Element, cb: (visible: boolean) => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    cb(true)
    return () => undefined
  }
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) watchers.get(e.target)?.(e.isIntersecting)
    },
    { rootMargin: '120px' }
  )
  watchers.set(el, cb)
  observer.observe(el)
  return () => {
    watchers.delete(el)
    observer?.unobserve(el)
  }
}

/**
 * The lazy thumbnail of an output (docs/design/outputs-2.md section 6): attach `ref` to the element that holds it. Loads
 * only while that element is visible and the output's file is not missing; `thumb` is null until it arrives (the kind
 * icon shows meanwhile) and { kind: 'none' } after a failure.
 */
export function useOutputThumb(output: Pick<RunOutput, 'id' | 'projectId' | 'version' | 'missing'>): { ref: (el: HTMLElement | null) => void; thumb: OutputThumb | null } {
  const version = output.version ?? 1
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [visible, setVisible] = useState(false)
  const [state, setState] = useState<{ key: string; thumb: OutputThumb } | null>(null)
  const key = `${output.id}@${version}`
  const ref = useCallback((node: HTMLElement | null) => setEl(node), [])
  useEffect(() => {
    if (!el) return undefined
    return observe(el, setVisible)
  }, [el])
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (!visible || output.missing) return undefined
    const r = { projectId: output.projectId, outputId: output.id, version }
    const hit = loader.peek(r)
    if (hit) {
      setState({ key, thumb: hit })
      return undefined
    }
    let stale = false
    void loader.load(r).then((t) => {
      if (!stale && alive.current) setState({ key, thumb: t })
    })
    return () => {
      stale = true
      loader.cancel(r)
    }
  }, [visible, output.missing, output.projectId, output.id, version, key])
  return { ref, thumb: state && state.key === key ? state.thumb : null }
}
