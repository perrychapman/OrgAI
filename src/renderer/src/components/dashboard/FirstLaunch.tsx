import type { ReactElement } from 'react'
import { useId, useState } from 'react'
import { MessageSquare } from 'lucide-react'
import { openNewChat } from '../../store/useAppStore'
import { Button } from '../ui/Button'
import { NewProjectForm } from './NewProjectForm'

type Start = 'project' | 'chat'

const OPTIONS: { value: Start; title: string; text: string }[] = [
  { value: 'project', title: 'Start a project', text: 'The Architect sets up a team of agents for your project.' },
  { value: 'chat', title: 'Chat now', text: 'Ask a question or hand over a task without making a project.' }
]

/**
 * First launch, no projects: one radio choice, then the panel it opens. "Start a project" shows the form inline (its
 * submit is the only primary); "Chat now" shows one primary button. The form stays mounted (hidden) while Chat is
 * picked so typed text survives a switch, and it never grabs focus from the radio group.
 */
export function FirstLaunch({ mockAvailable }: { mockAvailable: boolean }): ReactElement {
  const [start, setStart] = useState<Start>('project')
  const name = `${useId()}-start`
  return (
    <div className="dash-first">
      <fieldset className="dash-first-choice" data-testid="dash-start-choice">
        <legend>How do you want to start?</legend>
        <div className="dash-first-options">
          {OPTIONS.map((o) => (
            <label key={o.value} className="dash-first-option">
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={start === o.value}
                onChange={() => setStart(o.value)}
                aria-labelledby={`${name}-${o.value}-t`}
                aria-describedby={`${name}-${o.value}-d`}
              />
              <span id={`${name}-${o.value}-t`} className="dash-first-option-title">
                {o.title}
              </span>
              <span id={`${name}-${o.value}-d`} className="dash-first-option-text">
                {o.text}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="dash-first-panel" hidden={start !== 'project'}>
        <NewProjectForm mockAvailable={mockAvailable} variant="inline" autoFocus={false} />
      </div>
      {start === 'chat' && (
        <div className="dash-first-panel">
          <Button variant="primary" icon={MessageSquare} testId="empty-chat-now" onClick={() => void openNewChat()}>
            Chat now
          </Button>
        </div>
      )}
    </div>
  )
}
