import type { ReactElement } from 'react'
import type { Role } from '@shared/types'
import { Badge } from '../ui/Badge'

/**
 * "Used by" for a Catalog row: one chip per role that may use the item. A chip is a button that selects that role on
 * the canvas and switches the panel to the Role tab. `all` means every role (a connection with no role list).
 */
export function UsedBy({ roles, all, onSelectRole }: { roles: Role[]; all?: boolean; onSelectRole?: (roleId: string) => void }): ReactElement {
  return (
    <div className="catalog-used-by" data-testid="catalog-used-by" role="group" aria-label="Used by">
      <span className="catalog-used-by-label">Used by</span>
      {all ? (
        <Badge>All roles</Badge>
      ) : roles.length === 0 ? (
        <span className="muted">no role yet</span>
      ) : (
        roles.map((r) =>
          onSelectRole ? (
            <button
              key={r.id}
              type="button"
              className="catalog-chip"
              data-testid="catalog-used-by-role"
              data-role-id={r.id}
              aria-label={`Show role ${r.name}`}
              onClick={() => onSelectRole(r.id)}
            >
              {r.name}
            </button>
          ) : (
            <Badge key={r.id}>{r.name}</Badge>
          )
        )
      )}
    </div>
  )
}
