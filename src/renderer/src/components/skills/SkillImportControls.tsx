import type { ReactElement } from 'react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Download } from 'lucide-react'
import type { Project, SkillImportApplyResult } from '@shared/types'
import {
  importFoundLine,
  importNotImportedCount,
  readSkillBannerMemory,
  skillBannerVisible,
  skillImportedSummary,
  skillsNotImportedLine,
  writeSkillBannerMemory,
  type SkillBannerMemory
} from '../../lib/skills'
import { cleanIpcError } from '../../lib/ipcError'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import type { ProjectSkills } from './useSkills'

const ImportSkillsDialog = lazy(() => import('./ImportSkillsDialog'))

interface Notice {
  undoId: string
  summary: string
  /** The skill list right after the apply; any other list means skills changed and the undo has expired. */
  signature: string
  state: 'ready' | 'busy' | 'error' | 'expired' | 'reverted'
  error?: string
}

/** Import button, "not imported" banner and the apply notice with Undo for the Skills section header. */
export default function SkillImportControls({ project, skillsApi }: { project: Project; skillsApi: ProjectSkills }): ReactElement {
  const [open, setOpen] = useState(false)
  const [found, setFound] = useState<string | null>(null)
  const [count, setCount] = useState(0)
  const [memory, setMemory] = useState<SkillBannerMemory | null>(() => readSkillBannerMemory(window.localStorage, project.id))
  const [notice, setNotice] = useState<Notice | null>(null)
  const buttonRef = useRef<HTMLSpanElement>(null)

  // Quiet scan: a failure just means no banner.
  useEffect(() => {
    let live = true
    setMemory(readSkillBannerMemory(window.localStorage, project.id))
    window.orgai.skills
      .previewImport({ projectId: project.id })
      .then((p) => {
        if (!live) return
        setFound(importFoundLine(p))
        setCount(importNotImportedCount(p))
      })
      .catch(() => live && (setFound(null), setCount(0)))
    return () => {
      live = false
    }
  }, [project.id])

  const signature = JSON.stringify(skillsApi.skills)
  useEffect(() => {
    setNotice((n) => (n && n.state !== 'expired' && n.state !== 'reverted' && n.state !== 'busy' && n.signature !== signature ? { ...n, state: 'expired' } : n))
  }, [signature])

  const applied = (result: SkillImportApplyResult): void => {
    skillsApi.apply(result)
    writeSkillBannerMemory(window.localStorage, project.id, 'imported')
    setMemory('imported')
    setNotice({
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
      const result = await window.orgai.skills.undoImport({ projectId: project.id, undoId: notice.undoId })
      skillsApi.apply(result)
      setNotice({ ...notice, state: 'reverted' })
    } catch (e) {
      setNotice({ ...notice, state: 'error', error: cleanIpcError(e) })
    }
  }

  const showBanner = !notice && found !== null && skillBannerVisible(count, memory)
  return (
    <div className="skill-import-controls">
      <span ref={buttonRef}>
        <Button size="sm" icon={Download} onClick={() => setOpen(true)} testId="skill-import">
          Import skills
        </Button>
      </span>
      {notice && notice.state !== 'reverted' && (
        <Banner
          tone={notice.state === 'error' ? 'danger' : notice.state === 'expired' ? 'info' : 'success'}
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
          {notice.state === 'error' ? notice.error : notice.state === 'expired' ? 'Undo ended because the skills changed.' : 'You can undo until the skills change.'}
        </Banner>
      )}
      {notice?.state === 'reverted' && (
        <Banner tone="info" title="Import undone. The previous skills are back." label="Skill import" testId="skill-import-undone" onDismiss={() => setNotice(null)} />
      )}
      {showBanner && (
        <Banner
          tone="info"
          label="Skills found"
          testId="skill-import-banner"
          title={found}
          onDismiss={() => {
            writeSkillBannerMemory(window.localStorage, project.id, 'dismissed')
            setMemory('dismissed')
          }}
          actions={
            <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
              Review
            </Button>
          }
        >
          {skillsNotImportedLine(count)}
        </Banner>
      )}
      {open && (
        <Suspense fallback={null}>
          <ImportSkillsDialog
            project={project}
            onApplied={applied}
            onClose={() => {
              setOpen(false)
              buttonRef.current?.querySelector('button')?.focus()
            }}
          />
        </Suspense>
      )}
    </div>
  )
}
