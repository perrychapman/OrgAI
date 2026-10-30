import { useCallback, useEffect, useRef, useState } from 'react'
import type { SkillContent, SkillDraft, SkillLibraryInfo } from '@shared/types'
import { cleanIpcError } from '../../lib/ipcError'

export interface SkillLibraryState {
  /** null = still loading. */
  library: SkillLibraryInfo[] | null
  error: string | null
  refresh: () => void
  /** Mutations update the list from the returned value and rethrow a cleaned Error on failure (also in `error`). */
  create: (draft: SkillDraft) => Promise<SkillLibraryInfo[]>
  /** Picks a folder first; resolves null when the user cancelled. */
  addFromFolder: () => Promise<SkillLibraryInfo[] | null>
  update: (libraryId: string, draft: SkillDraft) => Promise<SkillLibraryInfo[]>
  remove: (libraryId: string) => Promise<SkillLibraryInfo[]>
  read: (libraryId: string) => Promise<SkillContent>
}

/** The app-wide skill library, loaded once and kept fresh from skillLibrary:changed pushes. */
export function useSkillLibrary(): SkillLibraryState {
  const [library, setList] = useState<SkillLibraryInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  const set = useCallback((list: SkillLibraryInfo[]): void => {
    seq.current++
    setList(list)
    setError(null)
  }, [])

  const refresh = useCallback((): void => {
    const mine = ++seq.current
    window.orgai.skillLibrary
      .list()
      .then((list) => {
        if (mine !== seq.current) return
        setList(list)
        setError(null)
      })
      .catch((e) => {
        if (mine === seq.current) setError(cleanIpcError(e))
      })
  }, [])

  useEffect(() => {
    refresh()
    return window.orgai.onSkillLibraryChanged(set)
  }, [refresh, set])

  const run = useCallback(async function run<T>(fn: () => Promise<T>): Promise<T> {
    setError(null)
    try {
      return await fn()
    } catch (e) {
      const message = cleanIpcError(e)
      setError(message)
      throw new Error(message)
    }
  }, [])

  const mutate = useCallback(
    (fn: () => Promise<SkillLibraryInfo[]>): Promise<SkillLibraryInfo[]> =>
      run(async () => {
        const list = await fn()
        set(list)
        return list
      }),
    [run, set]
  )

  const create = useCallback((draft: SkillDraft) => mutate(() => window.orgai.skillLibrary.create(draft)), [mutate])
  const addFromFolder = useCallback(
    () =>
      run(async () => {
        const path = await window.orgai.projects.pickDirectory()
        if (!path) return null
        const list = await window.orgai.skillLibrary.addFromFolder({ path })
        set(list)
        return list
      }),
    [run, set]
  )
  const update = useCallback((libraryId: string, draft: SkillDraft) => mutate(() => window.orgai.skillLibrary.update({ libraryId, draft })), [mutate])
  const remove = useCallback((libraryId: string) => mutate(() => window.orgai.skillLibrary.remove({ libraryId })), [mutate])
  const read = useCallback((libraryId: string) => run(() => window.orgai.skillLibrary.read({ libraryId })), [run])

  return { library, error, refresh, create, addFromFolder, update, remove, read }
}
