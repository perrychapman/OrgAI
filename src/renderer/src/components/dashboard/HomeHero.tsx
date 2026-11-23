import type { KeyboardEvent, ReactElement } from 'react'
import { useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, MessageSquare } from 'lucide-react'
import { newRunDraftKey, openNewChat, useAppStore } from '../../store/useAppStore'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { Icon } from '../ui/Icon'
import { useDashboard } from './DashboardContext'
import { useAllSummaries } from './useDashboardData'
import { continueProjectId } from '../../lib/dashboardBrief'
import { HERO_CHAT_TARGET, HERO_HEADING, HERO_SUGGESTIONS, heroCanStart, heroPermissionLabel, heroScopeLabel, heroTargets, pickHeroTarget } from '../../lib/dashboardHero'
import { modKeyLabel, currentPlatform } from '../../lib/platform'
import { projectHue } from '../../lib/projectIdentity'

/**
 * Home's task box (Main board): the question, a glass-strong box with the task, the target chip (a stored project or Chat),
 * the project's team scope and permission setting as read-only chips, the shortcut hint and the one primary button, then the
 * "Try" starters. Starting uses the store's own paths and never sends anything itself: a project opens its New run page with
 * the task in the composer (where the run settings, guards and confirmations live), Chat opens a new Chat with the task as
 * its seeded instruction. The starters only fill the box.
 */
export function HomeHero(): ReactElement {
  const projects = useAppStore((s) => s.projects)
  const selectProject = useAppStore((s) => s.selectProject)
  const openDraft = useAppStore((s) => s.openDraft)
  const focusComposer = useAppStore((s) => s.focusComposer)
  const setComposerDraft = useAppStore((s) => s.setComposerDraft)
  const openAssistant = useAppStore((s) => s.openAssistant)
  const { layout } = useDashboard()
  const summaries = useAllSummaries()
  const [text, setText] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const ids = { area: useId(), target: useId(), note: useId() }

  const targets = useMemo(() => heroTargets(projects), [projects])
  const preferred = useMemo(() => continueProjectId(layout.pinned, projects, summaries), [layout.pinned, projects, summaries])
  const targetId = pickHeroTarget(chosen, preferred, targets)
  const chat = targetId === HERO_CHAT_TARGET
  const project = chat ? undefined : projects.find((p) => p.id === targetId)
  const scope = heroScopeLabel(project)
  const permission = heroPermissionLabel(project?.permissionMode)
  const can = heroCanStart(text)
  const mod = modKeyLabel(currentPlatform())

  const start = (): void => {
    if (!can) return
    const task = text.trim()
    if (chat) {
      void openAssistant('quick', { fresh: true, instruction: task })
    } else if (project) {
      const key = newRunDraftKey(project.id)
      // Keep what was already typed on that project's New run page; the task goes in front of it.
      const before = useAppStore.getState().composerDrafts[key]
      selectProject(project.id)
      setComposerDraft(key, { text: before?.text.trim() ? `${task}\n\n${before.text}` : task, images: before?.images ?? [] })
      openDraft()
      focusComposer()
    }
    setText('')
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
      e.preventDefault()
      start()
    }
  }
  const suggest = (s: string): void => {
    setText(s)
    requestAnimationFrame(() => areaRef.current?.focus())
  }
  const chatNow = (): void => {
    const task = text.trim()
    if (task) void openAssistant('quick', { fresh: true, instruction: task })
    else void openNewChat()
    setText('')
  }

  return (
    <section className="home-hero" data-testid="home-hero" aria-labelledby={`${ids.area}-h`}>
      <h2 id={`${ids.area}-h`} className="home-hero-title" data-testid="home-hero-title">
        {HERO_HEADING}
      </h2>
      <div className="home-task glass-strong">
        <label htmlFor={ids.area} className="sr-only">
          Task
        </label>
        <textarea
          id={ids.area}
          ref={areaRef}
          className="home-task-input"
          data-testid="home-task"
          rows={2}
          value={text}
          placeholder="Describe the task. Your team plans it, splits it up and checks in when it needs you."
          aria-describedby={ids.note}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="home-task-bar">
          <label className="home-chip home-target" data-kind={chat ? 'chat' : 'project'}>
            <span className="sr-only">Where to start it</span>
            {chat ? (
              <Icon icon={MessageSquare} size="sm" />
            ) : (
              <span className="home-target-dot" data-hue={project ? projectHue(project.id) : 0} aria-hidden="true" />
            )}
            <select className="home-target-select" data-testid="home-target" id={ids.target} value={targetId} onChange={(e) => setChosen(e.target.value)}>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.kind === 'chat' ? 'Chat (no project)' : t.label}
                </option>
              ))}
            </select>
            <Icon icon={ChevronDown} size="sm" />
          </label>
          {scope && (
            <span className="home-chip" data-testid="home-scope" title="Set in the project's team. The New run page can narrow it.">
              {scope}
            </span>
          )}
          {permission && (
            <span className="home-chip" data-testid="home-permission" title="The project's permission setting. The New run page can change it for one run.">
              {permission}
            </span>
          )}
          <span className="home-task-grow" />
          <span className="home-hint" id={ids.note} data-testid="home-hint">
            {mod} + Enter
          </span>
          <Button variant="primary" testId="home-start" disabled={!can} onClick={start} title={chat ? 'Opens a new Chat with this task' : 'Opens the New run page with this task, ready to send'}>
            {chat ? 'Start chat' : 'Start run'}
          </Button>
        </div>
      </div>
      <div className="home-try" role="group" aria-label="Try one of these">
        <span className="home-try-label" aria-hidden="true">
          Try
        </span>
        {HERO_SUGGESTIONS.map((s) => (
          <Chip key={s} data-testid="home-suggest" onClick={() => suggest(s)}>
            {s}
          </Chip>
        ))}
        <Chip data-testid="home-chat" onClick={chatNow}>
          Just chat with one assistant
        </Chip>
      </div>
    </section>
  )
}
