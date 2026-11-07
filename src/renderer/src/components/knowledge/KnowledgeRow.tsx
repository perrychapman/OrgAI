import type { MouseEvent, ReactElement } from 'react'
import type { KnowledgeItem, RunFacts } from '../../lib/knowledge'
import { itemExcerpt, itemKind, itemName, itemOrigin, itemRetired, itemSource, kindLabel, provenanceLine } from '../../lib/knowledge'
import { Badge } from '../ui/Badge'

/**
 * One row of the Knowledge list (docs/design/knowledge.md section 2): name, kind badge, the "Agent" and "Retired"
 * badges, the excerpt and the provenance line. No buttons (rec 16): the row is a `role=option`; its actions live in
 * the detail pane and in the list's "More actions" menu (Shift+F10 or the context menu).
 */
export function KnowledgeRow({
  item,
  runs,
  selected,
  showAgentBadge,
  domId,
  arrive,
  onOpen,
  onMenu
}: {
  /** The row was appended while the user is looking (docs/design/motion.md 3.19). */
  arrive?: boolean
  item: KnowledgeItem
  runs: RunFacts
  selected: boolean
  /** The "Agent" badge shows only when no origin chip is pressed (rec 8). */
  showAgentBadge: boolean
  domId: string
  onOpen: (id: string) => void
  /** Shift+F10 / the context menu: open the row's More actions menu at the given point (null = beside the row). */
  onMenu: (id: string, at: { x: number; y: number } | null) => void
}): ReactElement {
  const name = itemName(item)
  const kind = itemKind(item)
  const origin = itemOrigin(item)
  const retired = itemRetired(item)
  const excerpt = itemExcerpt(item)
  const onContextMenu = (e: MouseEvent<HTMLLIElement>): void => {
    e.preventDefault()
    // A keyboard context menu (Shift+F10, the Menu key) arrives with no pointer position.
    onMenu(item.id, e.button === 2 && (e.clientX || e.clientY) ? { x: e.clientX, y: e.clientY } : null)
  }
  return (
    <li
      id={domId}
      role="option"
      className={arrive ? 'knowledge-row motion-enter' : 'knowledge-row'}
      data-testid="knowledge-row"
      data-id={item.id}
      data-kind={kind}
      data-origin={origin}
      data-retired={retired ? 'true' : 'false'}
      data-excerpt={excerpt ? 'true' : 'false'}
      aria-selected={selected}
      tabIndex={-1}
      onClick={() => onOpen(item.id)}
      onContextMenu={onContextMenu}
    >
      <span className="knowledge-row-head">
        <span className="knowledge-row-name" data-testid="knowledge-row-name" title={name}>
          {name}
        </span>
        <Badge tone="neutral">{kindLabel(kind)}</Badge>
        {showAgentBadge && origin === 'agent' && <Badge tone="neutral">Agent</Badge>}
        {retired && <Badge tone="neutral">Retired</Badge>}
      </span>
      {excerpt && (
        <span className="knowledge-row-excerpt" title={excerpt}>
          {excerpt}
        </span>
      )}
      <span className="knowledge-row-prov" data-testid="knowledge-row-prov">
        {provenanceLine(itemSource(item), runs)}
      </span>
    </li>
  )
}
