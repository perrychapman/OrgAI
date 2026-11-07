// Pure queue and cache behind output thumbnails (docs/design/outputs-2.md section 6). No React, no DOM, no window:
// the fetch function is injected. At most `limit` calls in flight, results cached by id + version, a failure is cached
// as { kind: 'none' } (the icon) so a bad file is never asked twice.
import type { OutputThumb, OutputVersionRef } from '@shared/types'

export const THUMB_MAX_IN_FLIGHT = 3
export const THUMB_CACHE_MAX = 400

export const NO_THUMB: OutputThumb = { kind: 'none' }

export const thumbKey = (outputId: string, version: number): string => `${outputId}@${version}`

/** Only a small raster data URL is drawn as an image (main already checks; this is the renderer's own gate). */
export function safeImageDataUrl(url: string): boolean {
  return /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(url) && url.length < 120_000
}

export interface ThumbLoader {
  /** The cached result, or undefined while unknown. */
  peek(ref: OutputVersionRef): OutputThumb | undefined
  /** Cached, in flight or queued: resolves with the thumbnail (never rejects). */
  load(ref: OutputVersionRef): Promise<OutputThumb>
  /** Drop a queued (not started) request; its promise resolves to undefined-like none without caching. */
  cancel(ref: OutputVersionRef): void
  /** Calls running right now (for tests and e2e). */
  inFlight(): number
}

interface Pending {
  ref: OutputVersionRef
  resolve: (t: OutputThumb) => void
  promise: Promise<OutputThumb>
}

export function createThumbLoader(fetchThumb: (ref: OutputVersionRef) => Promise<OutputThumb>, limit = THUMB_MAX_IN_FLIGHT, cacheMax = THUMB_CACHE_MAX): ThumbLoader {
  const cache = new Map<string, OutputThumb>()
  const waiting = new Map<string, Pending>()
  const running = new Map<string, Promise<OutputThumb>>()
  let active = 0

  const remember = (key: string, t: OutputThumb): void => {
    cache.delete(key)
    cache.set(key, t)
    while (cache.size > cacheMax) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  const pump = (): void => {
    while (active < limit) {
      const first = waiting.entries().next()
      if (first.done) return
      const [key, p] = first.value
      waiting.delete(key)
      active++
      running.set(key, p.promise)
      let call: Promise<OutputThumb>
      try {
        call = fetchThumb(p.ref)
      } catch {
        call = Promise.resolve(NO_THUMB)
      }
      void call
        .then(
          (t) => (t && typeof t === 'object' && typeof t.kind === 'string' ? t : NO_THUMB),
          () => NO_THUMB
        )
        .then((t) => {
          remember(key, t)
          running.delete(key)
          active--
          p.resolve(t)
          pump()
        })
    }
  }

  return {
    peek: (ref) => cache.get(thumbKey(ref.outputId, ref.version)),
    load(ref) {
      const key = thumbKey(ref.outputId, ref.version)
      const hit = cache.get(key)
      if (hit) return Promise.resolve(hit)
      const inflight = running.get(key) ?? waiting.get(key)?.promise
      if (inflight) return inflight
      let resolve!: (t: OutputThumb) => void
      const promise = new Promise<OutputThumb>((r) => (resolve = r))
      waiting.set(key, { ref, resolve, promise })
      pump()
      return promise
    },
    cancel(ref) {
      const key = thumbKey(ref.outputId, ref.version)
      const p = waiting.get(key)
      if (!p) return
      waiting.delete(key)
      p.resolve(NO_THUMB)
    },
    inFlight: () => active
  }
}
