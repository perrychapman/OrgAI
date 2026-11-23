import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { waitingItems } from './needsYou'
import { chimeDecision, chimesPlayed, playChime, type ChimeState } from './sound'

/**
 * Mounted once (App.tsx): plays the attention chime when a new decision starts waiting in any run of this window, if
 * AppSettings.playSound is on (default off). Decisions already waiting when the app starts or the setting turns on
 * never chime; chimes are rate-limited (lib/sound.ts). The count is mirrored on <html data-chime-count> for e2e.
 */
export function useAttentionSound(): void {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    let live = true
    window.orgai.settings
      .get()
      .then((s) => live && setEnabled(s.playSound === true))
      .catch(() => undefined)
    const off = window.orgai.onSettingsChanged((s) => setEnabled(s.playSound === true))
    return () => {
      live = false
      off()
    }
  }, [])
  const runs = useAppStore((s) => s.runs)
  const keys = useMemo(
    () =>
      Object.values(runs)
        .flatMap((r) => waitingItems(r).map((i) => i.key))
        .sort(),
    [runs]
  )
  const state = useRef<ChimeState>({ seen: null, lastAt: 0 })
  const wasEnabled = useRef(enabled)
  useEffect(() => {
    // Turning the sound on starts from what is waiting now, so it never chimes for old items.
    if (enabled && !wasEnabled.current) state.current = { seen: null, lastAt: state.current.lastAt }
    wasEnabled.current = enabled
    const { chime, next } = chimeDecision(state.current, keys, enabled, Date.now())
    state.current = next
    if (chime) {
      playChime()
      document.documentElement.dataset.chimeCount = String(chimesPlayed())
    }
  }, [keys, enabled])
}
