import { useCallback, useEffect, useRef, useState } from 'react'
import type { SkillDraft, SkillInfo, SkillMutationResult, SkillUpdateInput } from '@shared/types'
import { cleanIpcError } from '../../lib/ipcError'
import { useAppStore } from '../../store/useAppStore'

export interface ProjectSkills {
  skills: SkillInfo[]
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  /** Each mutation applies the result (list + project in the store) and rethrows a cleaned Error on failure (also in `error`). */
  create: (draft: SkillDraft, roleIds?: string[]) => Promise<SkillMutationResult>
  update: (input: Omit<SkillUpdateInput, 'projectId'>) => Promise<SkillMutationResult>
  remove: (skillId: string) => Promise<SkillMutationResult>
  linkLibrary: (libraryId: string, roleIds?: string[]) => Promise<SkillMutationResult>
  promote: (skillId: string) => Promise<SkillMutationResult>
  /** Take any SkillMutationResult (import apply/undo, applySuggestion) into the list and the store. */
  apply: (result: SkillMutationResult) => void
}

/** The skills of one project with their grants. Mutations also push the saved project (Role.skills changed) into the store. */
export function useProjectSkills(projectId: string): ProjectSkills {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  const apply = useCallback((result: SkillMutationResult): void => {
    seq.current++
    setSkills(result.skills)
    setError(null)
    setLoading(false)
    useAppStore.getState().replaceProject(result.project)
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    const mine = ++seq.current
    try {
      const list = await window.orgai.skills.list(projectId)
      if (mine !== seq.current) return
      setSkills(list)
      setError(null)
    } catch (e) {
      if (mine === seq.current) setError(cleanIpcError(e))
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    setSkills([])
    setLoading(true)
    void reload()
    return () => {
      seq.current++
    }
  }, [reload])

  const mutate = useCallback(
    async (fn: () => Promise<SkillMutationResult>): Promise<SkillMutationResult> => {
      setError(null)
      try {
        const result = await fn()
        apply(result)
        return result
      } catch (e) {
        const message = cleanIpcError(e)
        setError(message)
        throw new Error(message)
      }
    },
    [apply]
  )

  const create = useCallback(
    (draft: SkillDraft, roleIds?: string[]) => mutate(() => window.orgai.skills.create({ projectId, draft, ...(roleIds ? { roleIds } : {}) })),
    [mutate, projectId]
  )
  const update = useCallback((input: Omit<SkillUpdateInput, 'projectId'>) => mutate(() => window.orgai.skills.update({ ...input, projectId })), [mutate, projectId])
  const remove = useCallback((skillId: string) => mutate(() => window.orgai.skills.remove({ projectId, skillId })), [mutate, projectId])
  const linkLibrary = useCallback(
    (libraryId: string, roleIds?: string[]) => mutate(() => window.orgai.skills.linkLibrary({ projectId, libraryId, ...(roleIds ? { roleIds } : {}) })),
    [mutate, projectId]
  )
  const promote = useCallback((skillId: string) => mutate(() => window.orgai.skills.promote({ projectId, skillId })), [mutate, projectId])

  return { skills, loading, error, reload, create, update, remove, linkLibrary, promote, apply }
}
