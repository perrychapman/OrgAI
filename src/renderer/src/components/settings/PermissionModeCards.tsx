import type { ReactElement } from 'react'
import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { PermissionMode } from '@shared/types'
import { PERMISSION_MODE_SHORT } from '../../lib/settingsCopy'
import { PERMISSION_MODE_TRADEOFF, rulesApplyInMode } from '../../lib/permissionCopy'

/** The three modes shown as cards; the rest sit under "More options". Order: fewest prompts last, like the board. */
const PRIMARY: readonly PermissionMode[] = ['default', 'acceptEdits', 'auto']
const MORE: readonly PermissionMode[] = ['dontAsk', 'plan', 'bypassPermissions']

/** Plain-language card titles (ui-overhaul Settings board). The exact mode name stays visible under each title. */
const TITLE: Record<PermissionMode, string> = {
  default: 'Ask about everything',
  acceptEdits: 'Ask before risky actions',
  auto: 'Work on its own',
  dontAsk: 'Never ask, refuse instead',
  plan: 'Plan only',
  bypassPermissions: 'Skip all checks'
}

/** How many of the three ask-level bars are lit: more bars = more freedom. */
const LEVEL: Record<PermissionMode, number> = { default: 1, acceptEdits: 2, auto: 3, dontAsk: 0, plan: 0, bypassPermissions: 3 }

type Outcome = 'ask' | 'go' | 'check' | 'refused' | 'none' | 'unchecked'
const OUTCOME_LABEL: Record<Outcome, string> = {
  ask: 'Asks first',
  go: 'Goes ahead',
  check: 'Safety check decides',
  refused: 'Refused unless a rule allows it',
  none: 'Not done',
  unchecked: 'Goes ahead, unchecked'
}

const ACTIONS = ['Edit files in the project', 'Run a command', 'Edit files outside the allowed folders'] as const

/**
 * What happens in each mode, from the mode semantics main enforces (PERMISSION_MODE_TRADEOFF and the permissions
 * notes): Auto-accept edits lets edits inside the project and its allowed folders through and still asks for commands
 * and for files outside them; Unattended hands each call to the model's safety check; Never ask refuses what no rule
 * covers; Plan only changes nothing; Bypass checks nothing.
 */
const EFFECTS: Record<PermissionMode, readonly [Outcome, Outcome, Outcome]> = {
  default: ['ask', 'ask', 'ask'],
  acceptEdits: ['go', 'ask', 'ask'],
  auto: ['check', 'check', 'check'],
  dontAsk: ['refused', 'refused', 'refused'],
  plan: ['none', 'none', 'none'],
  bypassPermissions: ['unchecked', 'unchecked', 'unchecked']
}

function ModeCard({ mode, current, name, recommended, onPick }: { mode: PermissionMode; current: PermissionMode; name: string; recommended?: boolean; onPick: (m: PermissionMode) => void }): ReactElement {
  const on = mode === current
  const danger = mode === 'bypassPermissions'
  return (
    <label className={`perm-card${on ? ' is-on' : ''}${danger ? ' is-danger' : ''}`} data-testid="permission-mode-card" data-mode={mode}>
      <input type="radio" className="perm-card-input" name={name} value={mode} checked={on} onChange={() => onPick(mode)} />
      <span className="perm-card-bars" aria-hidden="true">
        {[1, 2, 3].map((i) => (
          <span key={i} className={i <= LEVEL[mode] ? 'is-lit' : undefined} />
        ))}
      </span>
      <span className="perm-card-title">{TITLE[mode]}</span>
      <span className="perm-card-mode">{PERMISSION_MODE_SHORT[mode]}</span>
      <span className="perm-card-text">{PERMISSION_MODE_TRADEOFF[mode]}</span>
      {recommended && <span className="perm-card-rec">Recommended</span>}
      {danger && <span className="perm-card-danger">Dangerous: only for throwaway folders</span>}
    </label>
  )
}

/**
 * "How much the team asks you" (ui-overhaul Settings board): the permission mode as a native radio group of cards,
 * three in view and the rest behind "More options" (open when one of them is chosen), then what that mode does with
 * three common actions. Picking a card saves at once through `onChange`.
 */
export function PermissionModeCards({ mode, onChange, label }: { mode: PermissionMode; onChange: (m: PermissionMode) => void; label: string }): ReactElement {
  const name = useId()
  const moreId = useId()
  const inMore = MORE.includes(mode)
  const [moreOpen, setMoreOpen] = useState(inMore)
  const showMore = moreOpen || inMore
  const effects = EFFECTS[mode]
  return (
    <div className="perm-cards-block">
      <div id={moreId} className="perm-cards" role="radiogroup" aria-label={label} data-testid="permission-mode-cards">
        {PRIMARY.map((m) => (
          <ModeCard key={m} mode={m} current={mode} name={name} recommended={m === 'auto'} onPick={onChange} />
        ))}
        {showMore && MORE.map((m) => <ModeCard key={m} mode={m} current={mode} name={name} onPick={onChange} />)}
      </div>
      {!inMore && (
        <button type="button" className="perm-more-toggle" aria-expanded={showMore} aria-controls={moreId} data-testid="permission-mode-more" onClick={() => setMoreOpen((o) => !o)}>
          <ChevronRight className="perm-more-chevron" size={14} aria-hidden="true" />
          {showMore ? 'Fewer options' : 'More options: never ask, plan only, skip all checks'}
        </button>
      )}
      <div className="perm-effects" aria-live="polite" data-testid="permission-mode-effects">
        <table>
          <caption className="sr-only">What happens with {PERMISSION_MODE_SHORT[mode]}</caption>
          <tbody>
            {ACTIONS.map((a, i) => (
              <tr key={a}>
                <th scope="row">{a}</th>
                <td>
                  <span className={`perm-outcome is-${effects[i]}`}>{OUTCOME_LABEL[effects[i]]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rulesApplyInMode(mode) && <p className="perm-effects-note">A saved rule below can let a specific command or folder through without asking.</p>}
      </div>
    </div>
  )
}
