import type { ReactElement } from 'react'
import type { Project } from '@shared/types'
import { ArchitectFields, useArchitectForm } from './team/ArchitectDialog'
import { Button } from './ui/Button'

/**
 * Design mode of the Team tab's tray (removed in phase 3): the same Architect form as the "Redesign with the
 * Architect" dialog, so there is one implementation. The quick draft is gone.
 */
export default function DraftPanel({ project }: { project: Project }): ReactElement {
  const form = useArchitectForm(project)
  return (
    <>
      <div className="team-tray-body stack-3">
        <section className="draft-box stack-2" aria-labelledby="draft-architect">
          <h3 className="side-section-title" id="draft-architect">
            Redesign with the Architect
          </h3>
          <ArchitectFields project={project} form={form} />
          <div>
            <Button variant="primary" loading={form.busy} testId="org-change-start" onClick={() => void form.submit()}>
              {form.primaryLabel}
            </Button>
          </div>
        </section>
      </div>
      {form.confirmDialog}
    </>
  )
}
