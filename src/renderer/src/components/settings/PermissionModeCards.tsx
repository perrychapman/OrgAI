import type { ReactElement } from 'react'
import { useId, useState } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import type { PermissionMode } from '@shared/types'
import { PERMISSION_MODE_SHORT } from '../../lib/settingsCopy'
import { PERMISSION_MODE_TRADEOFF, rulesApplyInMode } from '../../lib/permissionCopy'
import { useConfirm } from '../ui/ConfirmDialog'
import { Button } from '../ui/Button'

/** The three modes shown as cards; the rest sit under "More options". Order: most prompts first, like the board. */
export const PRIMARY_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'auto']
export const MORE_MODES: readonly PermissionMode[] = ['dontAsk', 'plan', 'bypassPermissions']

/**
 * Plain-language card titles (ui-overhaul Settings board). The exact mode name (PERMISSION_MODE_SHORT, the name run
 * chips, cards and the CLI use) stays visible under each title, so the two never compete.
 */
export const MODE_TITLE: Record<PermissionMode, string> = {
  default: 'Ask before every change',
  acceptEdits: 'Edit freely, ask for commands',
  auto: 'Work on its own',
  dontAsk: 'Never ask',
  plan: 'Plan only',
  bypassPermissions: 'Skip all checks'
}

/** How many of the three freedom bars are lit. */
const LEVEL: Record<PermissionMode, number> = { default: 1, acceptEdits: 2, auto: 3, dontAsk: 0, plan: 0, bypassPermissions: 3 }

export type Outcome = 'ask' | 'askSafe' | 'go' | 'goOrCheck' | 'check' | 'never' | 'none' | 'readOnly' | 'unchecked'
export const OUTCOME_LABEL: Record<Outcome, string> = {
  ask: 'Asks first',
  askSafe: 'Asks, except known-safe reads',
  go: 'Goes ahead',
  goOrCheck: 'Goes ahead, or the safety check decides',
  check: 'Safety check decides',
  never: 'Never asks',
  none: 'Not done',
  readOnly: 'Read-only commands only',
  unchecked: 'Goes ahead, unchecked'
}

export const MODE_ACTIONS = ['Edit files in the project', 'Run a command', 'Edit files outside the allowed folders'] as const

/**
 * What happens in each mode on every provider (provider-neutral wording; checked against claude.ts
 * claudePermissionMode, codexProtocol.ts policyFor and docs/agent-notes/permissions.md). Where providers differ the
 * cell says the weaker guarantee: Codex runs known-safe read commands without asking in the asking modes, runs
 * in-project work in its sandbox under Unattended and Never ask, and allows read-only commands in Plan only.
 */
export const MODE_EFFECTS: Record<PermissionMode, readonly [Outcome, Outcome, Outcome]> = {
  default: ['ask', 'askSafe', 'ask'],
  acceptEdits: ['go', 'askSafe', 'ask'],
  auto: ['goOrCheck', 'check', 'check'],
  dontAsk: ['never', 'never', 'never'],
  plan: ['none', 'readOnly', 'none'],
  bypassPermissions: ['unchecked', 'unchecked', 'unchecked']
}

/** One line under the table for modes whose cells need it. */
const MODE_FOOT: Partial<Record<PermissionMode, string>> = {
  dontAsk: 'Anything that would need your approval is refused. Depending on the provider, work inside the project may still run in a sandbox.',
  auto: 'The safety check approves routine calls and asks you when it is unsure.'
}

function ModeCard({
  mode,
  current,
  chosen,
  name,
  recommended,
  onPick,
  onFocusMode
}: {
  mode: PermissionMode
  /** The saved mode ("Current"). */
  current: PermissionMode
  /** The checked radio: the saved mode, or the one arrowed to and not yet saved. */
  chosen: PermissionMode
  name: string
  recommended?: boolean
  onPick: (m: PermissionMode) => void
  onFocusMode: (m: PermissionMode) => void
}): ReactElement {
  const on = mode === current
  const danger = mode === 'bypassPermissions'
  const id = useId()
  return (
    <label className={`perm-card${on ? ' is-on' : ''}${mode === chosen && !on ? ' is-pending' : ''}${danger ? ' is-danger' : ''}`} data-testid="permission-mode-card" data-mode={mode}>
      <input
        type="radio"
        className="perm-card-input"
        name={name}
        value={mode}
        checked={mode === chosen}
        aria-labelledby={`${id}-t ${id}-m`}
        aria-describedby={`${id}-d`}
        // Arrow keys move the checked radio (native radio group behaviour) without saving: the pick waits for Enter,
        // Space or "Use this mode". A pointer click (detail > 0) saves at once, as before.
        onChange={() => onFocusMode(mode)}
        onClick={(e) => {
          if (e.detail > 0) onPick(mode)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onPick(mode)
          }
        }}
      />
      <span className="perm-card-top">
        <span className="perm-card-bars" aria-hidden="true">
          {[1, 2, 3].map((i) => (
            <span key={i} className={i <= LEVEL[mode] ? 'is-lit' : undefined} />
          ))}
        </span>
        {on && (
          <span className="perm-card-current">
            <Check size={12} aria-hidden="true" />
            Current
          </span>
        )}
      </span>
      <span className="perm-card-title" id={`${id}-t`}>
        {MODE_TITLE[mode]}
      </span>
      <span className="perm-card-mode" id={`${id}-m`}>
        {PERMISSION_MODE_SHORT[mode]}
      </span>
      <span id={`${id}-d`} className="perm-card-desc">
        <span className="perm-card-text">{PERMISSION_MODE_TRADEOFF[mode]}</span>
        {recommended && <span className="perm-card-rec">Recommended</span>}
        {danger && <span className="perm-card-danger">Dangerous: only for throwaway folders</span>}
      </span>
    </label>
  )
}

/**
 * "How much the team asks you" (ui-overhaul Settings board): the permission mode as a native radio group of cards,
 * three in view and the rest behind "More options" (open when one of them is chosen), then what that mode does with
 * three common actions. Picking a card saves through `onChange`; Bypass asks for confirmation first, so arrowing
 * through the group never lands on it silently.
 */
export function PermissionModeCards({ mode, onChange, label, projectName }: { mode: PermissionMode; onChange: (m: PermissionMode) => void; label: string; projectName: string }): ReactElement {
  const name = useId()
  const groupId = useId()
  const inMore = MORE_MODES.includes(mode)
  const [moreOpen, setMoreOpen] = useState(inMore)
  const { confirm, dialog } = useConfirm()
  // A mode arrowed to but not saved yet; cleared when it is saved, cancelled or the saved mode changes.
  const [pending, setPending] = useState<PermissionMode | null>(null)
  const [seenMode, setSeenMode] = useState(mode)
  if (seenMode !== mode) {
    setSeenMode(mode)
    setPending(null)
  }
  const chosen = pending ?? mode
  const showMore = moreOpen || inMore
  const effects = MODE_EFFECTS[chosen]
  const pick = async (m: PermissionMode): Promise<void> => {
    if (m === mode) {
      setPending(null)
      return
    }
    if (m === 'bypassPermissions') {
      const ok = await confirm({
        title: 'Skip all checks for this project?',
        body: `New runs in ${projectName} will edit files and run commands with no prompts and no checks. Use this only for a throwaway folder.`,
        confirmLabel: 'Skip all checks',
        cancelLabel: 'Keep the current mode',
        danger: true,
        confirmTestId: 'permission-bypass-confirm'
      })
      if (!ok) {
        setPending(null)
        return
      }
    }
    setPending(null)
    onChange(m)
  }
  const onFocusMode = (m: PermissionMode): void => setPending(m === mode ? null : m)
  return (
    <div className="perm-cards-block">
      <div id={groupId} className="perm-cards" role="radiogroup" aria-label={label} data-testid="permission-mode-cards">
        {PRIMARY_MODES.map((m) => (
          <ModeCard key={m} mode={m} current={mode} chosen={chosen} name={name} recommended={m === 'auto'} onPick={(x) => void pick(x)} onFocusMode={onFocusMode} />
        ))}
        {showMore && MORE_MODES.map((m) => <ModeCard key={m} mode={m} current={mode} chosen={chosen} name={name} onPick={(x) => void pick(x)} onFocusMode={onFocusMode} />)}
      </div>
      {pending && (
        <div className="perm-pending" data-testid="permission-mode-pending">
          <span className="perm-pending-text">
            {MODE_TITLE[pending]} is not saved yet. Press Enter, or:
          </span>
          <Button variant="primary" size="sm" testId="permission-mode-use" onClick={() => void pick(pending)}>
            Use {PERMISSION_MODE_SHORT[pending]}
          </Button>
          <Button variant="ghost" size="sm" testId="permission-mode-keep" onClick={() => setPending(null)}>
            Keep {PERMISSION_MODE_SHORT[mode]}
          </Button>
        </div>
      )}
      {!inMore && (
        <button type="button" className="perm-more-toggle" aria-expanded={showMore} aria-controls={groupId} data-testid="permission-mode-more" onClick={() => setMoreOpen((o) => !o)}>
          <ChevronRight className="perm-more-chevron" size={14} aria-hidden="true" />
          {showMore ? 'Fewer options' : 'More options: never ask, plan only, skip all checks'}
        </button>
      )}
      <div className="perm-effects" data-testid="permission-mode-effects">
        <table>
          <caption className={pending ? 'perm-effects-caption' : 'sr-only'}>
            {pending ? `What would happen with ${PERMISSION_MODE_SHORT[chosen]} (not saved)` : `What happens with ${PERMISSION_MODE_SHORT[chosen]}`}
          </caption>
          <tbody>
            {MODE_ACTIONS.map((a, i) => (
              <tr key={a}>
                <th scope="row">{a}</th>
                <td>
                  <span className={`perm-outcome is-${effects[i]}`}>{OUTCOME_LABEL[effects[i]]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {MODE_FOOT[chosen] && <p className="perm-effects-note">{MODE_FOOT[chosen]}</p>}
        {rulesApplyInMode(chosen) && <p className="perm-effects-note">A saved rule or an allowed folder below lets specific calls through.</p>}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {`${PERMISSION_MODE_SHORT[chosen]}${pending ? ', not saved, press Enter to use it' : ''}: ${MODE_ACTIONS.map((a, i) => `${a.toLowerCase()}, ${OUTCOME_LABEL[effects[i]].toLowerCase()}`).join('; ')}.`}
      </p>
      {dialog}
    </div>
  )
}
