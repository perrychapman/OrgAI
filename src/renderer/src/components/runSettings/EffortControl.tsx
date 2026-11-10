import type { ReactElement } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Effort, ProviderId } from '@shared/types'
import { useTriggerAttrs } from './triggerAttrs'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import { SegmentedControl } from '../ui/SegmentedControl'
import { EFFORT_HELP, EFFORT_LABEL, EFFORT_UNSET_LABEL, RESET_TO_DEFAULT_LABEL, effortChoices, effortFallbackNote, fitEffort } from '../../lib/runSettings'
import '../../styles/run-settings.css'

/** Live run: the effort the run started with. It cannot change during a run, so this is text, not a control. */
export function EffortReadOnly({ effort }: { effort: Effort | undefined }): ReactElement {
  return (
    <span className="run-chip run-chip--static" data-testid="run-effort-readonly">
      <span className="run-chip__label">Effort:</span>
      <span className="run-chip__value">{effort ? EFFORT_LABEL[effort] : EFFORT_UNSET_LABEL}</span>
      <span className="sr-only">. Set when the run started; it cannot change during a run.</span>
    </span>
  )
}

/**
 * The New run page's effort chip. The popover holds a SegmentedControl of the levels the model's adapter takes, least to
 * most. That is the "stepped slider": a native radio group, so the arrow keys step through the levels, every level
 * has a visible name, and no value is hidden. A native range input would show a thumb with no level names (Codex has
 * three levels, Claude five) and would need a text readout for the value.
 *
 * `picked` is the user's choice (null = the default). `adapter` is the adapter of the model that will run: when the
 * model changes and the effort no longer fits it, the fitted level is shown with a visible and spoken note, and
 * startChoicesToSend sends the fitted level, never the unfit one.
 */
export function EffortControl(
  props:
    | { readOnly: true; effort: Effort | undefined }
    | { readOnly?: false; picked: Effort | null; defaultEffort: Effort | undefined; adapter: ProviderId | null | undefined; onChange: (next: Effort | null) => void }
): ReactElement {
  if (props.readOnly) return <EffortReadOnly effort={props.effort} />
  return <EffortEditable picked={props.picked} defaultEffort={props.defaultEffort} adapter={props.adapter} onChange={props.onChange} />
}

function EffortEditable({
  picked,
  defaultEffort,
  adapter,
  onChange
}: {
  picked: Effort | null
  defaultEffort: Effort | undefined
  adapter: ProviderId | null | undefined
  onChange: (next: Effort | null) => void
}): ReactElement {
  const attrs = useTriggerAttrs({ 'data-default': picked === null ? 'true' : 'false' })
  const choices = effortChoices(adapter)
  const fit = fitEffort(picked ?? defaultEffort, adapter)
  const note = fit.fellBack ? effortFallbackNote(fit.fellBack, fit.effort) : ''
  const text = fit.effort ? EFFORT_LABEL[fit.effort] : EFFORT_UNSET_LABEL
  const changed = picked !== null
  return (
    <>
      <span ref={attrs} className="run-setting run-setting--effort">
        <Popover
          placement="bottom-start"
          label="Effort for this run"
          triggerTestId="run-effort-change"
          testId="run-effort-picker"
          className="run-effort-picker"
          triggerClassName="run-chip"
          triggerTitle={`${EFFORT_HELP}${changed ? '' : ' This is the default.'}`}
          trigger={
            <>
              <span className="run-chip__label">Effort:</span>
              <span className="run-chip__value" data-testid="run-effort-current">
                {text}
              </span>
              {changed && <span className="run-chip__state">Changed</span>}
              <Icon icon={ChevronDown} size="xs" />
            </>
          }
        >
          {({ close }) => (
            <div className="run-popover-stack">
              <SegmentedControl<Effort>
                label="Effort"
                value={(fit.effort ?? '') as Effort}
                options={choices.map((e) => ({ value: e, label: EFFORT_LABEL[e] }))}
                onChange={(e) => onChange(e === defaultEffort && !fit.fellBack ? null : e)}
              />
              <p className="run-popover-help">{EFFORT_HELP}</p>
              {note && <p className="run-popover-help">{note}</p>}
              {changed && (
                <button
                  type="button"
                  className="link-btn"
                  data-testid="run-effort-default"
                  onClick={() => {
                    onChange(null)
                    close()
                  }}
                >
                  {RESET_TO_DEFAULT_LABEL}
                </button>
              )}
            </div>
          )}
        </Popover>
      </span>
      {note && (
        <p className="run-settings-note run-settings-note--warn" data-testid="run-effort-fallback">
          {note}
        </p>
      )}
      <span className="sr-only" role="status">
        {note}
      </span>
    </>
  )
}
