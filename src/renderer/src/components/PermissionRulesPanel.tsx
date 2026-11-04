import type { ReactElement } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { Project } from '@shared/types'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { Input } from './ui/Input'
import { SettingsCard } from './settings/SettingsCard'
import { SettingsSection } from './settings/SettingsSection'
import { checkRuleDraft, collapseRules, ruleInfo } from '../lib/permissionCopy'
import { PROJECT_SETTINGS_SECTIONS } from '../lib/settingsTarget'
import { useAppStore } from '../store/useAppStore'

const EXAMPLES = ['Bash(npm test:*)', 'Bash(npm test *)', 'Bash(git status)', 'WebSearch', 'mcp__github']

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

const cleanError = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** "Always allow (project)" rules saved in the project's .claude/settings.local.json. */
export default function PermissionRulesPanel({ project, onRulesChange }: { project: Project; /** Called with the saved rules whenever the list loads or changes. */ onRulesChange?: (rules: string[]) => void }): ReactElement {
  const [rules, setRules] = useState<string[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const inputId = useId()
  const errorId = `${inputId}-error`
  const kindId = `${inputId}-kind`
  const listRef = useRef<HTMLUListElement>(null)

  /**
   * Focus to restore once the save settles and controls are enabled again: a remove button index (clamped to the last
   * row) or null for the rule input. Applied in an effect, so it never lands on a still-disabled button.
   */
  const pendingFocus = useRef<number | null | undefined>(undefined)
  const focusAfter = (index: number | null): void => {
    pendingFocus.current = index
  }
  useEffect(() => {
    if (busy !== null || pendingFocus.current === undefined) return
    const index = pendingFocus.current
    pendingFocus.current = undefined
    const buttons = listRef.current?.querySelectorAll<HTMLElement>('[data-testid=rule-remove]')
    const target = index === null || !buttons?.length ? null : buttons[Math.min(index, buttons.length - 1)]
    if (target) target.focus()
    else document.getElementById(inputId)?.focus()
  }, [busy, rules, inputId])

  /** Latest request wins: refresh, add and remove each take a number, and a response with an older one is dropped. */
  const seq = useRef(0)

  const refresh = useCallback(async () => {
    const mine = ++seq.current
    try {
      const list = await window.orgai.permissions.list(project.id)
      if (mine !== seq.current) return
      setRules(list)
      setListError(null)
    } catch (e) {
      if (mine !== seq.current) return
      setListError(cleanError(e))
      setRules([])
    }
  }, [project.id])

  useEffect(() => {
    void refresh()
    // A project switch (or unmount) invalidates every response still in flight.
    return () => {
      seq.current++
    }
  }, [refresh])

  // Rules granted or saved from a run: refresh when the store's counter moves after mount (never a second fetch on mount or on a project switch).
  const changeCount = useAppStore((s) => s.rulesChangedByProject[project.id] ?? 0)
  const seenCount = useRef({ projectId: project.id, count: changeCount })
  useEffect(() => {
    const prev = seenCount.current
    seenCount.current = { projectId: project.id, count: changeCount }
    if (prev.projectId !== project.id || prev.count === changeCount) return
    void refresh()
  }, [changeCount, project.id, refresh])

  const notify = useRef(onRulesChange)
  notify.current = onRulesChange
  useEffect(() => {
    if (rules) notify.current?.(rules)
  }, [rules])

  const check = draft.trim() ? checkRuleDraft(draft) : null
  const add = async (): Promise<void> => {
    if (busy !== null) return
    const checked = checkRuleDraft(draft)
    if (!checked.ok) {
      setError(checked.reason)
      return
    }
    const rule = checked.rule
    setBusy(rule)
    setError(null)
    const mine = ++seq.current
    try {
      const list = await window.orgai.permissions.add({ projectId: project.id, rule })
      if (mine === seq.current) setRules(list)
      setDraft('')
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(null)
      // The Add button was disabled while saving; keep the keyboard in the rule input.
      focusAfter(null)
    }
  }

  const remove = async (rule: string, index: number): Promise<void> => {
    setBusy(rule)
    setListError(null)
    const mine = ++seq.current
    try {
      const list = await window.orgai.permissions.remove({ projectId: project.id, rule })
      if (mine === seq.current) setRules(list)
      // The row is gone: the next row's Remove (the previous one for the last row), else the rule input.
      focusAfter(index)
    } catch (e) {
      setListError(cleanError(e))
      // The row is still there: back to its own Remove button.
      focusAfter(index)
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
          <ul className="settings-card-list" aria-label="Saved permission rules" ref={listRef}>
            {collapseRules(rules).map(({ rule, count }, index) => {
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
                  <Button
                    size="sm"
                    variant="danger"
                    testId="rule-remove"
                    ariaLabel={busy === rule ? `Removing rule ${rule}` : `Remove rule ${rule}`}
                    loading={busy === rule}
                    disabled={busy !== null}
                    onClick={() => void remove(rule, index)}
                  >
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
                readOnly={busy !== null}
                aria-busy={busy !== null || undefined}
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
