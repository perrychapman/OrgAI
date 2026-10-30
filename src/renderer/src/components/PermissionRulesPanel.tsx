import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { Project } from '@shared/types'
import { isWholeToolRule } from '@shared/types'

/** "Always allow (project)" rules saved in the project's .claude/settings.local.json. */
export default function PermissionRulesPanel({ project }: { project: Project }): ReactElement {
  const [rules, setRules] = useState<string[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

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

  const add = async (): Promise<void> => {
    const rule = draft.trim()
    if (!rule) return
    setBusy(rule)
    setError(null)
    try {
      setRules(await window.orgai.permissions.add({ projectId: project.id, rule }))
      setDraft('')
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
    } finally {
      setBusy(null)
    }
  }

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
        <span className="hint">
          None. Choose “Always allow (project)” on an approval card to stop being asked for similar calls, or approve the commands the Architect
          proposes during setup.
        </span>
      ) : (
        <div className="maint-list">
          {rules.map((rule) => (
            <div key={rule} className="maint-row">
              <div className="row" style={{ gap: 8 }}>
                <code style={{ wordBreak: 'break-all' }}>{rule}</code>
                {isWholeToolRule(rule) && (
                  <span className="chip" title={`Approves every ${rule} call before any prompt, whatever its input`}>
                    whole tool
                  </span>
                )}
                <button className="btn sm danger" style={{ marginLeft: 'auto' }} disabled={busy !== null} onClick={() => void remove(rule)}>
                  {busy === rule ? 'Removing…' : 'Remove'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ marginTop: 8, gap: 8 }}>
        <input
          className="input"
          value={draft}
          disabled={busy !== null}
          placeholder="Bash(gh repo create:*)"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
          style={{ flex: 1, fontFamily: 'var(--font-mono)' }}
        />
        <button className="btn sm" onClick={() => void add()} disabled={busy !== null || !draft.trim()}>
          Add rule
        </button>
        <button className="btn ghost sm" onClick={() => void refresh()} disabled={busy !== null}>
          Refresh
        </button>
      </div>
      <span className="hint">
        Stored under permissions.allow in .claude/settings.local.json. Rules apply to every new run and, through the harness, to runs of this project that
        are already open. Forms: Tool(prefix:*) for a command prefix, Tool(exact command), or a bare tool name. Agents that hit a denial can also ask for a
        rule from the live view.
      </span>
      {error && <span className="hint" style={{ color: 'var(--danger)' }}>{error}</span>}
    </div>
  )
}
