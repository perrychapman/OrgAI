import type { ReactElement, ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { Check, MessageSquare, Plug } from 'lucide-react'
import type { ConnectionId, PermissionMode } from '@shared/types'
import { openNewChat, useAppStore } from '../../store/useAppStore'
import { connectionLabel } from '../../lib/connectionLabel'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'
import { writeLastProjectKind } from '../../lib/projectsForm'
import { cleanIpcError } from '../../lib/ipcError'
import {
  ASK_OPTIONS,
  STAGE_TITLES,
  WORK_OPTIONS,
  askChoiceFor,
  connectOptions,
  nextStage,
  prevStage,
  readWelcomeDone,
  writeWelcomeDone,
  type WelcomeStage,
  type WorkKind
} from '../../lib/welcome'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { NewProjectForm } from './NewProjectForm'
import '../../styles/onboarding.css'

type Start = 'project' | 'chat'

const OPTIONS: { value: Start; title: string; text: string }[] = [
  { value: 'project', title: 'Start a project', text: 'Point OrgAI at a folder. The Architect proposes a team of agents for it.' },
  { value: 'chat', title: 'Chat now', text: 'Ask a question about OrgAI or your work, or hand over a task. No project needed.' }
]

/** Where the setup was when the user left Home (e.g. to sign in); kept for this window only. */
let resumeAt: { stage: WelcomeStage; work: WorkKind; connection: ConnectionId | null; ask: PermissionMode | null } | null = null

type ConnectState = { label: string; ready: boolean; detail: string }

/** The real default connection, for the start stage's side card. */
function useConnectState(): ConnectState {
  const mock = useAppStore((s) => s.appInfo?.mockAdapter ?? false)
  const connections = useAppStore((s) => s.connections)
  const defaultConnection = useAppStore((s) => s.defaultConnection)
  const auth = useAppStore((s) => s.auth)
  if (mock) return { label: 'Mock adapter', ready: true, detail: 'Runs use scripted data. No sign-in is needed and no tokens are spent.' }
  const info = connections?.find((c) => c.isDefault) ?? connections?.find((c) => c.connection.id === defaultConnection)
  const id = info?.connection.id ?? defaultConnection ?? 'anthropic'
  const name = connectionLabel(id)
  const state = info?.status.state ?? (id === 'anthropic' && auth ? (auth.mode === 'apiKey' ? (auth.envVarSet ? 'connected' : 'disconnected') : auth.loggedIn ? 'connected' : 'disconnected') : undefined)
  if (state === 'connected') return { label: name, ready: true, detail: info?.status.account ? `Connected as ${info.status.account}.` : 'Connected.' }
  if (state === 'connecting') return { label: name, ready: false, detail: 'Connecting…' }
  if (state === undefined) return { label: name, ready: false, detail: 'Checking the connection…' }
  return { label: name, ready: false, detail: 'Not connected yet. Sign in once in Settings and every team can use it.' }
}

function openConnections(setView: (v: 'appSettings') => void): void {
  requestAppSettingsSection(APP_SETTINGS_SECTIONS.connections)
  setView('appSettings')
}

/** One glass radio card (native radio inside a label, so arrows move within the group). */
function Choice({ name, value, checked, onPick, title, text, badge, kind }: { name: string; value: string; checked: boolean; onPick: () => void; title: string; text: string; badge?: string; kind?: string }): ReactElement {
  return (
    <label className="welcome-option glass" data-kind={kind} data-testid="welcome-option" data-value={value}>
      <input type="radio" name={name} value={value} checked={checked} onChange={onPick} aria-labelledby={`${name}-${value}-t`} aria-describedby={`${name}-${value}-d`} />
      <span id={`${name}-${value}-t`} className="welcome-option-title">
        {title}
        {badge && <span className="welcome-option-badge">{badge}</span>}
      </span>
      <span id={`${name}-${value}-d`} className="welcome-option-text">
        {text}
      </span>
    </label>
  )
}

/**
 * First launch, no projects (ui-overhaul Welcome board). Three setup steps, then the start choice:
 * 1 Connect: the real connections; picking a connected one makes it the default (connections:setDefault), an unconnected
 *   one offers Sign in (App settings: Connections, which opens the browser).
 * 2 What first: code, not-code or Chat; it preselects the New project kind (or opens Chat).
 * 3 How much to ask: the app's default permission mode for new projects (settings:set defaultPermissionMode).
 * Then the start choice (Start a project / Chat now) with the inline New project form, as before. "Skip setup" goes
 * straight there. Finishing or skipping is remembered (lib/welcome WELCOME_DONE_KEY).
 */
export function FirstLaunch({ mockAvailable }: { mockAvailable: boolean }): ReactElement {
  const setView = useAppStore((s) => s.setView)
  const connections = useAppStore((s) => s.connections)
  const loadConnections = useAppStore((s) => s.loadConnections)
  const defaultConnection = useAppStore((s) => s.defaultConnection)
  const setDefaultConnection = useAppStore((s) => s.setDefaultConnection)
  const mock = useAppStore((s) => s.appInfo?.mockAdapter ?? false)
  const uid = useId()
  const connect = useConnectState()

  const [stage, setStage] = useState<WelcomeStage>(() => resumeAt?.stage ?? (readWelcomeDone() ? 'start' : 1))
  const [work, setWork] = useState<WorkKind>(() => resumeAt?.work ?? 'code')
  const [chosenConnection, setChosenConnection] = useState<ConnectionId | null>(() => resumeAt?.connection ?? null)
  const [ask, setAsk] = useState<PermissionMode | null>(() => resumeAt?.ask ?? null)
  const [start, setStart] = useState<Start>('project')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const moved = useRef(false)

  useEffect(() => {
    if (!connections) void loadConnections()
  }, [connections, loadConnections])
  // Step 3 preselects the saved default when it is one of the three offered modes.
  useEffect(() => {
    if (stage !== 3 || ask !== null) return
    let live = true
    window.orgai.settings
      .get()
      .then((s) => live && setAsk(askChoiceFor(s.defaultPermissionMode)))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [stage, ask])
  // Keep the place while the user is elsewhere (signing in), for this window only.
  useEffect(() => {
    resumeAt = stage === 'start' ? null : { stage, work, connection: chosenConnection, ask }
  }, [stage, work, chosenConnection, ask])
  // After Next / Back, focus the new step's heading (never on mount: Home owns the first focus).
  // Leaving setup (Skip or the last Continue) lands on the checked start radio, so focus never drops to the page.
  useEffect(() => {
    if (!moved.current) return
    if (stage === 'start') startRef.current?.querySelector<HTMLInputElement>('input[type=radio]:checked')?.focus()
    else headingRef.current?.focus()
  }, [stage])
  const startRef = useRef<HTMLFieldSetElement>(null)
  /** Set once the user picked or confirmed a kind of work on step 2; Skip before that leaves the form's own kind alone. */
  const workChosen = useRef(resumeAt?.stage === 3)

  const options = connectOptions(connections, defaultConnection)
  const picked = options.find((o) => o.id === (chosenConnection ?? options[0]?.id)) ?? null

  const go = (to: WelcomeStage): void => {
    moved.current = true
    setError(null)
    if (stage === 2 && to === 3) workChosen.current = true
    if (to === 'start') {
      writeWelcomeDone()
      if (workChosen.current && work !== 'chat') writeLastProjectKind(work)
      setStart(workChosen.current && work === 'chat' ? 'chat' : 'project')
    }
    setStage(to)
  }

  const next = async (): Promise<void> => {
    if (stage === 'start' || busy) return
    setError(null)
    setBusy(true)
    try {
      if (stage === 1 && picked && picked.connected && picked.id !== defaultConnection) await setDefaultConnection(picked.id)
      if (stage === 3 && ask) {
        const s = await window.orgai.settings.get()
        if (s.defaultPermissionMode !== ask) await useAppStore.getState().trackSave(() => window.orgai.settings.set({ ...s, defaultPermissionMode: ask }))
      }
      const to = nextStage(stage, work)
      if (to === 'start' && work === 'chat') {
        writeWelcomeDone()
        setStage('start')
        setStart('chat')
        void openNewChat()
        return
      }
      go(to)
    } catch (e) {
      setError(cleanIpcError(e))
    } finally {
      setBusy(false)
    }
  }

  if (stage !== 'start') {
    const t = STAGE_TITLES[stage]
    const steps = ([1, 2, 3] as const).filter((n) => n !== 3 || work !== 'chat')
    let body: ReactNode
    if (stage === 1) {
      body = mock ? (
        <p className="welcome-note" data-testid="welcome-mock-note">
          The mock adapter is on: runs use scripted data, so no sign-in is needed and no tokens are spent.
        </p>
      ) : options.length === 0 ? (
        <p className="welcome-note">Reading your connections…</p>
      ) : (
        <div className="welcome-options" role="radiogroup" aria-labelledby={`${uid}-h`}>
          {options.map((o) => (
            <Choice key={o.id} name={`${uid}-conn`} value={o.id} checked={picked?.id === o.id} onPick={() => setChosenConnection(o.id)} title={o.name} text={o.sub} badge={o.connected ? 'Connected' : undefined} />
          ))}
        </div>
      )
    } else if (stage === 2) {
      body = (
        <div className="welcome-options" role="radiogroup" aria-labelledby={`${uid}-h`}>
          {WORK_OPTIONS.map((o) => (
            <Choice key={o.kind} name={`${uid}-work`} value={o.kind} kind={o.kind} checked={work === o.kind} onPick={() => {
                workChosen.current = true
                setWork(o.kind)
              }} title={o.name} text={o.sub} />
          ))}
        </div>
      )
    } else {
      body = (
        <div className="welcome-options" role="radiogroup" aria-labelledby={`${uid}-h`}>
          {ASK_OPTIONS.map((o) => (
            <Choice key={o.mode} name={`${uid}-ask`} value={o.mode} checked={ask === o.mode} onPick={() => setAsk(o.mode)} title={o.name} text={o.sub} />
          ))}
        </div>
      )
    }
    const needsSignIn = stage === 1 && !mock && !!picked && !picked.connected
    const nextLabel = stage === 3 || (stage === 2 && work === 'chat') ? (work === 'chat' ? 'Open Chat' : 'Open OrgAI') : 'Continue'
    return (
      <div className="dash-first welcome welcome-setup" data-testid="welcome-setup" data-stage={stage}>
        <div className="welcome-main">
          <div className="welcome-top">
            <ol className="welcome-steps welcome-steps-row" aria-label="Setup steps">
              {steps.map((n) => (
                <li key={n} className="welcome-step" data-done={n < stage || undefined} aria-current={n === stage ? 'step' : undefined}>
                  <span className="welcome-step-mark" aria-hidden="true">
                    {n < stage ? <Icon icon={Check} size="xs" /> : n}
                  </span>
                  <span>{STAGE_TITLES[n].label}</span>
                  {n < stage && <span className="sr-only"> (done)</span>}
                </li>
              ))}
            </ol>
            <Button variant="ghost" size="sm" testId="welcome-skip" onClick={() => go('start')}>
              Skip setup
            </Button>
          </div>
          <div className="welcome-head motion-rise" key={stage}>
            <h2 id={`${uid}-h`} ref={headingRef} tabIndex={-1} className="welcome-title">
              {t.title}
            </h2>
            <p className="welcome-sub">{t.sub}</p>
          </div>
          {body}
          <p className="welcome-foot">{t.foot}</p>
          {error && (
            <p className="field-msg error" role="alert" data-testid="welcome-error">
              {error}
            </p>
          )}
          <div className="welcome-actions">
            {stage !== 1 && (
              <Button testId="welcome-back" onClick={() => go(prevStage(stage))}>
                Back
              </Button>
            )}
            <span className="welcome-actions-note">You can change all of this later in Settings</span>
            {needsSignIn && (
              <Button testId="welcome-continue-anyway" variant="ghost" onClick={() => void next()}>
                Continue without it
              </Button>
            )}
            {needsSignIn ? (
              <Button variant="primary" icon={Plug} testId="welcome-sign-in" onClick={() => openConnections(setView)}>
                Sign in
              </Button>
            ) : (
              <Button variant="primary" loading={busy} testId="welcome-next" onClick={() => void next()}>
                {nextLabel}
              </Button>
            )}
          </div>
        </div>
        <aside className="welcome-aside" aria-label="What you are setting up">
          <div className="welcome-aside-label">What you are setting up</div>
          <SetupPreview work={work} />
        </aside>
      </div>
    )
  }

  const name = `${uid}-start`
  return (
    <div className="dash-first welcome" data-testid="welcome">
      <div className="welcome-main">
        <fieldset className="dash-first-choice" data-testid="dash-start-choice" ref={startRef}>
          <legend>How do you want to start?</legend>
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
        <p className="welcome-foot">Your files stay on this computer. Teams only touch the folders you pick. You can change all of this later in Settings.</p>
      </div>

      <aside className="welcome-aside" aria-label="Getting started">
        <section className="welcome-connect glass" data-ready={connect.ready || undefined} data-testid="welcome-connect" aria-label="The AI your teams will use">
          <span className="welcome-connect-dot" aria-hidden="true" />
          <div className="welcome-connect-text">
            <div className="welcome-connect-title">{connect.label}</div>
            <div className="welcome-connect-detail">{connect.detail}</div>
          </div>
          <Button size="sm" variant={connect.ready ? 'secondary' : 'primary'} icon={Plug} testId="welcome-connections" onClick={() => openConnections(setView)}>
            {connect.ready ? 'Change' : 'Sign in'}
          </Button>
        </section>
        <div className="welcome-aside-label">What you are setting up</div>
        <SetupPreview work={start === 'chat' ? 'chat' : 'code'} />
      </aside>
    </div>
  )
}

/** The side panel: what the choice sets up, in words. Roles are never invented: the Architect proposes them later. */
function SetupPreview({ work }: { work: WorkKind }): ReactElement {
  if (work === 'chat') {
    return (
      <div className="welcome-card glass motion-rise">
        <span className="welcome-card-mark" aria-hidden="true">
          <Icon icon={MessageSquare} size="sm" />
        </span>
        <div>
          <div className="welcome-card-title">Chat</div>
          <div className="welcome-card-text">One assistant that answers questions and can take on a task. No folder, no team.</div>
        </div>
      </div>
    )
  }
  return (
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
      <div className="welcome-card welcome-card-ghost" data-kind={work}>
        <div>
          <div className="welcome-card-title">The team</div>
          <div className="welcome-card-text">
            {work === 'engagement'
              ? 'Once you pick a working folder, the Architect proposes roles that research, analyse and write. Nothing is created until you approve.'
              : 'Once you pick a folder, the Architect looks at the code and proposes roles that build, review and test. Nothing is created until you approve.'}
          </div>
        </div>
      </div>
    </>
  )
}
