import type { KeyboardEvent, ReactElement } from 'react'
import { useEffect, useId, useMemo, useState } from 'react'
import type { Project } from '@shared/types'
import { waitingItems } from '@shared/view/needsYou'
import { useAppStore } from '../../store/useAppStore'
import { Button } from '../ui/Button'
import { KindMark } from '../knowledge/KindMark'
import { openProjectSettings } from '../../lib/openProjectSettings'
import { PROJECT_SETTINGS_SECTIONS } from '../../lib/settingsTarget'
import { displayRunName } from '../../lib/orgChange'
import { useNow } from '../dashboard/useDashboardData'
import { permissionWords, plural, teamSummary } from '../../lib/projectHome'
import { connectionRows, engagementFacts, folderRows, knowledgeHome, latestFiles, purposeOf, recentRuns, type RecentRunIn } from '../../lib/projectHomeEngagement'
import { HomeLink, HomeSection } from './HomeSection'
import { openNewRunWith } from './startRun'
import { useEngagementData, useProjectHistory, useProjectMcp } from './useHomeData'

type Mode = 'team' | 'ask'

/**
 * EngagementHome (docs/design/ui-overhaul/project/EngagementHome.dc.html): serif headings and a coral accent, in plain
 * words that fit any kind of engagement. No stages, no client or deliverable vocabulary: every line comes from what the
 * engagement holds (its description, runs, files, knowledge, tools, folders and team) and a section with nothing to say
 * is left out.
 */
export default function EngagementHome({ project }: { project: Project }): ReactElement {
  const now = useNow()
  const setView = useAppStore((s) => s.setView)
  const jumpToDecision = useAppStore((s) => s.jumpToDecision)
  const focusRun = useAppStore((s) => s.focusRun)
  const openOutputItem = useAppStore((s) => s.openOutputItem)
  const openProjectMcp = useAppStore((s) => s.openProjectMcp)
  const loadOutputs = useAppStore((s) => s.loadOutputs)
  const outputs = useAppStore((s) => s.outputsByProject[project.id])
  const runs = useAppStore((s) => s.runs)
  const history = useProjectHistory(project.id)
  const { document, items } = useEngagementData(project.id)
  const mcp = useProjectMcp(project)

  useEffect(() => {
    void loadOutputs(project.id)
  }, [project.id, loadOutputs])

  const mine = useMemo(() => Object.values(runs).filter((r) => r.summary.projectId === project.id), [runs, project.id])
  const waiting = useMemo(() => mine.flatMap((r) => waitingItems(r, 'engagement').map((w) => ({ ...w, runName: displayRunName(r.summary) }))), [mine])

  const recent = useMemo(() => {
    const live = new Map(mine.map((r) => [r.summary.id, r]))
    const inputs: RecentRunIn[] = history.map((h) => {
      const r = live.get(h.id)
      return { summary: r?.summary ?? h, agents: r?.agents, plan: r?.plan, decisions: r ? waitingItems(r, 'engagement').length : 0 }
    })
    return recentRuns(inputs, now)
  }, [history, mine, now])

  const purpose = purposeOf(document)
  const facts = engagementFacts({ project, runs: history, outputs: outputs ?? [], now })
  const files = latestFiles(outputs ?? [], now)
  const knowledge = items ? knowledgeHome(items, now) : null
  const connections = connectionRows(mcp ?? undefined)
  const folders = folderRows(project)
  const team = useMemo(() => teamSummary(project.roles), [project.roles])
  const editDescription = (): void => openProjectSettings(project.id, PROJECT_SETTINGS_SECTIONS.engagementPlan)

  return (
    <div className="home-page eng-home" data-testid="engagement-home" data-kind="engagement">
      <div className="home-scroll">
        <div className="eng-ground">
          <section className="eng-hero" aria-labelledby="eng-hero-h" data-testid="eng-about">
            <div className="eng-hero-main">
              <h2 id="eng-hero-h" className="eng-eyebrow">
                What this engagement is for
              </h2>
              <p className="eng-hero-title">{project.name}</p>
              {purpose ? (
                <p className="eng-hero-text" data-testid="eng-purpose">
                  {purpose.text}
                </p>
              ) : document !== undefined ? (
                <p className="eng-hero-text is-empty" data-testid="eng-purpose">
                  There is no description yet. A few lines on what this is for help the team stay on track.
                </p>
              ) : null}
              <button type="button" className="eng-text-btn" onClick={editDescription} data-testid="eng-edit-description">
                {purpose ? 'Edit the description' : 'Add a description'}
              </button>
            </div>
            {facts.length > 0 && (
              <dl className="eng-facts" data-testid="eng-facts">
                {facts.map((f) => (
                  <div key={f.label} className="eng-fact">
                    <dt>{f.label}</dt>
                    <dd>{f.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>

          <StartBox project={project} roleCount={team.roleCount} />

          <div className="eng-columns">
            <div className="eng-col-main">
              {waiting.length > 0 && (
                <HomeSection title="Waiting on you" className="eng-waiting" testId="eng-waiting" tone="waiting" enter={0} action={<HomeLink onClick={() => setView('inbox')} testId="eng-inbox">Inbox</HomeLink>}>
                  <ul className="eng-rows" aria-label="Decisions waiting">
                    {waiting.map((w) => (
                      <li key={w.key} className="eng-ask">
                        <span className="eng-ask-text">
                          <span className="eng-ask-q">{w.label}</span>
                          <span className="eng-ask-who">{w.runName}</span>
                        </span>
                        <button type="button" className="eng-pill-btn" onClick={() => void jumpToDecision(project.id, w.runId, w.key)} aria-label={`Review: ${w.label}`} data-testid="eng-review">
                          Review
                        </button>
                      </li>
                    ))}
                  </ul>
                </HomeSection>
              )}

              {recent.length > 0 && (
                <HomeSection title="Recent work" testId="eng-recent" enter={1} action={<HomeLink onClick={() => setView('history')} testId="eng-all-runs">All runs</HomeLink>}>
                  <ul className="eng-rows" aria-label="Recent runs">
                    {recent.map((r) => (
                      <li key={r.id}>
                        <button type="button" className="eng-run" onClick={() => void focusRun(project.id, r.id)} data-testid="eng-run" data-tone={r.tone}>
                          <span className={`home-state-dot${r.tone === 'working' ? ' motion-pulse' : r.tone === 'waiting' ? ' motion-breathe' : ''}`} data-tone={r.tone} aria-hidden="true" />
                          <span className="eng-run-main">
                            <span className="eng-run-title">{r.title}</span>
                            <span className="eng-run-result">{r.result}</span>
                          </span>
                          {r.who && <span className="eng-run-who">{r.who}</span>}
                          <span className="eng-run-when">{r.when}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </HomeSection>
              )}

              {files.length > 0 && (
                <HomeSection title="Latest files" testId="eng-files" enter={2} action={<HomeLink onClick={() => setView('outputs')} testId="eng-all-files">All files</HomeLink>}>
                  <ul className="eng-files" aria-label="Latest files">
                    {files.map((f) => (
                      <li key={f.id}>
                        <button type="button" className="eng-file motion-lift" onClick={() => openOutputItem({ projectId: project.id, outputId: f.id })} data-testid="eng-file">
                          <span className="eng-file-kind">{f.kind}</span>
                          <span className="eng-file-name">{f.name}</span>
                          <span className="eng-file-note">{f.note}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </HomeSection>
              )}
            </div>

            <div className="eng-col-side">
              {items !== undefined && items !== null && (
                <HomeSection title="What the team knows" testId="eng-knowledge" enter={0} action={<HomeLink onClick={() => setView('knowledge')} testId="eng-open-knowledge">Open Knowledge</HomeLink>}>
                  {knowledge ? (
                    <>
                      <p className="eng-figure-row">
                        <span className="eng-figure" data-testid="eng-knowledge-count">
                          {knowledge.count}
                        </span>
                        <span className="eng-figure-note">
                          {knowledge.count === 1 ? 'item' : 'items'}
                          {knowledge.addedThisWeek > 0 ? ` · ${knowledge.addedThisWeek} added this week` : ''}
                        </span>
                      </p>
                      <ul className="eng-kinds" aria-label="Kinds of knowledge">
                        {knowledge.kinds.map((k) => (
                          <li key={k.kind} className="eng-kind">
                            <KindMark kind={k.kind} />
                            {k.label} <span className="eng-kind-n">{k.count}</span>
                          </li>
                        ))}
                      </ul>
                      <ul className="eng-rows" aria-label="Latest knowledge">
                        {knowledge.latest.map((l) => (
                          <li key={l.id} className="eng-know">
                            <span className="eng-know-name">{l.name}</span>
                            <span className="eng-know-by">
                              {l.kindLabel} · {l.when}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="eng-note">Nothing recorded yet. The team adds what it learns as it works, and you can add what you know.</p>
                  )}
                  <button type="button" className="eng-pill-btn is-quiet" onClick={() => setView('knowledge')} data-testid="eng-add-knowledge">
                    Add something you know
                  </button>
                </HomeSection>
              )}

              {mcp !== null && mcp !== undefined && (
                <HomeSection title="Connections" testId="eng-connections" enter={1} action={<HomeLink onClick={() => openProjectMcp(project.id)} testId="eng-manage-connections">Manage</HomeLink>}>
                  <p className="eng-note">Tools and services the team can use in this engagement.</p>
                  {connections.length > 0 ? (
                    <ul className="eng-rows" aria-label="Connections">
                      {connections.map((c) => (
                        <li key={c.id} className="eng-conn" data-tone={c.tone}>
                          <span className="eng-conn-mark" aria-hidden="true">
                            {c.initial}
                          </span>
                          <span className="eng-conn-name">{c.name}</span>
                          <span className="eng-conn-status">
                            <span className="home-state-dot" data-tone={c.tone === 'ok' ? 'ok' : c.tone === 'warn' ? 'warn' : 'muted'} aria-hidden="true" />
                            {c.status}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="eng-note">None connected yet.</p>
                  )}
                </HomeSection>
              )}

              <HomeSection title="Folders" testId="eng-folders">
                <ul className="eng-rows" aria-label="Folders">
                  {folders.map((f) => (
                    <li key={f.path} className="eng-folder">
                      <span className="eng-folder-name" title={f.path}>
                        {f.name}
                      </span>
                      <span className="eng-mode" data-writes={f.writes ? '' : undefined}>
                        {f.mode}
                      </span>
                    </li>
                  ))}
                </ul>
              </HomeSection>

              <HomeSection title="The team" testId="eng-team" action={<HomeLink onClick={() => setView('team')} testId="eng-open-team">Open</HomeLink>}>
                <p className="eng-note" data-testid="eng-team-line">
                  {team.groups.length > 0 ? `${plural(team.roleCount, 'role')} in ${plural(team.groups.length, 'group')}` : plural(team.roleCount, 'role')}
                  {' · '}
                  {permissionWords(project.permissionMode)}
                </p>
                {team.groups.length > 0 && (
                  <ul className="eng-teamgroups" aria-label="Groups">
                    {team.groups.map((g) => (
                      <li key={g.id} className="eng-teamgroup">
                        <span className="eng-teamgroup-name" title={g.name}>
                          {g.name}
                        </span>
                        <span className="home-squares" aria-hidden="true">
                          {g.colors.map((c, i) => (
                            <span key={i} className="home-square" style={{ background: c }} />
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </HomeSection>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- "What do you need?" ----------

function StartBox({ project, roleCount }: { project: Project; roleCount: number }): ReactElement {
  const id = useId()
  const [mode, setMode] = useState<Mode>('team')
  const [text, setText] = useState('')
  const start = (): void => openNewRunWith(project.id, text, mode)
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      start()
    }
  }
  return (
    <section className="home-section eng-start glass-strong" aria-labelledby={`${id}-h`} data-testid="eng-start">
      <div className="eng-start-head">
        <h2 id={`${id}-h`} className="home-section-title">
          What do you need?
        </h2>
        <div role="group" aria-label="Who does it" className="eng-toggle">
          {(
            [
              ['team', 'Whole team'],
              ['ask', 'One assistant']
            ] as const
          ).map(([m, label]) => (
            <button key={m} type="button" aria-pressed={mode === m} className="eng-toggle-btn" onClick={() => setMode(m)} data-testid={`eng-mode-${m}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <label htmlFor={`${id}-t`} className="home-sr">
        {mode === 'team' ? 'Describe a piece of work' : 'Ask a question'}
      </label>
      <textarea
        id={`${id}-t`}
        className="eng-start-text"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={mode === 'team' ? 'Describe a piece of work. The team plans it and checks in when it needs you.' : 'Ask a question or give a small task. One assistant answers.'}
        aria-describedby={`${id}-note`}
        data-testid="eng-start-text"
      />
      <div className="eng-start-foot">
        <span id={`${id}-note`} className="eng-note">
          {mode === 'team' ? `${plural(roleCount, 'role')} · ${permissionWords(project.permissionMode)}` : "One assistant · works with this engagement's folders, services and skills"}
        </span>
        <span className="home-spacer" />
        <Button variant="primary" onClick={start} testId="eng-start-button">
          Start
        </Button>
      </div>
    </section>
  )
}
