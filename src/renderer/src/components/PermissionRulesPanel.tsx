import type { ReactElement } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { IgnoredPermissionRule, Project } from '@shared/types'
import { IGNORED_NOTE, IGNORED_REMOVED, IGNORED_TITLE, IGNORED_CUT_TEXT, cleanIgnored, ignoredDisplay, ignoredRemovable, ignoredRemoveLabel } from '../lib/ignoredRules'
import { hasHidden } from '../lib/hiddenChars'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { Input } from './ui/Input'
import { SettingsCard } from './settings/SettingsCard'
import { SettingsSection } from './settings/SettingsSection'
import { checkRuleDraft, collapseRules, ruleInfo } from '../lib/permissionCopy'
import { projectRulesLocation } from '@shared/defaults'
import { rulePlaceholder, ruleExamples, rulesSavedIn } from '../lib/settingsCopy'
import { PROJECT_SETTINGS_SECTIONS } from '../lib/settingsTarget'
import { useAppStore } from '../store/useAppStore'

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

const cleanError = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** "Always allow (project)" rules saved in the project's .claude/settings.local.json. */
export default function PermissionRulesPanel({ project, onRulesChange }: { project: Project; /** Called with the saved rules whenever the list loads or changes. */ onRulesChange?: (rules: string[]) => void }): ReactElement {
  const location = projectRulesLocation(project)
  const [rules, setRules] = useState<string[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const inputId = useId()
  const errorId = `${inputId}-error`
  const kindId = `${inputId}-kind`
  const listRef = useRef<HTMLUListElement>(null)
  const ignoredRef = useRef<HTMLUListElement>(null)
  const pendingIgnoredFocus = useRef<number | undefined>(undefined)
  const [ignored, setIgnored] = useState<IgnoredPermissionRule[]>([])
  const [removedNote, setRemovedNote] = useState('')

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

  const ignoredSeq = useRef(0)
  /** Rules OrgAI ignores. A missing API or a failure leaves the group out (the saved list shows its own errors). */
  const refreshIgnored = useCallback(async (): Promise<void> => {
    const mine = ++ignoredSeq.current
    try {
      const fn = window.orgai.permissions?.ignored
      const list = typeof fn === 'function' ? cleanIgnored(await fn(project.id)) : []
      if (mine !== ignoredSeq.current) return
      setIgnored(list)
    } catch {
      if (mine !== ignoredSeq.current) return
      setIgnored([])
    }
  }, [project.id])

  const refresh = useCallback(async () => {
    const mine = ++seq.current
    void refreshIgnored()
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
  }, [project.id, refreshIgnored])

  useEffect(() => {
    void refresh()
    // A project switch (or unmount) invalidates every response still in flight.
    return () => {
      seq.current++
      ignoredSeq.current++
    }
  }, [refresh])

  const removeIgnored = async (item: IgnoredPermissionRule, index: number): Promise<void> => {
    setBusy(item.rule)
    setListError(null)
    setRemovedNote('')
    const mine = ++seq.current
    try {
      const list = await window.orgai.permissions.remove({ projectId: project.id, rule: item.rule })
      if (mine === seq.current) setRules(list)
      await refreshIgnored()
      setRemovedNote(IGNORED_REMOVED)
    } catch (e) {
      setListError(cleanError(e))
    } finally {
      pendingIgnoredFocus.current = index
      setBusy(null)
    }
  }

  // After a Remove in the "Not used" group: the next row's Remove (the previous for the last), else the rule input.
  useEffect(() => {
    if (busy !== null || pendingIgnoredFocus.current === undefined) return
    const index = pendingIgnoredFocus.current
    pendingIgnoredFocus.current = undefined
    const buttons = ignoredRef.current?.querySelectorAll<HTMLElement>('[data-testid=rule-ignored-remove]')
    const target = !buttons?.length ? null : buttons[Math.min(index, buttons.length - 1)]
    if (target) target.focus()
    else document.getElementById(inputId)?.focus()
  }, [busy, ignored, inputId])

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
      description={rulesSavedIn(location)}
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
                placeholder={rulePlaceholder(location)}
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
                {location === 'app'
                  ? 'A whole tool or all tools of a connected server. These rules take effect in open runs too.'
                  : 'A command prefix (both forms below), an exact command, a whole tool or all tools of an MCP server. Prefix, exact, whole-tool and server rules take effect in open runs too; other patterns from the next run. A command joined with && needs every step covered.'}
              </span>
              <div className="chip-row" role="group" aria-label="Rule examples">
                {ruleExamples(location).map((ex) => (
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
      <span className="sr-only" role="status" data-testid="rules-ignored-status">
        {removedNote}
      </span>
      {ignored.length > 0 && (
        <SettingsCard>
          <div className="rules-ignored" data-testid="rules-ignored">
            <h4 className="rules-ignored-title">{IGNORED_TITLE}</h4>
            <p className="settings-card-note" data-testid="rules-ignored-note">
              {IGNORED_NOTE}
            </p>
            <ul className="settings-card-list" aria-label="Rules OrgAI does not use" ref={ignoredRef}>
              {ignored.map((item, index) => (
                <li key={`${index}:${item.rule}`} className="settings-card-item" data-testid="rule-ignored-row" data-rule={item.rule}>
                  <div className="rule-main">
                    <div className="rule-main-line">
                      <code className="rule-code">{ignoredDisplay(item)}</code>
                      {(item.hiddenChar || hasHidden(item.rule)) && (
                        <span className="chip" data-testid="rule-ignored-hidden">
                          Hidden characters shown
                        </span>
                      )}
                    </div>
                    <span className="rule-explain" data-testid="rule-ignored-reason">
                      {item.reason}
                    </span>
                    {!ignoredRemovable(item) && (
                      <span className="rule-explain" data-testid="rule-ignored-cut">
                        {IGNORED_CUT_TEXT}
                      </span>
                    )}
                  </div>
                  {ignoredRemovable(item) && (
                    <Button
                      size="sm"
                      variant="danger"
                      testId="rule-ignored-remove"
                      ariaLabel={ignoredRemoveLabel(item, busy === item.rule)}
                      loading={busy === item.rule}
                      disabled={busy !== null}
                      onClick={() => void removeIgnored(item, index)}
                    >
                      {busy === item.rule ? 'Removing…' : 'Remove'}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </SettingsCard>
      )}
    </SettingsSection>
  )
}
