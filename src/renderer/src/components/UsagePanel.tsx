import type { ReactElement } from 'react'
import { useMemo } from 'react'
import { ArrowLeft, Info } from 'lucide-react'
import type { AgentInstance, RunUsage } from '@shared/types'
import { totalTokens } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'
import { formatTokens, sumCosts, type CostInput } from '../lib/cost'
import { agentRow, agentRows, agentSignals, formatHitRate, roleRows, runSignals, timeRows, tokenRows, type AgentRow } from '../lib/usageView'
import { Cost } from './ui/Cost'
import { Icon } from './ui/Icon'
import { Button } from './ui/Button'

const LEGACY_NOTE = 'Recorded before usage tracking, so these numbers are approximate.'

function Stat({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }): ReactElement {
  return (
    <div className="usage-stat" data-testid={testId}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function Signals({ lines }: { lines: string[] }): ReactElement | null {
  if (lines.length === 0) return null
  return (
    <ul className="usage-signals" data-testid="usage-signals" aria-label="Efficiency notes">
      {lines.map((l) => (
        <li key={l}>
          <Icon icon={Info} size="sm" />
          <span>{l}</span>
        </li>
      ))}
    </ul>
  )
}

/** Token, cost and activity totals for either a run or one agent. */
function Totals({ row, run }: { row?: AgentRow; run?: RunUsage }): ReactElement {
  const tokens = row ? row.tokens : run!.tokens
  const cost: CostInput = row ? row.cost : run!
  const turns = row ? row.turns : run!.turns
  const toolCalls = row ? row.toolCalls : run!.toolCalls
  const retries = row ? row.retries : run!.retries
  return (
    <>
      <dl className="usage-grid" data-testid="usage-totals">
        <Stat label="Cost">
          <Cost value={cost} />
        </Stat>
        <Stat label="Tokens">{formatTokens(totalTokens(tokens))}</Stat>
        {tokenRows(tokens).map((t) => (
          <Stat key={t.kind} label={t.label} testId={`usage-tokens-${t.kind}`}>
            <span title={`${t.value.toLocaleString()} tokens`}>{t.text}</span>
          </Stat>
        ))}
        <Stat label="Cache hit rate">
          <span title="Share of prompt tokens served from the cache">{formatHitRate(tokens)}</span>
        </Stat>
        <Stat label="Turns">{turns}</Stat>
        <Stat label="Tool calls">{toolCalls}</Stat>
        <Stat label="Retries">{retries}</Stat>
        {run && <Stat label="Auto-continues">{run.nudges}</Stat>}
        {run && timeRows(run).map((t) => <Stat key={t.id} label={t.label}>{t.text}</Stat>)}
      </dl>
    </>
  )
}

function AgentTable({ rows, selectedId, onSelect }: { rows: AgentRow[]; selectedId?: string; onSelect: (id: string) => void }): ReactElement {
  return (
    <table className="usage-table" data-testid="usage-agents">
      <caption>By agent</caption>
      <thead>
        <tr>
          <th scope="col">Agent</th>
          <th scope="col" className="num">Tokens</th>
          <th scope="col" className="num">Cost</th>
          <th scope="col" className="num opt">Turns</th>
          <th scope="col" className="num opt">Tools</th>
          <th scope="col" className="num opt">Retries</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className={`${r.producedNothing ? 'dim' : ''}${r.id === selectedId ? ' current' : ''}`} data-testid="usage-agent-row" data-agent-id={r.id} data-dim={r.producedNothing || undefined}>
            <th scope="row">
              <button type="button" className="usage-link" onClick={() => onSelect(r.id)} title={r.producedNothing ? `${r.name}: ended without a result` : `Show ${r.name}`}>
                {r.name}
              </button>
              <span className="usage-sub">{r.roleSlug}</span>
            </th>
            <td className="num" title={r.approximate ? LEGACY_NOTE : undefined}>
              {r.approximate ? '~' : ''}
              {formatTokens(r.total)}
            </td>
            <td className="num">
              <Cost value={r.cost} />
            </td>
            <td className="num opt">{r.turns}</td>
            <td className="num opt">{r.toolCalls}</td>
            <td className="num opt">{r.retries}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function RoleTable({ run }: { run: RunUsage }): ReactElement | null {
  const rows = roleRows(run)
  if (rows.length === 0) return null
  return (
    <table className="usage-table" data-testid="usage-roles">
      <caption>By role</caption>
      <thead>
        <tr>
          <th scope="col">Role</th>
          <th scope="col" className="num">Tokens</th>
          <th scope="col" className="num">Cost</th>
          <th scope="col" className="num opt">Agents</th>
          <th scope="col" className="num opt">Turns</th>
          <th scope="col" className="num opt">Tools</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className={r.dim ? 'dim' : ''} data-testid="usage-role-row" data-dim={r.dim || undefined}>
            <th scope="row">{r.name}</th>
            <td className="num">{formatTokens(r.total)}</td>
            <td className="num">
              <Cost value={r.role} />
            </td>
            <td className="num opt">{r.agents}</td>
            <td className="num opt">{r.role.turns}</td>
            <td className="num opt">{r.role.toolCalls}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default function UsagePanel({ runId, agent }: { runId: string; agent: AgentInstance | undefined }): ReactElement {
  const usage = useAppStore((s) => s.runs[runId]?.summary.usage)
  const agents = useAppStore((s) => s.runs[runId]?.agents)
  const selectAgent = useAppStore((s) => s.selectAgent)
  const rows = useMemo(() => (agents ? agentRows(agents) : []), [agents])
  // The root is selected by default, so it shows the whole run; any other agent scopes the tab to itself.
  const scoped = agent && agent.id !== 'root' && agent.parentId ? agent : undefined
  const scopedRow = scoped ? agentRow(scoped) : undefined

  if (!usage && rows.length === 0) {
    return (
      <div className="usage-panel" data-testid="usage-panel">
        <p className="panel-note" data-testid="usage-empty">
          No usage recorded for this run yet.
        </p>
      </div>
    )
  }

  const legacy = usage?.legacy === true
  const fallbackCost = sumCosts(rows.map((r) => r.cost))

  return (
    <div className="usage-panel" data-testid="usage-panel">
      {scoped && scopedRow ? (
        <>
          <div className="usage-scope" data-testid="usage-scope">
            <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={() => selectAgent('root')} testId="usage-whole-run">
              Whole run
            </Button>
            <span className="usage-scope-name" title={scoped.name}>
              {scoped.name}
            </span>
          </div>
          {scopedRow.approximate && <p className="panel-note" data-testid="usage-legacy">{LEGACY_NOTE}</p>}
          <Totals row={scopedRow} />
          <Signals lines={agentSignals(scopedRow)} />
        </>
      ) : usage ? (
        <>
          {legacy && <p className="panel-note" data-testid="usage-legacy">{LEGACY_NOTE}</p>}
          <Totals run={usage} />
          <Signals lines={runSignals(usage)} />
        </>
      ) : (
        <>
          <p className="panel-note" data-testid="usage-legacy">
            Run totals are not available for this run. The agents below are approximate.
          </p>
          <dl className="usage-grid">
            <Stat label="Cost">
              <Cost value={fallbackCost} />
            </Stat>
          </dl>
        </>
      )}
      {rows.length > 0 && <AgentTable rows={rows} selectedId={scoped?.id} onSelect={selectAgent} />}
      {usage && !scoped && <RoleTable run={usage} />}
    </div>
  )
}
