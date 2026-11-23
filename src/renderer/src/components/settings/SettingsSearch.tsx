import type { KeyboardEvent, ReactElement } from 'react'
import { useId, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { isVirtualProjectId } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { searchSettings, type SettingsSearchHit } from '../../lib/settingsSearch'
import { requestAppSettingsSection, requestProjectSettingsSection } from '../../lib/settingsTarget'
import { useAppStore } from '../../store/useAppStore'

/** Go to a hit: App targets through the page's deep-link event; project targets open the project's Settings tab. */
function go(hit: SettingsSearchHit, projectId: string | null): void {
  const t = hit.target
  if (t.kind === 'app') {
    requestAppSettingsSection(t.target)
    window.dispatchEvent(new Event('orgai:settings-section'))
    return
  }
  if (t.kind === 'project' && projectId) {
    const st = useAppStore.getState()
    st.setProjectSettingsPane(projectId, t.pane ?? 'general')
    st.setView('settings')
    if (t.section) requestProjectSettingsSection(t.section)
  }
}

/**
 * "Search settings" in the Settings top bar: a labelled search field and, while it has text, a list of matching
 * settings (from the app atlas) as buttons. Down arrow moves from the field into the list, Up and Down move inside
 * it, Escape clears and returns to the field. The count is announced politely.
 */
export function SettingsSearch(): ReactElement {
  const [q, setQ] = useState('')
  const inputId = useId()
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const projectId = useAppStore((s) => (s.selectedProjectId && !isVirtualProjectId(s.selectedProjectId) ? s.selectedProjectId : null))
  const engagement = useAppStore((s) => {
    const p = projectId ? s.projects.find((x) => x.id === projectId) : undefined
    return p ? projectKindOf(p) === 'engagement' : false
  })
  const hasProject = useAppStore((s) => !!projectId && s.projects.some((x) => x.id === projectId))
  const hits = useMemo(() => searchSettings(q, { hasProject, engagement }), [q, hasProject, engagement])
  const open = q.trim().length > 0

  const buttons = (): HTMLButtonElement[] => [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  const onInputKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' && hits.length > 0) {
      e.preventDefault()
      buttons()[0]?.focus()
    } else if (e.key === 'Escape' && q) {
      e.preventDefault()
      setQ('')
    }
  }
  const onListKey = (e: KeyboardEvent<HTMLUListElement>): void => {
    const all = buttons()
    const i = all.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      all[Math.min(i + 1, all.length - 1)]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (i <= 0) inputRef.current?.focus()
      else all[i - 1]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setQ('')
      inputRef.current?.focus()
    }
  }
  const pick = (hit: SettingsSearchHit): void => {
    setQ('')
    go(hit, projectId)
  }

  return (
    <div
      className="settings-search"
      data-testid="settings-search"
      onBlur={(e) => {
        // Focus left the field and its results (Tab away, a click elsewhere): close the list.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setQ('')
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        Search settings
      </label>
      <Search className="settings-search-icon" size={14} aria-hidden="true" />
      <input
        ref={inputRef}
        id={inputId}
        type="search"
        className="settings-search-input"
        placeholder="Search settings"
        autoComplete="off"
        spellCheck={false}
        value={q}
        aria-controls={open ? listId : undefined}
        data-testid="settings-search-input"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onInputKey}
      />
      {open && (
        <div className="settings-search-pop glass-strong">
          {hits.length === 0 ? (
            <p className="settings-search-empty">No setting matches “{q.trim().slice(0, 60)}”.</p>
          ) : (
            <ul id={listId} ref={listRef} className="settings-search-list" aria-label="Matching settings" onKeyDown={onListKey}>
              {hits.map((h) => (
                <li key={h.id}>
                  <button type="button" className="settings-search-hit" data-testid="settings-search-hit" onClick={() => pick(h)}>
                    <span className="settings-search-label">{h.label}</span>
                    <span className="settings-search-where">{h.where}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {open ? `${hits.length} ${hits.length === 1 ? 'setting' : 'settings'} found` : ''}
      </span>
    </div>
  )
}
