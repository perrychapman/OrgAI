import type { ReactElement } from 'react'
import type { ProjectSettingRow } from '../../lib/appSettingsCard'

/**
 * The Setting / Now / New table of a Chat-proposed change to another project's settings.
 * Test ids: `settings-change[data-field]` with `settings-change-now` / `settings-change-new`.
 */
export function ProjectSettingsChanges({ rows }: { rows: readonly ProjectSettingRow[] }): ReactElement | null {
  if (rows.length === 0) return null
  return (
    <div className="proposal-table-wrap" data-testid="settings-changes">
      <table className="proposal-table">
        <thead>
          <tr>
            <th scope="col">Setting</th>
            <th scope="col">Now</th>
            <th scope="col">New</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.field} data-testid="settings-change" data-field={r.field}>
              <th scope="row" className="proposal-table-name">
                {r.label}
              </th>
              <td className="proposal-table-now" data-testid="settings-change-now">
                {r.now}
              </td>
              <td className="proposal-table-new" data-testid="settings-change-new">
                {r.next}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
