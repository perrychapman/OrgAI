import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { PriceSource, UsageOverviewModel } from '@shared/types'
import { modelFamily } from '@shared/defaults'
import { formatTokens } from '../../lib/cost'
import { connectionLabel } from '../../lib/connectionLabel'
import { FAMILY_WORD } from '../../lib/modelFamily'
import { requestModelPrice } from '../../lib/settingsTarget'
import { useAppStore } from '../../store/useAppStore'
import { barFraction, clipMiddle, rankByCost, rollupCost, sharePercent, tokenSum } from '../../lib/usageCharts'
import type { UsagePanelProps } from './panelProps'
import { ChartTable } from './ChartTable'
import { CostText, RANK_TOP, RankedBars, type RankedItem } from './RankedBars'
import '../../styles/usage-charts.css'

const PRICE_WORD: Record<PriceSource, string> = {
  override: 'Your price',
  proxy: 'Proxy',
  builtin: 'Built in',
  community: 'Community',
  provider: 'Reported by provider',
  unknown: 'None'
}

const unpriced = (m: UsageOverviewModel): boolean => m.costUsd === null || m.priceSource === 'unknown'

export default function ModelsPanel({ data, filters, onNarrow, announce, embedded }: UsagePanelProps & { embedded?: boolean }): ReactElement {
  const limit = RANK_TOP
  const [showAll, setShowAll] = useState(false)
  const setView = useAppStore((s) => s.setView)

  // Which connections each model ran on, read from the rows (the rollup has none).
  const conns = useMemo(() => {
    const out = new Map<string, Set<string>>()
    for (const row of data.rows) {
      if (!row.connection) continue
      for (const m of row.usage.models) {
        let set = out.get(m.model)
        if (!set) out.set(m.model, (set = new Set()))
        set.add(row.connection)
      }
    }
    return out
  }, [data.rows])
  const connText = (model: string): string => [...(conns.get(model) ?? [])].map((c) => connectionLabel(c)).join(', ')

  const ranked = useMemo(() => rankByCost(data.models, (m) => ({ costUsd: m.costUsd, tokens: tokenSum(m.tokens) })), [data.models])
  const shown = showAll ? ranked : ranked.slice(0, limit)
  const maxCost = ranked.reduce((n, m) => Math.max(n, m.costUsd ?? 0), 0)
  const totalTokens = ranked.reduce((n, m) => n + tokenSum(m.tokens), 0)

  const setPrice = (model: string): void => {
    requestModelPrice(model)
    setView('appSettings')
  }

  const items: RankedItem[] = shown.map((m) => {
    const tokens = tokenSum(m.tokens)
    const conn = connText(m.model)
    const missing = unpriced(m)
    return {
      id: m.model,
      data: { model: m.model },
      name: m.model,
      shown: clipMiddle(m.model, 30),
      sub: (
        <>
          <span className="uc-family">{FAMILY_WORD[modelFamily(m.model)]}</span>
          {conn ? <span className="uc-conn">{conn}</span> : null}
        </>
      ),
      fraction: m.costUsd === null ? 0 : barFraction(m.costUsd, maxCost),
      state: m.costUsd === null ? 'unknown' : m.costUnknownRuns > 0 ? 'partial' : 'known',
      fill: 'var(--chart-other)',
      cost: rollupCost(m),
      detail: `${formatTokens(tokens)} tokens · ${sharePercent(tokens, totalTokens)}%`,
      selected: filters.model === m.model,
      extra: missing ? (
        <span className="uc-unpriced">
          No price known.{' '}
          <button type="button" className="link-btn" data-testid="usage-set-price" onClick={() => setPrice(m.model)}>
            Set a price
          </button>
        </span>
      ) : undefined
    }
  })

  const top = [...data.models].sort((a, b) => tokenSum(b.tokens) - tokenSum(a.tokens))[0]
  const missingCount = data.models.filter(unpriced).length
  const summary = (() => {
    if (!top) return 'No models were used in this period.'
    const lead = `${top.model} carries ${sharePercent(tokenSum(top.tokens), totalTokens)}% of the tokens.`
    return missingCount > 0 ? `${lead} ${missingCount} ${missingCount === 1 ? 'model has' : 'models have'} no known price.` : lead
  })()

  const rows = ranked.map((m) => ({
    key: m.model,
    data: { model: m.model },
    cells: [
      m.model,
      connText(m.model) || '—',
      m.runs,
      formatTokens(tokenSum(m.tokens)),
      `${sharePercent(tokenSum(m.tokens), totalTokens)}%`,
      <CostText key="c" value={rollupCost(m)} />,
      PRICE_WORD[m.priceSource]
    ],
    sort: [m.model, connText(m.model) || null, m.runs, tokenSum(m.tokens), tokenSum(m.tokens), m.costUsd, PRICE_WORD[m.priceSource]]
  }))

  const Root = embedded ? 'div' : 'section'
  return (
    <Root className={embedded ? 'usage-panel-embedded' : 'usage-panel'} {...(embedded ? {} : { 'aria-labelledby': 'usage-models-h' })} data-testid="usage-models">
      {embedded ? (
        <p className="usage-panel-summary">{summary}</p>
      ) : (
        <div className="usage-panel-head">
          <h2 id="usage-models-h" tabIndex={-1}>
            By model
          </h2>
          <p className="usage-panel-summary">{summary}</p>
        </div>
      )}
      {items.length > 0 ? (
        <RankedBars label="Models by estimated cost" items={items} rowTestId="usage-model-row" onActivate={(it) => onNarrow({ model: it.id })} />
      ) : (
        <p className="uc-empty">No runs in this period.</p>
      )}
      {ranked.length > limit && (
        <button type="button" className="link-btn uc-more" data-testid="usage-models-more" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show all ${ranked.length}`}
        </button>
      )}
      <ChartTable
        testId="usage-models-table"
        caption="Usage by model"
        columns={[
          { key: 'model', label: 'Model' },
          { key: 'conn', label: 'Connection', optional: true },
          { key: 'runs', label: 'Runs', numeric: true },
          { key: 'tokens', label: 'Tokens', numeric: true, optional: true },
          { key: 'share', label: 'Share of tokens', numeric: true, optional: true },
          { key: 'cost', label: 'Cost', numeric: true },
          { key: 'price', label: 'Price source', optional: true }
        ]}
        rows={rows}
        empty="No runs in this period."
        announce={announce}
      />
    </Root>
  )
}
