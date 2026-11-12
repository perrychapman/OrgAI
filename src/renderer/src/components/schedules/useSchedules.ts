import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettingsInfo, Schedule } from '@shared/types'
import { cleanIpcError } from '../../lib/ipcError'

export interface SchedulesState {
  /** null until the first list arrives. */
  list: Schedule[] | null
  /** The list call failed (the runtime is not there, or the store refused): one plain sentence. */
  error: string | null
  loading: boolean
  /** AppSettings.schedulesPaused; null until settings load. */
  paused: boolean | null
  /** Bumped whenever schedules:changed names a schedule, so open histories reload. */
  changedSeq: number
  /** Ids named by the last schedules:changed push. */
  changedIds: readonly string[]
}

/**
 * The Schedules page's data: schedules:list, live refresh on schedules:changed and settings:changed (the global pause).
 * A rejected call is the error state, never a throw. Overlapping reloads keep only the newest answer.
 */
export function useSchedules(): SchedulesState & { reload: () => Promise<void>; setPausedLocal: (v: boolean) => void } {
  const [state, setState] = useState<SchedulesState>({ list: null, error: null, loading: true, paused: null, changedSeq: 0, changedIds: [] })
  const seq = useRef(0)

  const reload = useCallback(async (): Promise<void> => {
    const mine = ++seq.current
    setState((s) => ({ ...s, loading: true }))
    try {
      const list = await window.orgai.schedules.list()
      if (mine !== seq.current) return
      setState((s) => ({ ...s, list: Array.isArray(list) ? list : [], error: null, loading: false }))
    } catch (e) {
      if (mine !== seq.current) return
      setState((s) => ({ ...s, error: cleanIpcError(e, 'Schedules could not be loaded.'), loading: false }))
    }
  }, [])

  useEffect(() => {
    void reload()
    let live = true
    window.orgai.settings.get().then(
      (s) => {
        if (live) setState((st) => ({ ...st, paused: !!s.schedulesPaused }))
      },
      () => {
        if (live) setState((st) => ({ ...st, paused: false }))
      }
    )
    const offSettings = window.orgai.onSettingsChanged((s: AppSettingsInfo) => setState((st) => ({ ...st, paused: !!s.schedulesPaused })))
    let offChanged: () => void = () => undefined
    try {
      offChanged = window.orgai.onSchedulesChanged((ev) => {
        setState((st) => ({ ...st, changedSeq: st.changedSeq + 1, changedIds: Array.isArray(ev?.scheduleIds) ? ev.scheduleIds : [] }))
        void reload()
      })
    } catch {
      // An older preload without the push: the page still works, it refreshes after its own actions.
    }
    return () => {
      live = false
      offSettings()
      offChanged()
    }
  }, [reload])

  const setPausedLocal = useCallback((v: boolean) => setState((st) => ({ ...st, paused: v })), [])
  return { ...state, reload, setPausedLocal }
}

let pauseQueue: Promise<unknown> = Promise.resolve()

/** Save AppSettings.schedulesPaused through settings:set (read, merge, write; serialised like saveCanvas). */
export function saveSchedulesPaused(paused: boolean): Promise<void> {
  const run = async (): Promise<void> => {
    const info = await window.orgai.settings.get()
    const { dataDir: _dataDir, appVersion: _appVersion, ...settings } = info
    const saved = await window.orgai.settings.set({ ...settings, schedulesPaused: paused })
    // Main keeps only the fields it knows: a build without schedules drops it, so trust the saved value only.
    if (!!saved?.schedulesPaused !== paused) throw new Error('The pause setting was not saved. Schedules are not available yet.')
  }
  const result = pauseQueue.then(run, run)
  pauseQueue = result.catch(() => undefined)
  return result
}
