import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Plus, Search } from 'lucide-react'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Input } from '../ui/Input'
import { SettingsSection } from '../settings/SettingsSection'
import { CATEGORY_GROUP_THRESHOLD, CATEGORY_LABELS, categoriesPresent, gallerySections, matchesFilter, serviceCount } from '../../lib/connectors'
import type { GalleryFilter } from '../../lib/connectors'
import { clearTeamOrigin, peekTeamOrigin, takeConnectorTarget, type TeamOrigin } from '../../lib/settingsTarget'
import { useAppStore } from '../../store/useAppStore'
import { ConnectorTile } from './ConnectorTile'
import ConnectorDialog from './ConnectorDialog'
import { useConnectors } from './useConnectors'
import { useRovingFocus } from './useRovingFocus'

/** Scroll to the Custom servers section below the gallery and put focus on its first button. */
function goToCustomServers(): void {
  const section = document.getElementById('appsettings-section-mcp-library')
  section?.scrollIntoView({ block: 'start' })
  section?.querySelector<HTMLElement>('[data-testid=mcp-library-add-manual]')?.focus()
}

/** App settings > Connectors: the curated services, connected ones first, easy sign-in next, then by category. */
export function ConnectorGallery(): ReactElement {
  const { connectors, error, refresh } = useConnectors()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<GalleryFilter>('all')
  const [easy, setEasy] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const sectionsRef = useRef<HTMLDivElement>(null)
  const chipsRef = useRef<HTMLDivElement>(null)
  const roving = useRovingFocus(sectionsRef, '[data-testid=connector-action]')
  const chipRoving = useRovingFocus(chipsRef, '[data-testid=connector-filter]')
  const sections = useMemo(() => (connectors ? gallerySections(connectors, { query, filter, easy }) : []), [connectors, query, filter, easy])
  const total = sections.reduce((n, s) => n + s.items.length, 0)
  const open = connectors?.find((c) => c.connector.id === openId)
  const categories = useMemo(() => (connectors && connectors.length > CATEGORY_GROUP_THRESHOLD ? categoriesPresent(connectors) : []), [connectors])
  const connectedCount = connectors?.filter((c) => c.state === 'connected').length ?? 0
  const chips: { id: GalleryFilter; label: string; count?: number }[] = [
    { id: 'all', label: 'All', count: connectors?.length },
    ...(connectedCount > 0 ? [{ id: 'connected' as const, label: 'Connected', count: connectedCount }] : []),
    { id: 'easy', label: 'Easy sign-in', count: connectors?.filter((c) => matchesFilter(c, 'easy')).length },
    ...categories.map((c) => ({ id: c.category as GalleryFilter, label: CATEGORY_LABELS[c.category], count: c.count }))
  ]

  const [pending, setPending] = useState<string | null>(() => takeConnectorTarget())
  const [announce, setAnnounce] = useState('')
  // "Back to Team" shows when the deep link started on the Team tab (openConnectorSetup remembers the project and role).
  const [origin, setOrigin] = useState<TeamOrigin | null>(() => peekTeamOrigin())
  const originOk = useAppStore((st) => !!origin && st.projects.some((p) => p.id === origin.projectId && (!origin.roleId || p.roles.some((r) => r.id === origin.roleId))))
  const backToTeam = (): void => {
    const o = peekTeamOrigin() ?? origin
    clearTeamOrigin()
    setOrigin(null)
    if (!o) return
    const st = useAppStore.getState()
    const project = st.projects.find((p) => p.id === o.projectId)
    if (!project) return
    const role = o.roleId ? project.roles.find((r) => r.id === o.roleId) : undefined
    if (st.selectedProjectId !== o.projectId) st.selectProject(o.projectId)
    st.setView('team')
    if (role) useAppStore.getState().selectRole(role.id)
    // Land on the row that sent the user away, else on the panel's selected tab.
    window.setTimeout(() => {
      const target =
        document.querySelector<HTMLElement>('[data-testid=role-signin]') ??
        document.querySelector<HTMLElement>('.team-panel-tabs [role=tab][aria-selected=true]')
      target?.focus()
    }, 120)
  }
  const highlightTimer = useRef<number | undefined>(undefined)

  // A deep link (requestConnector) may arrive before mount (key read above) or while mounted (event).
  useEffect(() => {
    const onEvent = (): void => {
      setOrigin(peekTeamOrigin())
      const id = takeConnectorTarget()
      if (id) setPending(id)
    }
    window.addEventListener('orgai:settings-section', onEvent)
    return () => {
      window.removeEventListener('orgai:settings-section', onEvent)
      window.clearTimeout(highlightTimer.current)
    }
  }, [])

  const reveal = useCallback((id: string): boolean => {
    const el = sectionsRef.current?.querySelector<HTMLElement>(`[data-testid=connector-tile][data-connector="${id}"]`)
    if (!el) return false
    const reduce = document.documentElement.getAttribute('data-reduce-motion') === 'on' || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
    el.querySelector<HTMLElement>('[data-testid=connector-action]')?.focus({ preventScroll: true })
    el.setAttribute('data-highlight', '')
    window.clearTimeout(highlightTimer.current)
    highlightTimer.current = window.setTimeout(() => el.removeAttribute('data-highlight'), 2000)
    return true
  }, [])

  useEffect(() => {
    if (!pending || !connectors) return
    const known = connectors.find((c) => c.connector.id === pending)
    if (!known) {
      setPending(null)
      return
    }
    // Clear anything that would hide the tile; the effect runs again once the grid has re-rendered.
    if (query || filter !== 'all' || easy) {
      setQuery('')
      setFilter('all')
      setEasy(false)
      return
    }
    if (reveal(pending)) {
      setAnnounce(`Showing ${known.connector.name}`)
      setPending(null)
    }
  }, [pending, connectors, query, filter, easy, reveal])

  return (
    <SettingsSection
      id="appsettings-section-connectors"
      title="Connectors"
      description="Connect the services your agents work with. Sign-in stays on this computer."
      testId="connectors-section"
    >
      <div className="connectors-body">
        {origin && originOk && (
          <div className="connectors-back">
            <Button variant="ghost" size="sm" icon={ArrowLeft} testId="back-to-team" onClick={backToTeam}>
              Back to Team
            </Button>
          </div>
        )}
        <p className="sr-only" role="status" aria-live="polite" data-testid="connector-announce">
          {announce}
        </p>
        {error && !connectors ? (
          <Banner
            tone="danger"
            title="Could not load the services"
            actions={
              <Button size="sm" onClick={refresh}>
                Retry
              </Button>
            }
          >
            {error}
          </Banner>
        ) : connectors === null ? (
          <ul className="connector-grid" aria-busy="true" aria-label="Loading services">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <li key={i} className="connector-tile">
                <div className="skeleton connector-sk" />
              </li>
            ))}
          </ul>
        ) : (
          <>
            <div className="connector-search">
              <span className="connector-search-icon">
                <Icon icon={Search} size="sm" />
              </span>
              <Input
                type="search"
                value={query}
                onChange={setQuery}
                placeholder="Search by name or what it does"
                aria-label="Search services"
                data-testid="connector-search"
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' && total > 0) {
                    e.preventDefault()
                    roving.focusCurrent()
                  }
                }}
              />
            </div>
            <div className="connector-filterbar">
              <div ref={chipsRef} className="connector-chips" role="group" aria-label="Filter services" onKeyDown={chipRoving.onKeyDown} onFocus={chipRoving.onFocus}>
                {chips.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="connector-chip"
                    data-testid="connector-filter"
                    data-filter={c.id}
                    aria-pressed={c.id === 'easy' ? easy : c.id === 'all' ? filter === 'all' && !easy : filter === c.id}
                    onClick={() => {
                      // Easy sign-in is a toggle that combines with a category; All resets both.
                      if (c.id === 'easy') setEasy((v) => !v)
                      else {
                        setFilter(c.id)
                        if (c.id === 'all') setEasy(false)
                      }
                    }}
                  >
                    {c.label}
                    {c.count !== undefined && <span className="connector-chip-n"> {c.count}</span>}
                  </button>
                ))}
              </div>
              <p className="connector-count muted" role="status" aria-live="polite" data-testid="connector-results-count">
                {serviceCount(total)}
              </p>
            </div>
            {total === 0 ? (
              <div className="connector-empty" data-testid="connector-empty">
                <strong>{query.trim() ? `No service matches "${query.trim()}"` : 'No services here'}</strong>
                <p className="muted">Try a different name, or add any other server yourself.</p>
                <div className="connector-empty-actions">
                  <Button
                    size="sm"
                    onClick={() => {
                      setQuery('')
                      setFilter('all')
                      setEasy(false)
                    }}
                  >
                    Clear search
                  </Button>
                  <Button size="sm" icon={Plus} testId="connector-empty-custom" onClick={goToCustomServers}>
                    Add a custom server
                  </Button>
                </div>
              </div>
            ) : (
              <div ref={sectionsRef} className="connector-sections" onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
                {sections.map((s) => (
                  <section key={s.key} className="connector-group" aria-label={s.title ?? 'Services'} data-testid="connector-group" data-group={s.key}>
                    {s.title && (
                      <h4 className="connector-group-title">
                        {s.title} <span className="muted connector-group-n">{s.items.length}</span>
                      </h4>
                    )}
                    <ul className="connector-grid">
                      {s.items.map((info) => (
                        <ConnectorTile key={info.connector.id} info={info} onOpen={() => setOpenId(info.connector.id)} />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
        {open && <ConnectorDialog info={open} onClose={() => setOpenId(null)} />}
      </div>
    </SettingsSection>
  )
}
