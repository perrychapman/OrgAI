import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { waitingItems } from './needsYou'
import { EMPTY_CHIME, chimeDecision, chimesPlayed, playChime, type ChimeState } from './sound'

/** "runId\tkey" lines for every waiting decision, plus a "#runId" line per run: one string, so a streamed delta that
 * changes no decision does not re-run the effect. */
function snapshot(runs: ReturnType<typeof useAppStore.getState>['runs']): string {
  const lines: string[] = []
  for (const r of Object.values(runs)) {
    lines.push(`#${r.summary.id}`)
    for (const i of waitingItems(r)) lines.push(`${r.summary.id}\t${i.key}`)
  }
  return lines.sort().join('\n')
}

/**
 * Mounted once (App.tsx): plays the attention chime when a new decision starts waiting on a run this window already
 * had, if AppSettings.playSound is on (default off). Decisions already waiting when the app starts, when a run loads or
 * is opened, or when the setting turns on never chime; chimes are rate-limited (lib/sound.ts). The count is mirrored on
 * <html data-chime-count> for e2e.
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
  const snap = useAppStore((s) => snapshot(s.runs))
  const state = useRef<ChimeState>(EMPTY_CHIME)
  const wasEnabled = useRef(enabled)
  useEffect(() => {
    // Turning the sound on starts from what is waiting now, so it never chimes for old items.
    if (enabled && !wasEnabled.current) state.current = { ...EMPTY_CHIME, lastAt: state.current.lastAt }
    wasEnabled.current = enabled
    const lines = snap ? snap.split('\n') : []
    const runIds = lines.filter((l) => l.startsWith('#')).map((l) => l.slice(1))
    const entries = lines.filter((l) => !l.startsWith('#')).map((l) => l.split('\t') as [string, string])
    const { chime, next } = chimeDecision(state.current, entries, runIds, enabled, Date.now())
    state.current = next
    if (chime) {
      playChime()
      document.documentElement.dataset.chimeCount = String(chimesPlayed())
    }
  }, [snap, enabled])
}
