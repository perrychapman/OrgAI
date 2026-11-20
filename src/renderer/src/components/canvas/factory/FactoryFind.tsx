// Factory Floor "Find a worker" (docs/design/factory-floor.md section 6.4): a Popover with a labelled search field and a
// list of native buttons, current session first, then "Earlier sessions". Choosing a row calls onChoose and closes the
// panel without returning focus to the trigger (the host focuses the worker); Escape closes and returns it.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type Ref } from 'react'
import { Search } from 'lucide-react'
import { Icon } from '../../ui/Icon'
import { Input } from '../../ui/Input'
import { Popover } from '../../ui/Popover'
import { filterFind, groupFind } from '../../../lib/factory/find'
import '../../../styles/factory-chrome.css'

export interface FactoryFindEntry {
  id: string
  name: string
  handle?: string
  statusWord: string
  line?: number
  session: 'current' | 'earlier'
}

export interface FactoryFindProps {
  /** Current ones in layout order, then earlier ones. */
  entries: readonly FactoryFindEntry[]
  onChoose(id: string, session: 'current' | 'earlier'): void
  buttonRef?: Ref<HTMLButtonElement>
}

function Rows({ rows, onPick, labelledBy }: { rows: readonly FactoryFindEntry[]; onPick: (e: FactoryFindEntry) => void; labelledBy?: string }): ReactElement {
  return (
    <ul className="factory-find-list" aria-labelledby={labelledBy}>
      {rows.map((e) => (
        <li key={`${e.session}:${e.id}`}>
          <button type="button" className="factory-find-row" data-testid="factory-find-result" data-factory-worker-id={e.id} onClick={() => onPick(e)}>
            <span className="factory-find-name">{e.name}</span>
            <span className="factory-find-meta">
              {e.statusWord}
              {e.line !== undefined ? ` · Line ${e.line}` : ''}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function FindPanel({ entries, onChoose, close }: { entries: readonly FactoryFindEntry[]; onChoose: FactoryFindProps['onChoose']; close: () => void }): ReactElement {
  const [query, setQuery] = useState('')
  const earlierId = useId()
  const groups = useMemo(() => groupFind(filterFind(entries, query)), [entries, query])
  const total = groups.current.length + groups.earlier.length
  const pick = (e: FactoryFindEntry): void => {
    // The host moves focus to the worker first; closing afterwards does not steal it back (Popover only refocuses the
    // trigger when focus was inside the panel).
    onChoose(e.id, e.session)
    close()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const panel = e.currentTarget
    const rows = Array.from(panel.querySelectorAll<HTMLButtonElement>('.factory-find-row'))
    const input = panel.querySelector<HTMLInputElement>('input')
    const at = rows.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Enter' && document.activeElement === input && rows.length > 0) {
      e.preventDefault()
      rows[0].click()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      rows[at + 1 < rows.length ? at + 1 : at < 0 ? 0 : at]?.focus()
    } else if (e.key === 'ArrowUp' && at >= 0) {
      e.preventDefault()
      if (at === 0) input?.focus()
      else rows[at - 1].focus()
    }
  }
  return (
    <div className="factory-find" onKeyDown={onKeyDown}>
      <Input type="search" aria-label="Search workers" placeholder="Search workers" value={query} onChange={setQuery} autoComplete="off" data-testid="factory-find-input" />
      {total === 0 ? (
        <p className="factory-find-empty">{query.trim() ? `No worker matches “${query.trim()}”.` : 'No workers on the floor yet.'}</p>
      ) : (
        <>
          {groups.current.length > 0 && <Rows rows={groups.current} onPick={pick} />}
          {groups.earlier.length > 0 && (
            <>
              <p className="factory-find-group" id={earlierId}>
                Earlier sessions
              </p>
              <Rows rows={groups.earlier} onPick={pick} labelledBy={earlierId} />
            </>
          )}
        </>
      )}
    </div>
  )
}

export function FactoryFind({ entries, onChoose, buttonRef }: FactoryFindProps): ReactElement {
  const wrapRef = useRef<HTMLSpanElement>(null)
  // Popover owns its trigger element; hand it out through buttonRef after mount.
  useEffect(() => {
    const btn = wrapRef.current?.querySelector<HTMLButtonElement>('button.factory-find-trigger') ?? null
    if (typeof buttonRef === 'function') {
      buttonRef(btn)
      return () => {
        buttonRef(null)
      }
    }
    if (buttonRef) {
      buttonRef.current = btn
      return () => {
        buttonRef.current = null
      }
    }
    return undefined
  }, [buttonRef])
  return (
    <span ref={wrapRef} className="factory-find-wrap">
    <Popover
      label="Find a worker"
      triggerLabel="Find a worker"
      triggerTitle="Find a worker"
      triggerClassName="btn sm factory-find-trigger"
      triggerTestId="factory-find"
      placement="top-start"
      className="factory-find-panel"
      trigger={
        <>
          <Icon icon={Search} size="sm" />
          <span className="factory-chrome-label">Find a worker</span>
        </>
      }
    >
      {({ close }) => <FindPanel entries={entries} onChoose={onChoose} close={close} />}
    </Popover>
    </span>
  )
}
