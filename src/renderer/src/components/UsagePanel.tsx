import type { ReactElement } from 'react'
import { useMemo } from 'react'
import { ArrowLeft, ArrowUpRight, Info } from 'lucide-react'
import type { AgentInstance, KnowledgeServedUsage, RunUsage } from '@shared/types'
import { knowledgeUsageRows } from '../lib/runKnowledge'
import '../styles/knowledge-run.css'
import { totalTokens } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'
import { formatTokens, sumCosts, unpricedModels, type CostInput } from '../lib/cost'
import { requestModelPrice } from '../lib/settingsTarget'
import { agentRow, agentRows, agentSignals, formatHitRate, roleRows, runSignals, skillLoadsFromTranscript, skillRows, timeRows, tokenRows, type AgentRow } from '../lib/usageView'
import { connectionLabel } from '../lib/connectionLabel'
import { noResultAgentsLine } from '../lib/usageEfficiency'
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

/** Where an unknown or partial cost can be fixed: names each unpriced model and opens its price form. */
function UnpricedNote({ models, partial }: { models: CostInput['models']; partial: boolean }): ReactElement | null {
  const setView = useAppStore((s) => s.setView)
  const ids = unpricedModels(models)
  if (ids.length === 0) return null
  return (
    <div className="usage-unpriced" data-testid="usage-unpriced">
      <p>{partial ? 'The cost is a minimum: no price is known for' : 'Cost unknown: no price is known for'}:</p>
      <ul>
        {ids.slice(0, 4).map((id) => (
          <li key={id}>
            <code className="mono" title={id}>{id}</code>
            <button
              type="button"
              className="link-btn"
              data-testid="usage-set-price"
              onClick={() => {
                requestModelPrice(id)
                setView('appSettings')
              }}
            >
              Set a price
            </button>
          </li>
        ))}
      </ul>
      {ids.length > 4 && <p className="muted">and {ids.length - 4} more.</p>}
    </div>
  )
}

/** Cost, tokens, time and cache hit up front; every other number folds into "More numbers". */
function Totals({ row, run, part }: { row?: AgentRow; run?: RunUsage; part: 'summary' | 'more' }): ReactElement {
  const tokens = row ? row.tokens : run!.tokens
  const cost: CostInput = row ? row.cost : run!
  const turns = row ? row.turns : run!.turns
  const toolCalls = row ? row.toolCalls : run!.toolCalls
  const retries = row ? row.retries : run!.retries
  const times = run ? timeRows(run) : []
  const wall = times.find((t) => t.id === 'wall')
  if (part === 'summary')
    return (
      <dl className="usage-grid" data-testid="usage-totals">
        <Stat label="Cost" testId="usage-stat-cost">
          <Cost value={cost} />
        </Stat>
        <Stat label="Tokens">{formatTokens(totalTokens(tokens))}</Stat>
        {wall ? <Stat label={wall.label}>{wall.text}</Stat> : <Stat label="Turns">{turns}</Stat>}
        <Stat label="Cache hit">
          <span title="Share of prompt tokens served from the cache">{formatHitRate(tokens)}</span>
        </Stat>
      </dl>
    )
  return (
    <>
      <details className="usage-more" data-testid="usage-more">
        <summary>More numbers</summary>
        <dl className="usage-list">
          {tokenRows(tokens).map((t) => (
            <Stat key={t.kind} label={t.label} testId={`usage-tokens-${t.kind}`}>
              <span title={`${t.value.toLocaleString()} tokens`}>{t.text}</span>
            </Stat>
          ))}
          {wall && <Stat label="Turns">{turns}</Stat>}
          <Stat label="Tool calls">{toolCalls}</Stat>
          <Stat label="Retries">{retries}</Stat>
          {run && <Stat label="Auto-continues">{run.nudges}</Stat>}
          {times.filter((t) => t !== wall).map((t) => <Stat key={t.id} label={t.label}>{t.text}</Stat>)}
        </dl>
      </details>
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
            <th scope="row" title={r.sub ? `${r.label} (${r.sub})` : r.label}>
              <button type="button" className="usage-link" onClick={() => onSelect(r.id)} title={`${r.sub ? `${r.label} (${r.sub})` : r.label}${r.producedNothing ? ': ended without a result' : ''}`} aria-current={r.id === selectedId ? 'true' : undefined}>
                {r.label}
              </button>
              {r.sub && <span className="usage-sub">{r.sub}</span>}
              {r.producedNothing && (
                <span className="usage-nr-tag" data-testid="usage-no-result-tag">
                  No result
                </span>
              )}
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

function SkillsLoaded({ rows }: { rows: ReturnType<typeof skillRows> }): ReactElement | null {
  if (rows.length === 0) return null
  return (
    <table className="usage-table" data-testid="usage-skills">
      <caption>Skills loaded</caption>
      <thead>
        <tr>
          <th scope="col">Skill</th>
          <th scope="col" className="num">Loads</th>
          <th scope="col" className="num opt">By</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.skillId} data-testid="usage-skill">
            <th scope="row" title={r.name}>{r.name}</th>
            <td className="num">{r.loadsText}</td>
            <td className="num opt">
              {r.agentsText || r.roles}
              {r.agentsText && r.roles && <span className="usage-sub">{r.roles}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Section 3.5: what the knowledge graph gave agents in this run. Counts only; it never claims a saving. */
function KnowledgeServed({ usage }: { usage: KnowledgeServedUsage }): ReactElement {
  return (
    <>
      <h3 className="usage-knowledge-head" id="usage-knowledge-head">
        Knowledge
      </h3>
      <dl className="usage-list" data-testid="usage-knowledge" aria-labelledby="usage-knowledge-head">
        {knowledgeUsageRows(usage).map((r) => (
          <Stat key={r.id} label={r.label} testId={`usage-knowledge-${r.id}`}>
            {r.text}
          </Stat>
        ))}
      </dl>
    </>
  )
}

function RoleTable({ run, rows: agentRowsList }: { run: RunUsage; rows: AgentRow[] }): ReactElement | null {
  const rows = roleRows(run, agentRowsList)
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

/** "By connection": shown only when agents ran on two or more connections. An unknown cost is never $0. */
function ConnectionTable({ run }: { run: RunUsage }): ReactElement | null {
  const rows = Object.entries(run.connections ?? {}).filter((e): e is [string, { costUsd: number | null; agents: number }] => !!e[1])
  if (rows.length < 2) return null
  return (
    <table className="usage-table" data-testid="usage-connections">
      <caption>By connection</caption>
      <thead>
        <tr>
          <th scope="col">Connection</th>
          <th scope="col" className="num">Agents</th>
          <th scope="col" className="num">Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([id, v]) => (
          <tr key={id} data-testid="usage-connection" data-connection={id}>
            <th scope="row">{connectionLabel(id)}</th>
            <td className="num">{v.agents}</td>
            <td className="num">
              <Cost value={{ costUsd: v.costUsd, costSource: v.costUsd === null ? 'unknown' : 'computed', sourceMixed: true }} />
            </td>
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
  const projectId = useAppStore((s) => s.runs[runId]?.summary.projectId)
  const openUsage = useAppStore((s) => s.openUsage)
  const transcript = useAppStore((s) => s.runs[runId]?.transcript)
  const rows = useMemo(() => (agents ? agentRows(agents) : []), [agents])
  // The root is selected by default, so it shows the whole run; any other agent scopes the tab to itself.
  const scoped = agent && agent.id !== 'root' && agent.parentId ? agent : undefined
  const scopedRow = scoped ? agentRow(scoped) : undefined
  const noResultLine = useMemo(() => noResultAgentsLine(rows.filter((r) => r.producedNothing).map((r) => r.label)), [rows])
  const skills = useMemo(() => {
    if (!usage) return []
    const seen = skillLoadsFromTranscript(transcript ?? [], scoped?.id)
    return skillRows(usage, seen, !!scoped)
  }, [usage, transcript, scoped])

  if (!usage && rows.length === 0) {
    return (
      <div className="run-usage-panel" data-testid="usage-panel">
        <p className="panel-note" data-testid="usage-empty">
          No usage recorded for this run yet.
        </p>
      </div>
    )
  }

  const legacy = usage?.legacy === true
  const fallbackCost = sumCosts(rows.map((r) => r.cost))

  return (
    <div className="run-usage-panel" data-testid="usage-panel">
      {projectId && (
        <p className="usage-all-link">
          <button type="button" className="link-btn" data-testid="run-usage-all" onClick={() => openUsage({ projectIds: [projectId] })}>
            All usage
            <Icon icon={ArrowUpRight} size="xs" />
          </button>
        </p>
      )}
      {scoped && scopedRow ? (
        <>
          <div className="usage-scope" data-testid="usage-scope">
            <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={() => selectAgent('root')} testId="usage-whole-run">
              Whole run
            </Button>
            <span className="usage-scope-name" title={scoped.name}>
              {scopedRow.label}
            </span>
          </div>
          {scopedRow.approximate && <p className="panel-note" data-testid="usage-legacy">{LEGACY_NOTE}</p>}
          <Totals row={scopedRow} part="summary" />
          <Signals lines={agentSignals(scopedRow)} />
          <UnpricedNote models={scopedRow.cost.models} partial={scopedRow.cost.costUsd !== null} />
        </>
      ) : usage ? (
        <>
          {legacy && <p className="panel-note" data-testid="usage-legacy">{LEGACY_NOTE}</p>}
          <Totals run={usage} part="summary" />
          <Signals lines={runSignals(usage, rows)} />
          <UnpricedNote models={usage.models} partial={usage.costUsd !== null} />
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
      {!scoped && noResultLine && (
        <p className="panel-note" data-testid="usage-no-result-line">
          {noResultLine}.
        </p>
      )}
      {rows.length > 0 && <AgentTable rows={rows} selectedId={scoped?.id} onSelect={selectAgent} />}
      <SkillsLoaded rows={skills} />
      {usage?.knowledge && !scoped && <KnowledgeServed usage={usage.knowledge} />}
      {usage && !scoped && <RoleTable run={usage} rows={rows} />}
      {usage && !scoped && <ConnectionTable run={usage} />}
      {scoped && scopedRow ? <Totals row={scopedRow} part="more" /> : usage ? <Totals run={usage} part="more" /> : null}
    </div>
  )
}
