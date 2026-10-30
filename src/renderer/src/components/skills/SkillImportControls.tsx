import type { ReactElement } from 'react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import type { Project, SkillImportApplyResult } from '@shared/types'
import {
  importBannerLine,
  importNotImportedCount,
  readSkillBannerMemory,
  refusedSkillsLine,
  skillBannerVisible,
  skillImportedSummary,
  writeSkillBannerMemory,
  type SkillBannerMemory
} from '../../lib/skills'
import { cleanIpcError } from '../../lib/ipcError'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import type { ImportFollowUp } from './ImportSkillsDialog'
import type { ProjectSkills } from './useSkills'

const ImportSkillsDialog = lazy(() => import('./ImportSkillsDialog'))

interface Notice extends ImportFollowUp {
  undoId: string
  summary: string
  /** The skill list right after the apply; any other list means skills changed and the undo has expired. */
  signature: string
  state: 'ready' | 'busy' | 'error' | 'expired' | 'reverted'
  error?: string
}

/**
 * The "not imported" banner, the apply notice with Undo and the quiet "cannot be imported" line for the Skills section.
 * The dialog is opened by the section's Import skills button (`open`).
 */
export default function SkillImportControls({
  project,
  skillsApi,
  open,
  onOpenChange
}: {
  project: Project
  skillsApi: ProjectSkills
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const [found, setFound] = useState<{
    importable: number
    refused: number
    roots: string[]
  } | null>(null)
  const [memory, setMemory] = useState<SkillBannerMemory | null>(() => readSkillBannerMemory(window.localStorage, project.id))
  const [notice, setNotice] = useState<Notice | null>(null)

  // Quiet scan: a failure just means no banner.
  useEffect(() => {
    let live = true
    setMemory(readSkillBannerMemory(window.localStorage, project.id))
    window.orgai.skills
      .previewImport({ projectId: project.id })
      .then((p) => {
        if (!live) return
        setFound({
          importable: importNotImportedCount(p),
          refused: p.invalid.length,
          roots: [...new Set(p.items.map((i) => i.root))]
        })
      })
      .catch(() => live && setFound(null))
    return () => {
      live = false
    }
  }, [project.id])

  const signature = JSON.stringify(skillsApi.skills)
  useEffect(() => {
    setNotice((n) => (n && n.state !== 'expired' && n.state !== 'reverted' && n.state !== 'busy' && n.signature !== signature ? { ...n, state: 'expired' } : n))
  }, [signature])

  const applied = (result: SkillImportApplyResult, followUp: ImportFollowUp): void => {
    skillsApi.apply(result)
    writeSkillBannerMemory(window.localStorage, project.id, 'imported')
    setMemory('imported')
    setNotice({
      ...followUp,
      undoId: result.undoId,
      summary: skillImportedSummary(result.added.length, result.updated.length),
      signature: JSON.stringify(result.skills),
      state: 'ready'
    })
  }

  const undo = async (): Promise<void> => {
    if (!notice) return
    setNotice({ ...notice, state: 'busy' })
    try {
      const result = await window.orgai.skills.undoImport({
        projectId: project.id,
        undoId: notice.undoId
      })
      skillsApi.apply(result)
      setNotice({ ...notice, state: 'reverted' })
    } catch (e) {
      setNotice({ ...notice, state: 'error', error: cleanIpcError(e) })
    }
  }

  const showBanner = !notice && found !== null && skillBannerVisible(found.importable, memory)
  const refused = found?.refused ?? 0
  const lead = (n: Notice): string =>
    n.state === 'error' ? (n.error ?? '') : n.state === 'expired' ? 'Undo ended because the skills changed.' : 'You can undo until the skills change.'
  return (
    <div className="skill-import-controls">
      {notice && notice.state !== 'reverted' && (
        <Banner
          tone={
            notice.state === 'error'
              ? 'danger'
              : notice.dropped.length > 0 || notice.withoutRoles.length > 0
                ? 'warning'
                : notice.state === 'expired'
                  ? 'info'
                  : 'success'
          }
          title={notice.summary}
          label={notice.state === 'error' ? undefined : 'Skill import'}
          testId="skill-import-notice"
          onDismiss={() => setNotice(null)}
          actions={
            notice.state === 'expired' ? undefined : (
              <Button size="sm" loading={notice.state === 'busy'} onClick={() => void undo()} testId="skill-import-undo">
                {notice.state === 'error' ? 'Retry undo' : 'Undo'}
              </Button>
            )
          }
        >
          <p>{lead(notice)}</p>
          {notice.withoutRoles.length > 0 && (
            <p data-testid="skill-import-no-roles">
              {notice.withoutRoles.length === 1 ? `${notice.withoutRoles[0]} has` : `${notice.withoutRoles.length} skills have`} no roles yet, so no agent loads{' '}
              {notice.withoutRoles.length === 1 ? 'it' : 'them'}. Choose roles on the {notice.withoutRoles.length === 1 ? 'skill' : 'skills'} below.
            </p>
          )}
          {notice.dropped.length > 0 && (
            <details className="skill-notice-details warn" data-testid="skill-import-dropped-notice" open>
              <summary>
                <Icon icon={TriangleAlert} size="sm" /> {notice.dropped.length} {notice.dropped.length === 1 ? 'skill lost' : 'skills lost'} settings OrgAI does
                not run
              </summary>
              <ul>
                {notice.dropped.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </details>
          )}
        </Banner>
      )}
      {notice?.state === 'reverted' && (
        <Banner
          tone="info"
          title="Import undone. The previous skills are back."
          label="Skill import"
          testId="skill-import-undone"
          onDismiss={() => setNotice(null)}
        />
      )}
      {showBanner && found && (
        <Banner
          tone="info"
          label="Skills found"
          testId="skill-import-banner"
          title={importBannerLine(found.importable, found.refused, found.roots)}
          onDismiss={() => {
            writeSkillBannerMemory(window.localStorage, project.id, 'dismissed')
            setMemory('dismissed')
          }}
          actions={
            <Button size="sm" variant="primary" onClick={() => onOpenChange(true)}>
              Review
            </Button>
          }
        />
      )}
      {!showBanner && refused > 0 && (
        <p className="muted skill-refused-line" data-testid="skill-import-refused-line">
          {refusedSkillsLine(refused)}
        </p>
      )}
      {open && (
        <Suspense fallback={null}>
          <ImportSkillsDialog
            project={project}
            onApplied={applied}
            onClose={() => {
              onOpenChange(false)
              document.querySelector<HTMLElement>('[data-testid=skill-import]')?.focus()
            }}
          />
        </Suspense>
      )}
    </div>
  )
}
