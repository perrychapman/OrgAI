import { useCallback, useEffect, useRef, useState } from 'react'
import type { SkillDraft, SkillInfo, SkillMutationResult, SkillUpdateInput } from '@shared/types'
import { cleanIpcError } from '../../lib/ipcError'
import { useAppStore } from '../../store/useAppStore'

export interface ProjectSkills {
  skills: SkillInfo[]
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  /** Each mutation applies the result (list + project in the store) and throws a cleaned Error on failure (`error` is for load failures only). */
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

  // The store's copy of this project: a change to its skills or roles (an approved proposal, a grant, a library refresh) reloads the list.
  const storeSkills = useAppStore((s) => s.projects.find((p) => p.id === projectId)?.skills)
  const storeRoles = useAppStore((s) => s.projects.find((p) => p.id === projectId)?.roles)
  const seen = useRef({ skills: storeSkills, roles: storeRoles })
  /** References our own apply() pushed into the store: not a change to react to. */
  const applied = useRef<{ skills: unknown; roles: unknown } | null>(null)

  const apply = useCallback((result: SkillMutationResult): void => {
    seq.current++
    setSkills(result.skills)
    setError(null)
    setLoading(false)
    applied.current = { skills: result.project.skills, roles: result.project.roles }
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

  useEffect(() => {
    const prev = seen.current
    seen.current = { skills: storeSkills, roles: storeRoles }
    if (prev.skills === storeSkills && prev.roles === storeRoles) return
    const mine = applied.current
    if (mine && mine.skills === storeSkills && mine.roles === storeRoles) return
    // Background reload: keeps the list and `loading` as they are.
    void reload()
  }, [storeSkills, storeRoles, reload])

  const mutate = useCallback(
    async (fn: () => Promise<SkillMutationResult>): Promise<SkillMutationResult> => {
      try {
        const result = await fn()
        apply(result)
        return result
      } catch (e) {
        // The caller shows the failure next to what it was doing; the list-level banner is for load errors only.
        throw new Error(cleanIpcError(e))
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
