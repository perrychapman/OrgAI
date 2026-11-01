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
          <span id={hintId}>Let it build a server here (asks before every command and edit)</span>
          <Switch testId="mcp-allow-build" label="Let it build a server here" describedBy={hintId} checked={allowBuild} onChange={setAllowBuild} />
        </div>
      }
    />
  )
}
