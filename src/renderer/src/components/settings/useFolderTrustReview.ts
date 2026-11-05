import { useCallback, useEffect, useRef, useState } from 'react'
import type { FolderConfigReview, Project } from '@shared/types'
import { hasFolderTrustField } from '../../lib/folderTrust'

export interface FolderTrustReviewState {
  review: FolderConfigReview | null
  /** Re-read from disk; resolves with the review or null when it could not be read. A newer call wins. */
  refresh: () => Promise<FolderConfigReview | null>
  setReview: (r: FolderConfigReview) => void
}

/**
 * The folder config review of a gated project, fetched lazily (only a code project with the stored field), again when
 * the stored decision changes, with a sequence guard so an older answer never replaces a newer one.
 */
export function useFolderTrustReview(project: Project): FolderTrustReviewState {
  const gated = hasFolderTrustField(project)
  const [review, setReviewState] = useState<FolderConfigReview | null>(null)
  const seq = useRef(0)
  const projectId = project.id
  const refresh = useCallback(async (): Promise<FolderConfigReview | null> => {
    if (!gated) return null
    const mine = ++seq.current
    const run = (async (): Promise<FolderConfigReview | null> => {
      try {
        const r = await window.orgai.folderConfig.review(projectId)
        if (mine !== seq.current) return null
        setReviewState(r)
        return r
      } catch {
        return null
      }
    })()
    latest.current = run
    const r = await run
    // A newer call took over: answer with its result, so a caller never mistakes "superseded" for "could not read".
    if (mine !== seq.current && latest.current) return latest.current
    return r
  }, [gated, projectId])
  const latest = useRef<Promise<FolderConfigReview | null> | null>(null)
  const setReview = useCallback((r: FolderConfigReview) => {
    seq.current++
    latest.current = Promise.resolve(r)
    setReviewState(r)
  }, [])
  const stored = project.folderConfigTrust
  useEffect(() => {
    if (gated) void refresh()
    return () => {
      seq.current++
    }
  }, [gated, refresh, stored?.state, stored?.digest, stored?.decidedAt])
  return { review: gated && review?.projectId === projectId ? review : null, refresh, setReview }
}
