import type { ReactElement } from 'react'
import { useCallback, useEffect, useId, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { Project } from '@shared/types'
import { isWholeToolRule } from '@shared/types'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { Input } from './ui/Input'
import { SettingsCard } from './settings/SettingsCard'
import { SettingsSection } from './settings/SettingsSection'

const EXAMPLES = ['Bash(git status:*)', 'Bash(npm test)', 'WebSearch']

const cleanError = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** "Always allow (project)" rules saved in the project's .claude/settings.local.json. */
export default function PermissionRulesPanel({ project }: { project: Project }): ReactElement {
  const [rules, setRules] = useState<string[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const inputId = useId()
  const errorId = `${inputId}-error`

  const refresh = useCallback(async () => {
    try {
      setRules(await window.orgai.permissions.list(project.id))
      setListError(null)
    } catch (e) {
      setListError(cleanError(e))
      setRules([])
    }
  }, [project.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const add = async (): Promise<void> => {
    const rule = draft.trim()
    if (!rule) {
      setError('Enter a rule first, for example Bash(git status:*).')
      return
    }
    setBusy(rule)
    setError(null)
    try {
      setRules(await window.orgai.permissions.add({ projectId: project.id, rule }))
      setDraft('')
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (rule: string): Promise<void> => {
    setBusy(rule)
    setListError(null)
    try {
      setRules(await window.orgai.permissions.remove({ projectId: project.id, rule }))
    } catch (e) {
      setListError(cleanError(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsSection
      id="settings-section-rules"
      title="Saved permission rules"
      actions={<IconButton icon={RefreshCw} label="Reload saved rules" size="sm" disabled={busy !== null} onClick={() => void refresh()} />}
    >
      <SettingsCard>
        {rules === null ? (
          <p className="settings-card-note">Loading…</p>
        ) : rules.length === 0 ? (
          <p className="settings-card-note">No saved rules yet.</p>
        ) : (
          <ul className="settings-card-list" aria-label="Saved permission rules">
            {rules.map((rule) => (
              <li key={rule} className="settings-card-item">
                <code className="rule-code">{rule}</code>
                {isWholeToolRule(rule) && (
                  <span className="chip" title={`Approves every ${rule} call before any prompt, whatever its input`}>
                    whole tool
                  </span>
                )}
                <span className="grow" />
                <Button size="sm" variant="danger" ariaLabel={`Remove rule ${rule}`} disabled={busy !== null} onClick={() => void remove(rule)}>
                  {busy === rule ? 'Removing…' : 'Remove'}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {listError && (
          <p className="field-error" role="alert">
            {listError}
          </p>
        )}
        <div className="settings-card-add">
          <div className="row gap-2">
            <div className="grow">
              <Input
                id={inputId}
                aria-label="New permission rule"
                mono
                value={draft}
                disabled={busy !== null}
                placeholder="Bash(gh repo create:*)"
                spellCheck={false}
                invalid={!!error}
                aria-describedby={error ? errorId : undefined}
                onChange={(v) => {
                  setDraft(v)
                  if (error) setError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void add()
                  }
                }}
              />
            </div>
            <Button size="sm" onClick={() => void add()} disabled={busy !== null}>
              Add rule
            </Button>
          </div>
          {error && (
            <span className="field-error" id={errorId} role="alert">
              {error}
            </span>
          )}
          <details className="rule-examples">
            <summary>Examples</summary>
            <div className="rule-examples-body">
              <span className="settings-card-hint">A command prefix, an exact command or a whole tool. Applies to open runs too.</span>
              <div className="chip-row" role="group" aria-label="Rule examples">
                {EXAMPLES.map((ex) => (
                  <button key={ex} type="button" className="chip chip-btn" onClick={() => setDraft(ex)} title="Use this example">
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          </details>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}
