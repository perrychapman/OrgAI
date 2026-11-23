import type { ReactElement } from 'react'
import { useEffect, useId, useState } from 'react'
import { Check, FolderPlus, MessageSquare, Plug } from 'lucide-react'
import { openNewChat, useAppStore } from '../../store/useAppStore'
import { connectionLabel } from '../../lib/connectionLabel'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Icon } from '../ui/Icon'
import { NewProjectForm } from './NewProjectForm'
import '../../styles/onboarding.css'

type Start = 'project' | 'chat'

const OPTIONS: { value: Start; title: string; text: string }[] = [
  { value: 'project', title: 'Start a project', text: 'Point OrgAI at a folder. The Architect proposes a team of agents for it.' },
  { value: 'chat', title: 'Chat now', text: 'Ask a question about OrgAI or your work, or hand over a task. No project needed.' }
]

/** Session-and-relaunch memory of "Skip setup" (renderer only; cleared by choosing New project from the empty state). */
const SKIP_KEY = 'orgai.welcome.skipped'
function readSkipped(): boolean {
  try {
    return window.localStorage.getItem(SKIP_KEY) === '1'
  } catch {
    return false
  }
}
function writeSkipped(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(SKIP_KEY, '1')
    else window.localStorage.removeItem(SKIP_KEY)
  } catch {
    /* storage unavailable: the choice lasts for this window */
  }
}

type ConnectState = { label: string; ready: boolean; detail: string }

/** Step 1 reads the real default connection; nothing is chosen here, sign-in lives in App settings: Connections. */
function useConnectState(): ConnectState {
  const mock = useAppStore((s) => s.appInfo?.mockAdapter ?? false)
  const connections = useAppStore((s) => s.connections)
  const loadConnections = useAppStore((s) => s.loadConnections)
  const defaultConnection = useAppStore((s) => s.defaultConnection)
  const auth = useAppStore((s) => s.auth)
  useEffect(() => {
    if (!connections) void loadConnections()
  }, [connections, loadConnections])
  if (mock) return { label: 'Mock adapter', ready: true, detail: 'Runs use scripted data. No sign-in is needed and no tokens are spent.' }
  const info = connections?.find((c) => c.isDefault) ?? connections?.find((c) => c.connection.id === defaultConnection)
  const id = info?.connection.id ?? defaultConnection ?? 'anthropic'
  const name = connectionLabel(id)
  const state = info?.status.state ?? (id === 'anthropic' && auth ? (auth.mode === 'apiKey' ? (auth.envVarSet ? 'connected' : 'disconnected') : auth.loggedIn ? 'connected' : 'disconnected') : undefined)
  if (state === 'connected') return { label: name, ready: true, detail: info?.status.account ? `Connected as ${info.status.account}.` : 'Connected.' }
  if (state === 'connecting') return { label: name, ready: false, detail: 'Connecting…' }
  if (state === undefined) return { label: name, ready: false, detail: 'Checking the connection…' }
  return { label: name, ready: false, detail: 'Not connected yet. Sign in once and every team can use it. Sign-in opens in your browser; OrgAI never sees your password.' }
}

/**
 * First launch, no projects (ui-overhaul Welcome board): the steps of getting started, the connection the teams will use,
 * one radio choice (Start a project / Chat now) and the panel it opens, with a side panel saying what is being set up.
 * The form stays mounted (hidden) while Chat is picked so typed text survives a switch, and it never grabs focus from
 * the radio group. "Skip setup" shows the plain empty state instead.
 */
export function FirstLaunch({ mockAvailable }: { mockAvailable: boolean }): ReactElement {
  const [start, setStart] = useState<Start>('project')
  const [skipped, setSkipped] = useState(readSkipped)
  const setView = useAppStore((s) => s.setView)
  const name = `${useId()}-start`
  const connect = useConnectState()

  if (skipped) {
    return (
      <div className="dash-first welcome-skipped" data-testid="welcome-skipped">
        <EmptyState
          icon={FolderPlus}
          title="Start with a project"
          description="Point OrgAI at a folder and it proposes a team for it. Or try Chat first to look around."
          testId="home-first-empty"
          actions={
            <>
              <Button
                variant="primary"
                icon={FolderPlus}
                testId="welcome-new-project"
                onClick={() => {
                  writeSkipped(false)
                  setSkipped(false)
                  setStart('project')
                }}
              >
                New project
              </Button>
              <Button icon={MessageSquare} testId="welcome-open-chat" onClick={() => void openNewChat()}>
                Open Chat
              </Button>
            </>
          }
        />
      </div>
    )
  }

  const steps = [
    { n: 1, label: 'Connect an AI', done: connect.ready },
    { n: 2, label: 'Choose how to start', done: false },
    { n: 3, label: start === 'chat' ? 'Open Chat' : 'Pick the folder', done: false }
  ]
  const current = connect.ready ? 2 : 1

  return (
    <div className="dash-first welcome" data-testid="welcome">
      <div className="welcome-main">
        <div className="welcome-top">
          <ol className="welcome-steps" aria-label="Setup steps">
            {steps.map((s) => (
              <li key={s.n} className="welcome-step" data-done={s.done || undefined} aria-current={s.n === current ? 'step' : undefined}>
                <span className="welcome-step-mark" aria-hidden="true">
                  {s.done ? <Icon icon={Check} size="xs" /> : s.n}
                </span>
                <span>{s.label}</span>
                {s.done && <span className="sr-only"> (done)</span>}
              </li>
            ))}
          </ol>
          <Button
            variant="ghost"
            size="sm"
            testId="welcome-skip"
            onClick={() => {
              writeSkipped(true)
              setSkipped(true)
            }}
          >
            Skip setup
          </Button>
        </div>

        <section className="welcome-connect glass" data-ready={connect.ready || undefined} data-testid="welcome-connect" aria-label="The AI your teams will use">
          <span className="welcome-connect-dot" aria-hidden="true" />
          <div className="welcome-connect-text">
            <div className="welcome-connect-title">{connect.label}</div>
            <div className="welcome-connect-detail">{connect.detail}</div>
          </div>
          <Button
            size="sm"
            variant={connect.ready ? 'secondary' : 'primary'}
            icon={Plug}
            testId="welcome-connections"
            onClick={() => {
              requestAppSettingsSection(APP_SETTINGS_SECTIONS.connections)
              setView('appSettings')
            }}
          >
            {connect.ready ? 'Change' : 'Sign in'}
          </Button>
        </section>

        <fieldset className="dash-first-choice" data-testid="dash-start-choice">
          <legend>How do you want to start?</legend>
          <p className="welcome-sub">You can add the other kind any time, and change all of this later in Settings.</p>
          <div className="dash-first-options">
            {OPTIONS.map((o) => (
              <label key={o.value} className="dash-first-option glass">
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
        <p className="welcome-foot">Your files stay on this computer. Teams only touch the folders you pick.</p>
      </div>

      <aside className="welcome-aside" aria-label="What you are setting up">
        <div className="welcome-aside-label">What you are setting up</div>
        {start === 'chat' ? (
          <div className="welcome-card glass motion-rise">
            <span className="welcome-card-mark" aria-hidden="true">
              <Icon icon={MessageSquare} size="sm" />
            </span>
            <div>
              <div className="welcome-card-title">Chat</div>
              <div className="welcome-card-text">One assistant that answers questions and can take on a task. No folder, no team.</div>
            </div>
          </div>
        ) : (
          <>
            <div className="welcome-card glass motion-rise">
              <span className="welcome-card-mark" aria-hidden="true">
                O
              </span>
              <div>
                <div className="welcome-card-title">Orchestrator</div>
                <div className="welcome-card-text">Plans each task, splits it up and checks in with you when it needs a decision.</div>
              </div>
            </div>
            <div className="welcome-edge" aria-hidden="true" />
            <div className="welcome-card welcome-card-ghost">
              <div>
                <div className="welcome-card-title">The team</div>
                <div className="welcome-card-text">Once you pick a folder, the Architect looks at it and proposes the roles. Nothing is created until you approve.</div>
              </div>
            </div>
          </>
        )}
      </aside>
    </div>
  )
}
