import type { ReactElement } from 'react'
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, FolderPlus, History as HistoryIcon } from 'lucide-react'
import type { RunSummary } from '@shared/types'
import { QUICK_PROJECT_ID, RUN_KIND_LABELS, isVirtualProjectId } from '@shared/types'
import { activeRun, selectedProject, useAppStore, useProjectSummaries, useRunIndexes } from '../store/useAppStore'
import { Cost } from './ui/Cost'
import { runCostInput, sumCosts } from '../lib/cost'
import { canContinueIn, chainGroups, isOpenStatus, lastActivityAt, needsYou, relativeTime, type ChainGroup } from '../lib/runChains'
import { promptLine, runName, runTag, shortPrompt } from '../lib/runLabels'
import { statusOfRun, statusText, type RunTone } from '../lib/runStatus'
import { SegmentedControl } from './ui/SegmentedControl'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { Badge, type BadgeTone } from './ui/Badge'
import { Icon } from './ui/Icon'
import UsageTrends from './UsageTrends'
import SaveAsProjectDialog from './assistants/SaveAsProjectDialog'
import { canPromote, offersRetro, offersSaveAsProject, quickFolderLabel, runKindLabel, SCRATCH_PROMOTE_REASON } from '../lib/assistants'

/** Untrusted prompt text in a tooltip is capped. */
const TIP_CHARS = 300
const memberRowId = (runId: string): string => `history-member-${runId}`

type Filter = 'all' | 'work' | 'ask' | 'setup'
type HistoryView = 'runs' | 'trends'

/** History is the one place status is content: the shared status words in the Badge status tones. */
const STATUS_BADGE: Record<RunTone, BadgeTone> = {
  'is-running': 'info',
  warn: 'attention',
  idle: 'neutral',
  paused: 'neutral',
  ok: 'success',
  danger: 'danger',
  stopped: 'neutral'
}

/**
 * The History tab: one row per conversation (a session chain) as a table (prompt first, status, cost, age, kind) with
 * its actions. Rows are real table rows; every action is a real button. Opening a row switches to Live and shows the
 * chain's tab. A chain of several sessions can be expanded to list them.
 */
export default function RunHistory(): ReactElement {
  const summaries = useProjectSummaries()
  const openRun = useAppStore((s) => s.openRun)
  const continueFromHistory = useAppStore((s) => s.continueFromHistory)
  const startRetro = useAppStore((s) => s.startRetro)
  const current = useAppStore(activeRun)
  const indexes = useRunIndexes()
  const [filter, setFilter] = useState<Filter>('all')
  const [view, setView] = useState<HistoryView>('runs')
  const project = useAppStore(selectedProject)
  const isChat = project?.id === QUICK_PROJECT_ID
  const [saving, setSaving] = useState<RunSummary | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const groups = useMemo(() => chainGroups(summaries), [summaries])
  // The kind filter applies to a chain by its first member.
  const shown = groups.filter(
    (g) =>
      filter === 'all' ||
      (filter === 'ask' ? g.first.team === 'single' : filter === 'work' ? g.first.kind === 'work' && g.first.team !== 'single' : g.first.kind === 'setup')
  )
  const viewedKey = current ? groups.find((g) => g.members.some((m) => m.id === current.summary.id))?.key : undefined

  return (
    <div className="history">
      <div className="history-bar">
        <h2>History</h2>
        <div className="history-bar-controls">
          <SegmentedControl<HistoryView>
            label="History view"
            value={view}
            options={[
              { value: 'runs', label: 'Runs' },
              { value: 'trends', label: 'Trends' }
            ]}
            onChange={setView}
          />
          {view === 'runs' && !(project && isVirtualProjectId(project.id)) && (
            <SegmentedControl<Filter>
              label="Show runs of kind"
              value={filter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'work', label: RUN_KIND_LABELS.work },
                { value: 'ask', label: 'Ask' },
                { value: 'setup', label: RUN_KIND_LABELS.setup }
              ]}
              onChange={setFilter}
            />
          )}
        </div>
      </div>
      {view === 'trends' ? (
        project ? (
          <UsageTrends projectId={project.id} />
        ) : null
      ) : summaries.length === 0 ? (
        <div className="history-empty">
          <Icon icon={HistoryIcon} size="lg" />
          <p>No runs yet. Give the team a goal on the Live tab; every run you start is kept here.</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="history-empty">
          <p>No {filter === 'work' ? RUN_KIND_LABELS.work.toLowerCase() : filter} runs in this project.</p>
        </div>
      ) : (
        <div className="history-scroll">
          <table className="history-table" aria-label="Runs of this project">
            <thead>
              <tr>
                <th scope="col" className="col-prompt">
                  Prompt
                </th>
                <th scope="col">Status</th>
                <th scope="col" className="col-cost">
                  Cost
                </th>
                <th scope="col" className="col-started">
                  Age
                </th>
                <th scope="col" className="col-kind">
                  Kind
                </th>
                {isChat && (
                  <th scope="col" className="col-folder">
                    Folder
                  </th>
                )}
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((g) => (
                <HistoryChain
                  key={g.key}
                  group={g}
                  indexes={indexes}
                  viewed={viewedKey === g.key}
                  isExpanded={!!expanded[g.key]}
                  onToggle={() => setExpanded((e) => ({ ...e, [g.key]: !e[g.key] }))}
                  onOpen={(id) => void openRun(id)}
                  onContinue={() => void continueFromHistory(g.newest.id)}
                  onRetro={() => void startRetro(g.newest.id)}
                  chat={isChat}
                  onSave={() => setSaving(g.newest)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {saving && <SaveAsProjectDialog summary={saving} onClose={() => setSaving(null)} />}
    </div>
  )
}

function HistoryChain({
  group,
  indexes,
  viewed,
  isExpanded,
  onToggle,
  onOpen,
  onContinue,
  onRetro,
  chat,
  onSave
}: {
  group: ChainGroup<RunSummary>
  indexes: Map<string, number>
  viewed: boolean
  isExpanded: boolean
  onToggle: () => void
  onOpen: (id: string) => void
  onContinue: () => void
  onRetro: () => void
  chat: boolean
  onSave: () => void
}): ReactElement {
  const { first, newest, members } = group
  const liveNewest = useAppStore((s) => s.runs[newest.id])
  const proj = useAppStore(selectedProject)
  const status = statusOfRun(liveNewest ?? { summary: newest }, proj, !!liveNewest && needsYou(liveNewest))
  const words = statusText(status)
  const sessions = members.length
  const last = lastActivityAt(newest)
  const open = isOpenStatus(newest.status)
  const tag = runTag(indexes.get(first.id))
  const cost = useMemo(() => sumCosts(members.map(runCostInput)), [members])
  return (
    <>
      <tr className={`run-row ${viewed ? 'active' : ''}`} data-chain={group.key} data-sessions={sessions}>
        <td className="col-prompt">
          <div className="run-head">
            {sessions > 1 && <IconButton icon={isExpanded ? ChevronDown : ChevronRight} size="sm" label={`Sessions of ${tag}`} expanded={isExpanded} controls={isExpanded ? members.map((m) => memberRowId(m.id)).join(' ') : undefined} onClick={onToggle} testId="history-sessions-toggle" />}
            <div className="run-head-text">
              {first.title ? (
                <>
                  <div className="run-name" title={runName(first)}>
                    <span className="run-index">{tag}</span> {runName(first)}
                  </div>
                  <div className="prompt muted" title={shortPrompt(first.prompt, TIP_CHARS)}>
                    {promptLine(first.prompt)}
                  </div>
                </>
              ) : (
                <div className="prompt" title={shortPrompt(first.prompt, TIP_CHARS)}>
                  <span className="run-index">{tag}</span> {promptLine(first.prompt)}
                </div>
              )}
            </div>
            {sessions > 1 && (
              <Badge tone="neutral" title={`${sessions} sessions in this conversation`}>
                {sessions} sessions
              </Badge>
            )}
          </div>
        </td>
        <td>
          <Badge tone={STATUS_BADGE[status.tone]} title={newest.pauseReason ?? status.note}>
            <span className="status-dot" aria-hidden="true" />
            {words}
          </Badge>
        </td>
        <td className="col-cost">
          <Cost value={cost} />
        </td>
        <td className="col-started" title={new Date(last).toLocaleString()}>
          {relativeTime(last)}
        </td>
        <td className="col-kind">
          <span data-testid="run-kind" data-kind={first.quick ? 'chat' : first.team === 'single' ? 'ask' : first.kind === 'work' ? 'work' : first.kind}>
            <Badge tone={first.kind === 'setup' ? 'accent' : 'neutral'}>{runKindLabel(first)}</Badge>
          </span>
        </td>
        {chat && (
          <td className="col-folder" data-testid="history-folder" title={first.quick?.scratch ? 'A private scratch folder' : first.quick?.folder}>
            {quickFolderLabel(first.quick)}
          </td>
        )}
        <td>
          <div className="run-row-actions">
            <Button size="sm" className="run-open" onClick={() => onOpen(newest.id)} title={open ? 'Open this live run' : 'Open this run'}>
              Open
            </Button>
            {viewed && (
              <Badge tone="accent" title="This conversation is open on the Live tab">
                Open in Live
              </Badge>
            )}
            {canContinueIn(members, newest.id) && (
              <Button size="sm" variant="secondary" className="run-continue" title="Open this run and continue its session with its memory" onClick={onContinue}>
                Continue
              </Button>
            )}
            {chat && offersSaveAsProject(newest) && !open && (
              canPromote(newest).ok ? (
                <Button size="sm" icon={FolderPlus} className="run-save" testId="history-save-as-project" title="Save this chat as a project in its folder" onClick={onSave}>
                  Save as project
                </Button>
              ) : (
                <span className="run-act-disabled" title={SCRATCH_PROMOTE_REASON}>
                  <Button size="sm" icon={FolderPlus} className="run-save" testId="history-save-as-project" disabled>
                    Save as project
                  </Button>
                </span>
              )
            )}
            {offersRetro(newest) && (
              <Button size="sm" className="run-retro" title="Have the Architect review this run and revise the org chart where roles struggled" onClick={onRetro}>
                Retrospective
              </Button>
            )}
          </div>
        </td>
      </tr>
      {isExpanded &&
        members.map((m, i) => (
          <MemberRow key={m.id} member={m} number={i + 1} chat={chat} onOpen={() => onOpen(m.id)} />
        ))}
    </>
  )
}

/** One session of an expanded chain: when it started, its prompt, cost and Open (which scrolls the feed to it). */
function MemberRow({ member, number, chat, onOpen }: { member: RunSummary; number: number; chat: boolean; onOpen: () => void }): ReactElement {
  const live = useAppStore((s) => s.runs[member.id])
  const proj = useAppStore(selectedProject)
  const status = statusOfRun(live ?? { summary: member }, proj, false)
  const started = new Date(member.startedAt)
  return (
    <tr className="run-member-row" id={memberRowId(member.id)} data-run={member.id}>
      <td className="col-prompt">
        <div className="run-member">
          <span className="run-member-no">Session {number}</span>
          <span className="run-member-prompt" title={shortPrompt(member.prompt, TIP_CHARS)}>
            {promptLine(member.prompt)}
          </span>
        </div>
      </td>
      <td>{statusText(status)}</td>
      <td className="col-cost">
        <Cost value={runCostInput(member)} />
      </td>
      <td className="col-started" title={started.toLocaleString()}>
        {started.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
      </td>
      <td className="col-kind" />
      {chat && <td className="col-folder" />}
      <td>
        <div className="run-row-actions">
          <Button size="sm" className="run-member-open" ariaLabel={`Open session ${number}`} onClick={onOpen}>
            Open
          </Button>
        </div>
      </td>
    </tr>
  )
}

