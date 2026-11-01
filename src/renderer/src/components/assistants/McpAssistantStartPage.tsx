import type { ReactElement } from 'react'
import { useId, useState } from 'react'
import type { Project } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { Switch } from '../ui/Switch'
import InstructionStartPage from './InstructionStartPage'

/** The MCP assistant start page: what agents should be able to do, optionally let it build a server, Start. */
export default function McpAssistantStartPage({ project: _project }: { project: Project }): ReactElement {
  const [allowBuild, setAllowBuild] = useState(false)
  const hintId = useId()
  // The workspace is a fresh folder under OrgAI's data folder, made when the session starts, so it has no name yet.
  const buildLabel = "Let it build a server in its workspace, in OrgAI's data folder"
  return (
    <InstructionStartPage
      id="harness"
      testId="assistant-start-harness"
      label="What should agents be able to do?"
      placeholder="Connect GitHub and a Postgres database..."
      modelKey="mcpAssistModel"
      onStart={async (instruction) => {
        await useAppStore.getState().startLibraryAssist(instruction, allowBuild)
      }}
      extras={
        <div className="assistant-switch-row">
          <div className="assistant-switch-text">
            <span>{buildLabel}</span>
            <span className="muted chat-edits-hint" id={hintId}>
              It asks before every command and edit.
            </span>
          </div>
          <Switch testId="mcp-allow-build" label={buildLabel} describedBy={hintId} checked={allowBuild} onChange={setAllowBuild} />
        </div>
      }
    />
  )
}
