import type { ReactElement } from 'react'
import { useEffect, useId, useMemo } from 'react'
import type { ConnectionId, UsageStatus } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { locationLabel } from '../../lib/assistants'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'
import { CONNECTION_LABEL, connectionsInUse, periodText, periodsCaption, spendSentence, spendText } from '../../lib/usage'
import { Cost } from '../ui/Cost'
import { ConnectionStatusBadge } from '../ui/ConnectionStatusBadge'
import { SpendBar, tightestWindow, UsageBar } from '../UsageMeter'
import { connectionProblems, costInWindow, mergeSummaries, topProjectCosts, usageIsStale, windowLabel } from './dashboardProjects'

const ORDER: ConnectionId[] = ['anthropic', 'openai', 'litellm']

/** One usage refresh at a time across mounts. */
let refreshing = false

function UsageCard(): ReactElement {
  const headingId = useId()
  const byConnection = useAppStore((s) => s.usageByConnection)
  const connections = useAppStore((s) => s.connections)
  const defaultConnection = useAppStore((s) => s.defaultConnection)
  const projects = useAppStore((s) => s.projects)
  const inUse = useMemo(() => connectionsInUse(connections, defaultConnection, projects), [connections, defaultConnection, projects])
  const ids = ORDER.filter((id) => inUse.has(id))

  // Mount only: ask for a fresh reading when the newest one is older than a minute. No timer while the page is open.
  useEffect(() => {
    const state = useAppStore.getState()
    if (refreshing || !usageIsStale(Object.values(state.usageByConnection) as UsageStatus[], Date.now())) return
    refreshing = true
    void state.refreshUsage().finally(() => {
      refreshing = false
    })
  }, [])

  return (
    <section className="dash-fact card-fact" data-testid="dash-usage" aria-labelledby={headingId}>
      <h2 id={headingId}>Usage</h2>
      {ids.length === 0 && <p className="dash-fact-note">No connections in use.</p>}
      <ul className="dash-fact-list">
        {ids.map((id) => {
          const usage = byConnection[id]
          const tight = id === 'litellm' ? null : tightestWindow(usage)
          const spend = id === 'litellm' && usage?.available ? usage.spend : undefined
          // LiteLLM: the same one figure as the account row (today's spend when periods are reported, else the budget
          // text), the budget bar, then this week and this month as a caption; the whole sentence in the tooltip.
          const caption = spend ? periodsCaption(spend) : ''
          return (
            <li key={id} className="dash-usage-row" data-testid="dash-usage-row" data-connection={id} title={spend ? spendSentence(spend) : undefined}>
              <span className="dash-usage-name">{CONNECTION_LABEL[id]}</span>
              {id === 'litellm' ? (
                spend ? (
                  <>
                    <span className="dash-fact-line mono">{spend.periods ? periodText(spend.periods.day.usd, 'day') : spendText(spend)}</span>
                    <SpendBar spend={spend} />
                    {caption && (
                      <span className="dash-fact-line" data-testid="dash-usage-periods">
                        {caption}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="dash-fact-line">No spend reported yet.</span>
                )
              ) : usage?.authMode === 'apiKey' ? (
                <span className="dash-fact-line">Billed per token. No plan windows.</span>
              ) : tight ? (
                <>
                  <span className="dash-fact-line">
                    {windowLabel(tight.label)} · <span className="mono">{Math.round(tight.pct)}%</span>
                  </span>
                  <UsageBar usage={usage} />
                </>
              ) : (
                <span className="dash-fact-line">No usage reported yet.</span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function CostCard(): ReactElement {
  const headingId = useId()
  const runs = useAppStore((s) => s.runs)
  const history = useAppStore((s) => s.historyByProject)
  const projects = useAppStore((s) => s.projects)
  const now = Date.now()
  const summaries = useMemo(() => mergeSummaries(Object.values(runs).map((r) => r.summary), Object.values(history)), [runs, history])
  const total = costInWindow(summaries, now)
  const top = topProjectCosts(summaries, now, (id) => locationLabel(id, projects))
  return (
    <section className="dash-fact card-fact" data-testid="dash-cost" aria-labelledby={headingId}>
      <h2 id={headingId}>Cost, last 7 days</h2>
      {total.runs === 0 ? (
        <p className="dash-fact-note">No runs in the last 7 days.</p>
      ) : (
        <>
          <p className="dash-cost-figure">
            <Cost value={total.cost} />
          </p>
          {top.length > 0 && (
            <ul className="dash-fact-list dash-cost-top" aria-label="Top projects by cost">
              {top.map((row) => (
                <li key={row.projectId} className="dash-cost-row">
                  <span className="dash-cost-name">{row.name}</span>
                  <Cost value={row.cost} className="mono" />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <p className="dash-fact-foot">From the runs OrgAI keeps.</p>
    </section>
  )
}

function ConnectionsCard(): ReactElement {
  const headingId = useId()
  const connections = useAppStore((s) => s.connections)
  const defaultConnection = useAppStore((s) => s.defaultConnection)
  const projects = useAppStore((s) => s.projects)
  const setView = useAppStore((s) => s.setView)
  const inUse = useMemo(() => connectionsInUse(connections, defaultConnection, projects), [connections, defaultConnection, projects])
  const problems = useMemo(() => connectionProblems(connections, inUse, projects), [connections, inUse, projects])

  useEffect(() => {
    if (useAppStore.getState().defaultConnection === null) void useAppStore.getState().loadDefaultConnection()
  }, [])

  const def = connections?.find((c) => c.connection.id === defaultConnection)
  return (
    <section className="dash-fact card-fact" data-testid="dash-connections" aria-labelledby={headingId}>
      <h2 id={headingId}>Connections</h2>
      {connections === null || (defaultConnection !== null && !def) ? (
        <p className="dash-fact-note">
          Checking connections…
        </p>
      ) : (
        <>
          {defaultConnection && def && (
            <p className="dash-conn-default">
              <span>Default: {CONNECTION_LABEL[defaultConnection]}</span>
              <ConnectionStatusBadge state={def.status.state} />
            </p>
          )}
          {problems.length > 0 && (
            <ul className="dash-fact-list">
              {problems.map((p) => (
                <li key={p.id} className="dash-conn-problem" data-testid="dash-connection-problem" data-connection={p.id}>
                  {p.text}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <button
        type="button"
        className="link-btn dash-fact-link"
        data-testid="dash-connections-settings"
        onClick={() => {
          requestAppSettingsSection(APP_SETTINGS_SECTIONS.connections)
          setView('appSettings')
        }}
      >
        Connection settings
      </button>
    </section>
  )
}

/** The Dashboard's fact cards: plan usage, cost over the last 7 days and connection health. Read-only. */
export function FactsCards(): ReactElement {
  return (
    <div className="dash-facts">
      <div className="dash-facts-grid">
        <UsageCard />
        <CostCard />
        <ConnectionsCard />
      </div>
    </div>
  )
}
