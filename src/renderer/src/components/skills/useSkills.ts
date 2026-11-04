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

/** Value key over what the skills list depends on: skill ids, links, enabled flags and each role's skill grants. */
function skillsKey(p: { skills?: { id: string; libraryId?: string; enabled?: boolean }[]; roles?: { id: string; skills?: string[] }[] } | undefined): string {
  if (!p) return ''
  const skills = (p.skills ?? []).map((k) => `${k.id}|${k.libraryId ?? ''}|${k.enabled === false ? 0 : 1}`).join(',')
  const roles = (p.roles ?? []).map((r) => `${r.id}:${(r.skills ?? []).join('+')}`).join(',')
  return `${skills};${roles}`
}

/** The skills of one project with their grants. Mutations also push the saved project (Role.skills changed) into the store. */
export function useProjectSkills(projectId: string): ProjectSkills {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  // The store's copy of this project, reduced to a value key (skill ids, links, enabled flags and role grants). Any change to
  // skills or grants reloads the list (an approved proposal, a library refresh, a grant edit in the role inspector), while
  // unrelated chart edits such as node drags leave the key, and so the selector result, unchanged.
  const storeKey = useAppStore((s) => skillsKey(s.projects.find((p) => p.id === projectId)))
  const seen = useRef<{ projectId: string; key: string }>({ projectId, key: storeKey })
  /** The key of the project our own apply() pushed into the store: not a change to react to. */
  const applied = useRef<string | null>(null)

  const apply = useCallback((result: SkillMutationResult): void => {
    seq.current++
    setSkills(result.skills)
    setError(null)
    setLoading(false)
    applied.current = skillsKey(result.project)
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
    seen.current = { projectId, key: storeKey }
    // A project switch is fetched by the effect above, once.
    if (prev.projectId !== projectId || prev.key === storeKey) return
    if (applied.current === storeKey) return
    // Background reload: keeps the list and `loading` as they are.
    void reload()
  }, [projectId, storeKey, reload])

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
