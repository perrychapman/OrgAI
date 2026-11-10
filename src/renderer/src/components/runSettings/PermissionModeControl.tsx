import type { ReactElement, ReactNode } from 'react'
import { useId, useRef, useState } from 'react'
import { useTriggerAttrs } from './triggerAttrs'
import { ChevronDown, Shield, ShieldAlert, ShieldOff } from 'lucide-react'
import type { PermissionMode } from '@shared/types'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import { useConfirm } from '../ui/ConfirmDialog'
import { isWideningMode, permissionModeHelp, permissionModeName, permissionTone, wideningConfirmOptions } from '../../lib/runSettings'
import '../../styles/run-settings.css'

/**
 * The permission chip and its popover, shared by the New run page (a draft) and the live composer (the run's mode).
 *
 * - The popover is a native radio list with each mode's short name and a help line. Picking only stages a mode: the
 *   arrow keys step through the radios, so applying on change would open a confirmation for every widening mode the
 *   cursor passes. "Use this mode" applies it.
 * - A mode that asks less than `baseline` (isWideningMode) is confirmed first, naming what stops asking (danger for
 *   Bypass). Cancel keeps the old value and returns focus to the chip. A narrower mode applies at once.
 * - A permissive current mode shows a tone (warning; danger for Bypass), always with an icon and the name (never colour
 *   alone). An untouched default keeps its tone but shows no "Changed" tag; only a picked change does.
 * - `onChoose` may be async (the live run's runs:setPermissionMode). A refusal or failure stays visible beside the chip.
 */
export function PermissionModeControl({
  value,
  choices,
  baseline,
  isDefault,
  defaultMode,
  defaultLabel = 'Project default',
  prefix = '',
  showState = true,
  disabled,
  busy,
  onChoose,
  footer,
  valueSuffix,
  inForce
}: {
  /** Shown after the value: the session's accept-edits grant ("edits accepted this session"). */
  valueSuffix?: string
  /**
   * The mode actually in force when it asks less than `value` (Accept edits under a session grant): sets the tone, and
   * re-applying `value` is allowed because a mode below Accept edits ends the grant.
   */
  inForce?: PermissionMode
  /** The mode shown on the chip. */
  value: PermissionMode
  /** The modes offered (newRunPermissionChoices, livePermissionChoices). */
  choices: readonly PermissionMode[]
  /** What a choice is compared against for widening: the project's mode on the start page, the run's mode live. */
  baseline: PermissionMode
  /** True when `value` is the default (the start page shows Default or Changed). */
  isDefault: boolean
  /** The mode marked with `defaultLabel` in the list. */
  defaultMode?: PermissionMode
  defaultLabel?: string
  /** Text before "Permission:" on the chip, e.g. "Next message: " for an ended run. */
  prefix?: string
  /** Show the Default / Changed word on the chip. */
  showState?: boolean
  disabled?: boolean
  busy?: boolean
  onChoose: (mode: PermissionMode) => Promise<void> | void
  /** Extra lines at the foot of the popover (live: "Applies at the next idle point"). */
  footer?: ReactNode
}): ReactElement {
  const id = useId()
  const [choice, setChoice] = useState<PermissionMode>(value)
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  // Bypass is the danger tone, Unattended and Auto-accept edits the warning tone; always with an icon and the name too.
  const tone = permissionTone(inForce ?? value)
  // Unchanged = nothing to apply, except re-applying the run's own mode to end a session grant.
  const unchanged = choice === value && !(inForce && inForce !== value)
  const region = useTriggerAttrs({ 'data-default': isDefault ? 'true' : 'false', 'data-tone': tone })
  const { confirm, dialog } = useConfirm()
  const name = permissionModeName(value)
  const pending = busy || working
  const focusTrigger = (): void => region.current?.querySelector<HTMLButtonElement>('[data-testid="run-permission-change"]')?.focus()

  // True from the click until the confirmation is answered: a second click (or Enter) must not open a second dialog.
  const confirming = useRef(false)

  const apply = async (close: () => void): Promise<void> => {
    if (unchanged || pending || confirming.current) return
    setError('')
    if (isWideningMode(baseline, choice)) {
      // The modal dismisses the popover; Cancel hands focus back to the chip.
      confirming.current = true
      let accepted = false
      try {
        accepted = await confirm(wideningConfirmOptions(baseline, choice))
      } finally {
        confirming.current = false
      }
      if (!accepted) {
        setChoice(value)
        requestAnimationFrame(focusTrigger)
        return
      }
    }
    setWorking(true)
    try {
      await onChoose(choice)
      close()
      requestAnimationFrame(focusTrigger)
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : 'The permission mode was not changed.')
    } finally {
      setWorking(false)
    }
  }

  return (
    <>
      <span ref={region} className="run-setting run-setting--permission" aria-busy={pending || undefined}>
        <Popover
          placement="bottom-start"
          label="Permission mode for this run"
          triggerTestId="run-permission-change"
          testId="run-permission-picker"
          className="run-permission-picker"
          triggerClassName={tone ? `run-chip run-chip--${tone}` : 'run-chip'}
          triggerTitle={`${permissionModeName(value)}${valueSuffix ? ` · ${valueSuffix}` : ''}: ${permissionModeHelp(value)}`}
          trigger={
            <>
              <Icon icon={tone === 'danger' ? ShieldOff : tone ? ShieldAlert : Shield} size="xs" />
              {/* Same order as the model chip ("Model: Next message: …"): label, then the next-message prefix, then the value. */}
              <span className="run-chip__label">Permission:</span>
              {prefix && <span className="run-chip__prefix">{prefix}</span>}
              <span className="run-chip__value" data-testid="run-permission-current">
                {name}
              </span>
              {valueSuffix && <span className="run-chip__suffix" data-testid="run-permission-session"> · {valueSuffix}</span>}
              {showState && !isDefault && <span className="run-chip__state">Changed</span>}
              <Icon icon={ChevronDown} size="xs" />
            </>
          }
          onOpenChange={(open) => {
            if (open) {
              setChoice(value)
              setError('')
            }
          }}
        >
          {({ close }) => (
            <div className="run-popover-stack">
              <fieldset className="run-permission-list" disabled={disabled || pending}>
                <legend className="run-popover-legend">What this run may do without asking</legend>
                {choices.map((mode) => (
                  <label key={mode} className="run-permission-option" data-tone={permissionTone(mode) ?? undefined}>
                    <input type="radio" name={`${id}-mode`} value={mode} checked={choice === mode} data-testid="run-permission-choice" onChange={() => setChoice(mode)} />
                    <span>
                      <span className="run-permission-option__name">
                        {/* Never colour alone: a permissive mode also carries the warning icon, as the chip does. */}
                        {permissionTone(mode) && (
                          <span className="run-permission-option__icon" data-testid="run-permission-option-icon">
                            <Icon icon={mode === 'bypassPermissions' ? ShieldOff : ShieldAlert} size="xs" />
                          </span>
                        )}
                        {permissionModeName(mode)}
                        {defaultMode === mode && <span className="run-permission-option__tag"> · {defaultLabel}</span>}
                      </span>
                      <span className="run-permission-option__help">{permissionModeHelp(mode)}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {footer}
              <div className="live-model-switch__actions">
                <Button size="sm" variant="primary" loading={working} disabled={unchanged || disabled} testId="run-permission-apply" onClick={() => void apply(close)}>
                  Use this mode
                </Button>
                <Button size="sm" onClick={close} testId="run-permission-cancel">
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </Popover>
      </span>
      {error && (
        <p className="run-settings-note run-settings-note--warn" role="alert" data-testid="run-permission-error">
          {error}
        </p>
      )}
      {dialog}
    </>
  )
}
