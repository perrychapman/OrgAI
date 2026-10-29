import type { ReactElement } from 'react'
import { useId, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Search, SearchX } from 'lucide-react'
import type { ConnectionId, ModelFamily, ModelRef, ModelTier, ProviderModel } from '@shared/types'
import { MODEL_TIER_OPTIONS } from '@shared/types'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { FAMILY_LABEL, formatContext, groupByFamily } from '../../lib/remap'

type Filter = 'all' | ModelFamily

/** Searchable, family-grouped catalog of one connection (informational rows). */
export default function ModelList({
  id,
  models,
  error,
  onRetry,
  tierModels
}: {
  id: ConnectionId
  models: ProviderModel[] | undefined
  error: string | undefined
  onRetry: () => void
  tierModels: Partial<Record<ModelTier, ModelRef>>
}): ReactElement {
  const [open, setOpen] = useState(() => window.innerHeight >= 700)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const listId = useId()
  const tierOf = (m: string): string | undefined => {
    const t = (Object.keys(tierModels) as ModelTier[]).find((k) => tierModels[k] === m)
    return t ? MODEL_TIER_OPTIONS.find((o) => o.value === t)?.label : undefined
  }
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: models?.length ?? 0, claude: 0, openai: 0, other: 0 }
    for (const m of models ?? []) c[m.family]++
    return c
  }, [models])
  const filtered = useMemo(
    () =>
      (models ?? []).filter(
        (m) => (filter === 'all' || m.family === filter) && (m.id + ' ' + m.label).toLowerCase().includes(query.trim().toLowerCase())
      ),
    [models, filter, query]
  )
  const groups = groupByFamily(filtered)

  return (
    <div className="model-list" data-provider={id}>
      <button type="button" className="group-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
        <Icon icon={open ? ChevronDown : ChevronRight} size="sm" />
        <strong>Models</strong>
        <span className="muted tabular">({models?.length ?? '…'})</span>
      </button>
      {open && (
        <div id={listId} className="model-body">
          {error ? (
            <Banner tone="danger" title="Could not load models" actions={<Button size="sm" onClick={onRetry}>Retry</Button>}>
              {error}
            </Banner>
          ) : !models ? (
            <div aria-busy="true" className="model-skel">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="skeleton" />
              ))}
            </div>
          ) : models.length === 0 ? (
            <Banner tone="warning" title="This connection returned no models" actions={<Button size="sm" onClick={onRetry}>Refresh</Button>} />
          ) : (
            <>
              <div className="model-tools">
                <div className="search-field">
                  <Icon icon={Search} size="sm" />
                  <input
                    type="search"
                    className="input"
                    aria-label="Search models"
                    placeholder="Search models"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setQuery('')
                    }}
                  />
                </div>
                <div className="seg" role="radiogroup" aria-label="Filter models by family">
                  {(['all', 'claude', 'openai', 'other'] as Filter[]).map((f) => (
                    <label key={f} className={`seg-item ${filter === f ? 'on' : ''}`}>
                      <input type="radio" name={`${listId}-f`} checked={filter === f} onChange={() => setFilter(f)} />
                      {f === 'all' ? 'All' : FAMILY_LABEL[f]} <span className="tabular">{counts[f]}</span>
                    </label>
                  ))}
                </div>
              </div>
              {filtered.length === 0 ? (
                <div className="empty-inline">
                  <Icon icon={SearchX} size="lg" />
                  <span>No models match “{query}”</span>
                  <Button size="sm" variant="ghost" onClick={() => { setQuery(''); setFilter('all') }}>
                    Clear search
                  </Button>
                </div>
              ) : (
                <div className="model-scroll" role="list" aria-label="Models" tabIndex={0}>
                  {groups.map((g) => (
                    <div key={g.family} role="listitem" className="model-group">
                      <div className="model-group-title">
                        <strong>{FAMILY_LABEL[g.family]}</strong> <span className="muted tabular">{g.models.length}</span>
                      </div>
                      <ul>
                        {g.models.map((m) => (
                          <li key={m.id} className="model-row">
                            <span className="mono model-id">{m.id}</span>
                            <span className="muted model-label">{m.label !== m.id ? m.label : ''}</span>
                            {formatContext(m.contextWindow) && <Badge>context {formatContext(m.contextWindow)}</Badge>}
                            {tierOf(m.id) && <Badge tone="accent">{tierOf(m.id)}</Badge>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
