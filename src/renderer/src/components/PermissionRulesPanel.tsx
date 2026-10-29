import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { Project } from '@shared/types'

/** "Always allow (project)" rules saved in the project's .claude/settings.local.json. */
export default function PermissionRulesPanel({ project }: { project: Project }): ReactElement {
  const [rules, setRules] = useState<string[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setRules(await window.orgai.permissions.list(project.id))
    } catch (e) {
      setError((e as Error).message)
      setRules([])
    }
  }, [project.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const remove = async (rule: string): Promise<void> => {
    setBusy(rule)
    setError(null)
    try {
      setRules(await window.orgai.permissions.remove({ projectId: project.id, rule }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="field">
      <label>Saved permission rules</label>
      {rules === null ? (
        <span className="hint">Loading…</span>
      ) : rules.length === 0 ? (
        <span className="hint">None. Choose “Always allow (project)” on an approval card to stop being asked for similar calls.</span>
      ) : (
        <div className="maint-list">
          {rules.map((rule) => (
            <div key={rule} className="maint-row">
              <div className="row" style={{ gap: 8 }}>
                <code style={{ wordBreak: 'break-all' }}>{rule}</code>
                <button className="btn sm danger" style={{ marginLeft: 'auto' }} disabled={busy !== null} onClick={() => void remove(rule)}>
                  {busy === rule ? 'Removing…' : 'Remove'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn ghost sm" onClick={() => void refresh()} disabled={busy !== null}>
          Refresh
        </button>
        <span className="hint">Stored under permissions.allow in .claude/settings.local.json and applied to every new run. Changes reach runs started afterwards.</span>
      </div>
      {error && <span className="hint" style={{ color: 'var(--danger)' }}>{error}</span>}
    </div>
  )
}
