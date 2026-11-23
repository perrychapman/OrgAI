import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { useMemo, useRef } from 'react'
import { CalendarClock, ChevronDown, ChevronRight, Files } from 'lucide-react'
import type { RunSummary } from '@shared/types'
import { MenuButton, type ContextMenuControl } from '../ui/ContextMenu'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Badge } from '../ui/Badge'
import { Cost } from '../ui/Cost'
import { selectedProject, useAppStore } from '../../store/useAppStore'
import { runCostInput, sumCosts, formatDuration } from '../../lib/cost'
import { isOpenStatus, lastActivityAt, type ChainGroup } from '../../lib/runChains'
import { promptLine, runTag, shortPrompt } from '../../lib/runLabels'
import { displayRunName, isOrgChangeRun, runKindWord } from '../../lib/orgChange'
import { statusOfRun, statusText } from '../../lib/runStatus'
import { outputsCountLabel, outputsOfRuns } from '../../lib/outputs'
import { quickFolderLabel } from '../../lib/assistants'
import { agentsLabel, agentTally, branchFacts, chainFacts, mergeWord, resultLine, tallyText, type OutputsPhase } from '../../lib/runHistory'
import { useAgentStrip } from './useAgentStrip'
import { groupStatus } from './groupStatus'
import { openChainOutputs } from './openChainOutputs'

/** Untrusted prompt text in a tooltip is capped. */
const TIP_CHARS = 300
export const memberRowId = (runId: string): string => `history-member-${runId}`

/**
 * One conversation (a session chain) in a day group. The row is a real table row: the title button selects it (the
 * detail panel shows it), Open opens it on the Live tab, a chain of several sessions expands to list them. The Menu key
 * or Shift+F10 on the title or Open button opens the row's action menu.
 */
export function HistoryRow({
  group,
  indexes,
  viewed,
  selected,
  pulse,
  isExpanded,
  onToggle,
  onSelect,
  onOpen,
  chat,
  outputsPhase,
  menu,
  fallbackFocus
}: {
  group: ChainGroup<RunSummary>
  indexes: Map<string, number>
  viewed: boolean
  selected: boolean
  /** The cyan ring on a running dot; the page lets at most a dozen pulse at once. */
  pulse: boolean
  isExpanded: boolean
  onToggle: () => void
  onSelect: () => void
  onOpen: (id: string) => Promise<void>
  chat: boolean
  /** Whether the outputs index is loading or failed: the row then says so instead of showing no file count. */
  outputsPhase: OutputsPhase
  menu: ContextMenuControl<string>
  fallbackFocus: () => HTMLElement | null
}): ReactElement {
  const { first, newest, members } = group
  const liveNewest = useAppStore((s) => s.runs[newest.id])
  const proj = useAppStore(selectedProject)
  const status = groupStatus(liveNewest, newest, proj)
  const words = statusText(status)
  const sessions = members.length
  const last = lastActivityAt(newest)
  const open = isOpenStatus(newest.status)
  const tag = runTag(indexes.get(first.id))
  const cost = useMemo(() => sumCosts(members.map(runCostInput)), [members])
  const facts = useMemo(() => chainFacts(members), [members])
  const orgChange = isOrgChangeRun(first)
  const name = first.title || orgChange ? displayRunName(first) : promptLine(first.prompt)
  // What the conversation produced (docs/design/outputs.md section 12): every member run, from the loaded index.
  const outputCount = useAppStore((s) => (first.kind === 'work' && !first.quick ? outputsOfRuns(s.outputsByProject[first.projectId], members.map((m) => m.id)).length : 0))
  // A work run whose index is not here yet has an unknown file count, not zero.
  const filesUnknown = outputsPhase !== 'ready' && first.kind === 'work' && !first.quick && outputCount === 0
  const openOutputs = (): void => openChainOutputs(newest.id, onOpen)
  const onRowKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    const btn = e.target instanceof Element ? e.target.closest<HTMLElement>('button.run-open, button.hb-main') : null
    if (btn) menu.onKeyDown(e, group.key, { anchor: btn, invoker: btn, fallbackFocus })
  }
  const cellRef = useRef<HTMLTableCellElement>(null)
  const strip = useAgentStrip(newest, cellRef)
  const branch = useMemo(() => branchFacts(strip.agents), [strip.agents])
  const merge = open ? '' : mergeWord(branch)
  const tally = useMemo(() => agentTally(strip.agents.map((a) => a.state), 16), [strip.agents])
  const scheduled = members.find((m) => m.scheduleId)
  const baseResult = resultLine({ word: status.word, note: status.note, error: newest.error, pauseReason: newest.pauseReason, sessions })
  const result = merge ? `${baseResult} · ${merge}` : baseResult
  const tone = status.tone
  return (
    <>
      <tr
        className={`run-row hb-row${viewed ? ' active' : ''}${selected ? ' is-selected' : ''}`}
        data-chain={group.key}
        data-sessions={sessions}
        data-tone={tone}
        onContextMenu={(e) => menu.onContextMenu(e, group.key, { fallbackFocus, invoker: e.currentTarget.querySelector<HTMLElement>('[data-testid=history-more]') ?? e.currentTarget.querySelector<HTMLElement>('button.run-open') ?? undefined })}
        onKeyDown={onRowKeyDown}
        onClick={(e) => {
          // A click anywhere on the row selects it; the controls inside keep their own jobs.
          if (!(e.target instanceof Element) || !e.target.closest('button, a, input, select')) onSelect()
        }}
      >
        <td className="hb-c-main">
          <div className="hb-main-wrap">
            {sessions > 1 && <IconButton icon={isExpanded ? ChevronDown : ChevronRight} size="sm" label={`Sessions of ${tag}`} expanded={isExpanded} controls={isExpanded ? members.map((m) => memberRowId(m.id)).join(' ') : undefined} onClick={onToggle} testId="history-sessions-toggle" />}
            <button type="button" className="hb-main" aria-current={selected ? 'true' : undefined} onClick={onSelect} onDoubleClick={() => void onOpen(newest.id)} title={`${shortPrompt(first.prompt, TIP_CHARS)}\n${status.note ?? ''}`.trim()}>
              <span className={`hb-dot${tone === 'is-running' && pulse ? ' motion-pulse' : ''}`} data-tone={tone} aria-hidden="true" />
              <span className="hb-text">
                <span className="hb-title" title={name}>
                  <span className="run-index">{tag}</span> {name}
                </span>
                <span className="hb-result" title={newest.pauseReason ?? status.note}>
                  <span className="hb-result-text">
                    <span className="sr-only">Status: </span>
                    {result}
                  </span>
                  <span className="hb-kind" data-testid="run-kind" data-kind={first.quick ? 'chat' : first.team === 'single' ? 'ask' : first.kind === 'work' ? 'work' : orgChange ? 'org-change' : first.kind}>
                    <Badge tone={first.kind === 'setup' ? 'accent' : 'neutral'}>{runKindWord(first)}</Badge>
                  </span>
                </span>
              </span>
            </button>
            {(viewed || scheduled || outputCount > 0 || filesUnknown) && (
              <span className="hb-tags">
                {scheduled && (
                  <Badge tone="neutral" icon={CalendarClock} title={scheduled.scheduleName ? `Started by the schedule ${scheduled.scheduleName}` : 'Started by a schedule'} testId="history-scheduled">
                    Scheduled
                  </Badge>
                )}
                {viewed && (
                  <Badge tone="accent" title="This conversation is open on the Live tab">
                    Open in Live
                  </Badge>
                )}
                {filesUnknown && (
                  <span className="hb-files-unknown" data-testid="history-files-unknown">
                    {outputsPhase === 'loading' ? 'Checking files…' : 'Files not loaded'}
                  </span>
                )}
                {outputCount > 0 && (
                  <Button size="sm" variant="ghost" icon={Files} className="history-outputs" testId="history-outputs" ariaLabel={`Open ${outputCount} ${outputCount === 1 ? 'file' : 'files'} of ${tag}`} title="Open this conversation on its Outputs tab" onClick={openOutputs}>
                    {outputsCountLabel(outputCount)}
                  </Button>
                )}
              </span>
            )}
          </div>
        </td>
        {chat && (
          <td className="hb-c-folder col-folder" data-testid="history-folder" title={first.quick?.scratch ? 'A private scratch folder' : first.quick?.folder}>
            {quickFolderLabel(first.quick)}
          </td>
        )}
        <td className="hb-c-agents tabular" ref={cellRef}>
          {facts.agents === null ? (
            <span title="Not recorded for this run">
              <span aria-hidden="true">{'–'}</span>
              <span className="sr-only">Agents unknown</span>
            </span>
          ) : (
            agentsLabel(facts.agents)
          )}
          {strip.phase === 'ready' && tally.total > 0 && (
            <span className="hb-strip" role="img" aria-label={`Final state of ${agentsLabel(tally.total)}${members.length > 1 ? ' in the latest session' : ''}: ${tallyText(tally)}`} data-testid="history-row-strip">
              {tally.marks.map((m, i) => (
                <span key={i} className="hb-mark" data-mark={m} />
              ))}
              {tally.more > 0 && <span className="hb-marks-more">+{tally.more}</span>}
              {tally.counts.error > 0 && <span className="hb-strip-bad">{tally.counts.error} failed</span>}
            </span>
          )}
          {strip.phase === 'loading' && <span className="hb-strip-note" data-testid="history-row-strip-loading">Checking agents…</span>}
          {strip.phase === 'failed' && <span className="hb-strip-note" data-testid="history-row-strip-failed">Agents not loaded</span>}
        </td>
        <td className="hb-c-time tabular" title={`Last activity ${new Date(last).toLocaleString()}`}>
          {facts.wallMs === null ? (
            <span title="Not recorded for this run">
              <span aria-hidden="true">{'–'}</span>
              <span className="sr-only">Time unknown</span>
            </span>
          ) : (
            formatDuration(facts.wallMs)
          )}
        </td>
        <td className="hb-c-cost tabular">
          <Cost value={cost} />
        </td>
        <td className="hb-c-act">
          <div className="run-row-actions hb-actions">
            <Button size="sm" variant="ghost" className="run-open" onClick={() => void onOpen(newest.id)} title={open ? 'Open this live run' : 'Open this run'} ariaLabel={`Open ${tag}: ${words}`}>
              Open
            </Button>
            <MenuButton control={menu} target={group.key} label={`More actions for ${tag}`} testId="history-more" fallbackFocus={fallbackFocus} />
          </div>
        </td>
      </tr>
      {isExpanded && members.map((m, i) => <MemberRow key={m.id} member={m} number={i + 1} chat={chat} onOpen={() => void onOpen(m.id)} />)}
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
    <tr className="run-member-row hb-member motion-enter" style={{ '--i': Math.min(number - 1, 5) } as CSSProperties} id={memberRowId(member.id)} data-run={member.id}>
      <td className="hb-c-main">
        <div className="run-member">
          <span className="run-member-no">Session {number}</span>
          <span className="run-member-prompt" title={shortPrompt(member.prompt, TIP_CHARS)}>
            {promptLine(member.prompt)}
          </span>
        </div>
      </td>
      {chat && <td className="hb-c-folder" />}
      <td className="hb-c-agents">{statusText(status)}</td>
      <td className="hb-c-time tabular" title={started.toLocaleString()}>
        {started.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </td>
      <td className="hb-c-cost tabular">
        <Cost value={runCostInput(member)} />
      </td>
      <td className="hb-c-act">
        <div className="run-row-actions hb-actions">
          <Button size="sm" variant="ghost" className="run-member-open" ariaLabel={`Open session ${number}`} onClick={onOpen}>
            Open
          </Button>
        </div>
      </td>
    </tr>
  )
}
