import type { ReactElement } from 'react'
import type { AppSettingsProposalPayload } from '@shared/types'
import { formatAppSettingValue, groupAppSettingChanges, swatchOf } from '../../lib/appSettingsCard'
import { showHidden } from '../../lib/hiddenChars'
import { oneLine } from '../../lib/decisionTitle'

/**
 * The body of an 'appSettings' proposal (Chat's propose_app_settings): a Setting / Now / New table grouped by the pane
 * each setting lives in. Labels come from main's atlas; every other string goes through showHidden.
 * Test ids: `appsettings-proposal`, `appsettings-change[data-field]` with `-now` / `-new`, `proposal-rationale`.
 */
export function AppSettingsProposalBody({ payload }: { payload: AppSettingsProposalPayload }): ReactElement {
  const groups = groupAppSettingChanges(payload.changes)
  return (
    <div className="appsettings-proposal" data-testid="appsettings-proposal">
      <div className="proposal-table-wrap">
        <table className="proposal-table">
          <thead>
            <tr>
              <th scope="col">Setting</th>
              <th scope="col">Now</th>
              <th scope="col">New</th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.key} data-testid="appsettings-group">
              <tr className="proposal-table-group">
                <th scope="colgroup" colSpan={3}>
                  {g.path}
                </th>
              </tr>
              {g.changes.map((c) => {
                const nowSwatch = swatchOf(c.field, c.from)
                const newSwatch = swatchOf(c.field, c.to)
                return (
                  <tr key={c.field} data-testid="appsettings-change" data-field={c.field}>
                    <th scope="row" className="proposal-table-name">
                      {c.label}
                    </th>
                    <td className="proposal-table-now" data-testid="appsettings-change-now">
                      {nowSwatch && <span className="proposal-swatch" style={{ background: nowSwatch }} aria-hidden="true" />}
                      {formatAppSettingValue(c.field, c.from)}
                    </td>
                    <td className="proposal-table-new" data-testid="appsettings-change-new">
                      {newSwatch && <span className="proposal-swatch" style={{ background: newSwatch }} aria-hidden="true" />}
                      {formatAppSettingValue(c.field, c.to)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          ))}
        </table>
      </div>
      {payload.rationale.trim() && (
        <p className="proposal-rationale" data-testid="proposal-rationale">
          {showHidden(oneLine(payload.rationale, 1000))}
        </p>
      )}
    </div>
  )
}
