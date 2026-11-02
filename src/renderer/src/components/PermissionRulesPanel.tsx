import type { ReactElement } from 'react'
import { useCallback, useEffect, useId, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { Project } from '@shared/types'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { Input } from './ui/Input'
import { SettingsCard } from './settings/SettingsCard'
import { SettingsSection } from './settings/SettingsSection'
import { checkRuleDraft, collapseRules, ruleInfo } from '../lib/permissionCopy'
import { PROJECT_SETTINGS_SECTIONS } from '../lib/settingsTarget'

const EXAMPLES = ['Bash(npm test:*)', 'Bash(npm test *)', 'Bash(git status)', 'WebSearch', 'mcp__github']

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

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
  const kindId = `${inputId}-kind`

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

  const check = draft.trim() ? checkRuleDraft(draft) : null
  const add = async (): Promise<void> => {
    const checked = checkRuleDraft(draft)
    if (!checked.ok) {
      setError(checked.reason)
      return
    }
    const rule = checked.rule
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
      id={PROJECT_SETTINGS_SECTIONS.rules}
      title="Saved permission rules"
      description="Saved in .claude/settings.local.json in the project folder."
      testId="rules-section"
      actions={<IconButton icon={RefreshCw} label="Reload saved rules" size="sm" disabled={busy !== null} onClick={() => void refresh()} />}
    >
      <SettingsCard>
        {rules === null ? (
          <p className="settings-card-note">Loading…</p>
        ) : rules.length === 0 ? (
          <p className="settings-card-note">No saved rules yet.</p>
        ) : (
          <ul className="settings-card-list" aria-label="Saved permission rules">
            {collapseRules(rules).map(({ rule, count }) => {
              const info = ruleInfo(rule)
              return (
                <li key={rule} className="settings-card-item" data-testid="rule-row" data-rule={rule}>
                  <div className="rule-main">
                    <div className="rule-main-line">
                      <code className="rule-code">{rule}</code>
                      <span className="chip rule-kind" data-testid="rule-kind" data-kind={info.kind}>
                        {info.label}
                      </span>
                      {count > 1 && (
                        <span className="chip" data-testid="rule-count" title={`Saved ${count} times in the rules file`}>
                          saved {count} times
                        </span>
                      )}
                    </div>
                    <span className="rule-explain">{info.explain}</span>
                  </div>
                  <Button size="sm" variant="danger" ariaLabel={`Remove rule ${rule}`} disabled={busy !== null} onClick={() => void remove(rule)}>
                    {busy === rule ? 'Removing…' : 'Remove'}
                  </Button>
                </li>
              )
            })}
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
                placeholder="Bash(npm test:*)"
                spellCheck={false}
                invalid={!!error}
                aria-describedby={error ? errorId : check?.ok ? kindId : undefined}
                data-testid="rule-input"
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
            <Button size="sm" onClick={() => void add()} disabled={busy !== null} testId="rule-add">
              Add rule
            </Button>
          </div>
          {error && (
            <span className="field-error" id={errorId} role="alert" data-testid="rule-draft-error">
              {error}
            </span>
          )}
          {!error && check?.ok && (
            <span className="rule-draft-kind" id={kindId} data-testid="rule-draft-kind">
              {check.info.live ? `${capitalize(check.info.label)}: ${check.info.explain} Takes effect in open runs too.` : `Pattern: ${check.info.explain}`}
              {check.warning && (
                <span className="rule-draft-warning" data-testid="rule-draft-warning">
                  {check.warning}
                </span>
              )}
            </span>
          )}
          <details className="rule-examples">
            <summary>Examples</summary>
            <div className="rule-examples-body">
              <span className="settings-card-hint">
                A command prefix (both forms below), an exact command, a whole tool or all tools of an MCP server. Prefix, exact, whole-tool and server rules take effect in open runs too; other patterns from the next run. A command joined with &amp;&amp; needs every step covered.
              </span>
              <div className="chip-row" role="group" aria-label="Rule examples">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    className="chip chip-btn"
                    data-testid="rule-example"
                    onClick={() => {
                      setDraft(ex)
                      setError(null)
                    }}
                    title="Use this example"
                  >
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
