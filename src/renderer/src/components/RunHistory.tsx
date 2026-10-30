import type { ReactElement } from 'react'
import { useState } from 'react'
import { History as HistoryIcon } from 'lucide-react'
import type { RunSummary } from '@shared/types'
import { activeRun, useAppStore, useProjectSummaries, useRunIndexes } from '../store/useAppStore'
import { costLabel } from '../lib/layout'
import { canContinue, chainOf, continuedBy, isOpenStatus, needsYou, predecessorOf, relativeTime } from '../lib/runChains'
import { promptLine, runTag, shortPrompt } from '../lib/runLabels'
import { runStatus } from '../lib/runStatus'
import { SegmentedControl } from './ui/SegmentedControl'
import { Button } from './ui/Button'
import { Icon } from './ui/Icon'

type Filter = 'all' | 'work' | 'setup'

/**
 * The History tab: every run of the project as a table (status, prompt first, kind, started, cost) with its
 * actions. Rows are real table rows; every action is a real button. Opening a run switches to Live and shows it.
 */
export default function RunHistory(): ReactElement {
  const summaries = useProjectSummaries()
  const runs = useAppStore((s) => s.runs)
  const openRun = useAppStore((s) => s.openRun)
  const continueFromHistory = useAppStore((s) => s.continueFromHistory)
  const startRetro = useAppStore((s) => s.startRetro)
  const current = useAppStore(activeRun)
  const authMode = useAppStore((s) => s.usage?.authMode ?? 'unknown')
  const indexes = useRunIndexes()
  const [filter, setFilter] = useState<Filter>('all')

  const shown = summaries.filter((r) => filter === 'all' || (filter === 'work' ? r.kind === 'work' : r.kind === 'setup'))

  return (
    <div className="history">
      <div className="history-bar">
        <h2>History</h2>
        <SegmentedControl<Filter>
          label="Show runs of kind"
          value={filter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'work', label: 'Work' },
            { value: 'setup', label: 'Setup' }
          ]}
          onChange={setFilter}
        />
      </div>
      {summaries.length === 0 ? (
        <div className="history-empty">
          <Icon icon={HistoryIcon} size="lg" />
          <p>No runs yet. Start one from the Live tab.</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="history-empty">
          <p>No {filter} runs in this project.</p>
        </div>
      ) : (
        <div className="history-scroll">
          <table className="history-table" aria-label="Runs of this project">
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Status</th>
                <th scope="col" className="col-prompt">
                  Prompt
                </th>
                <th scope="col" className="col-kind">
                  Kind
                </th>
                <th scope="col" className="col-started">
                  Started
                </th>
                <th scope="col" className="col-cost">
                  Cost
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <HistoryRow
                  key={r.id}
                  r={r}
                  index={indexes.get(r.id)}
                  waiting={!!runs[r.id] && needsYou(runs[r.id])}
                  viewed={current?.summary.id === r.id}
                  summaries={summaries}
                  cost={costLabel(r.totalCostUsd, authMode)}
                  indexes={indexes}
                  onOpen={() => void openRun(r.id)}
                  onContinue={() => void continueFromHistory(r.id)}
                  onRetro={() => void startRetro(r.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function HistoryRow({
  r,
  index,
  waiting,
  viewed,
  summaries,
  cost,
  indexes,
  onOpen,
  onContinue,
  onRetro
}: {
  r: RunSummary
  index: number | undefined
  waiting: boolean
  viewed: boolean
  summaries: RunSummary[]
  cost: { text: string; title: string }
  indexes: Map<string, number>
  onOpen: () => void
  onContinue: () => void
  onRetro: () => void
}): ReactElement {
  const status = runStatus(r.status, { waiting, endedWithApp: !!r.endedWithApp })
  const successor = continuedBy(summaries, r.id)
  const predecessor = predecessorOf(summaries, r.id)
  const chainLength = chainOf(summaries, r.id).length
  const started = new Date(r.startedAt)
  const open = isOpenStatus(r.status)
  return (
    <tr className={`run-row ${viewed ? 'active' : ''}`}>
      <td>
        <span className="run-index">{runTag(index)}</span>
      </td>
      <td>
        <span className={`pill run-status ${status.tone}`} title={r.pauseReason ?? status.note}>
          <span className="dot" aria-hidden="true" /> {status.word}
        </span>
      </td>
      <td className="col-prompt">
        <div className="prompt" title={promptLine(r.prompt)}>
          {promptLine(r.prompt)}
        </div>
        {(predecessor || r.resumedFrom || successor || chainLength > 1) && (
          <div className="run-chain">
            {r.resumedFrom && (
              <>
                Continues{' '}
                {predecessor ? (
                  <button type="button" className="link-btn" onClick={() => void useAppStore.getState().openRun(predecessor.id)} title={promptLine(predecessor.prompt)}>
                    {runTag(indexes.get(predecessor.id))}: {shortPrompt(predecessor.prompt, 32)}
                  </button>
                ) : (
                  'an earlier run'
                )}
              </>
            )}
            {r.resumedFrom && successor && ' · '}
            {successor && (
              <>
                Continued by{' '}
                <button type="button" className="link-btn" onClick={() => void useAppStore.getState().openRun(successor.id)} title={promptLine(successor.prompt)}>
                  {runTag(indexes.get(successor.id))}: {shortPrompt(successor.prompt, 32)}
                </button>
              </>
            )}
          </div>
        )}
      </td>
      <td className="col-kind">
        <span className={`chip ${r.kind === 'setup' ? 'setup' : ''}`}>{r.kind}</span>
      </td>
      <td className="col-started" title={started.toLocaleString()}>
        {relativeTime(r.startedAt)}
      </td>
      <td className="col-cost" title={cost.title}>
        {cost.text}
      </td>
      <td>
        <div className="run-row-actions">
          <Button size="sm" className="run-open" onClick={onOpen} title={viewed ? 'You are viewing this run' : open ? 'Open this live run' : 'Open this run'}>
            {viewed ? 'Viewing' : 'Open'}
          </Button>
          {canContinue(summaries, r.id) && (
            <Button size="sm" className="run-continue" title="Open this run and continue its session with its memory" onClick={onContinue}>
              Continue
            </Button>
          )}
          {r.kind === 'work' && (r.status === 'finished' || r.status === 'error') && (
            <Button size="sm" className="run-retro" title="Have the Architect review this run and revise the org chart where roles struggled" onClick={onRetro}>
              Retrospective
            </Button>
          )}
        </div>
      </td>
    </tr>
  )
}
