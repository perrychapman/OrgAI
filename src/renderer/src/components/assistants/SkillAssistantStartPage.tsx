import type { ReactElement } from 'react'
import type { Project } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import InstructionStartPage from './InstructionStartPage'

/** The Skill assistant start page (library scope). Project-scope runs start from a project's Skills section. */
export default function SkillAssistantStartPage({ project: _project }: { project: Project }): ReactElement {
  return (
    <InstructionStartPage
      id="skills"
      testId="assistant-start-skills"
      label="What should your agents get better at?"
      placeholder="Review our skills and write one for the release checklist..."
      modelKey="skillAssistModel"
      onStart={async (instruction) => {
        await useAppStore.getState().startSkillAssist({ scope: 'library', instruction })
      }}
    />
  )
}
