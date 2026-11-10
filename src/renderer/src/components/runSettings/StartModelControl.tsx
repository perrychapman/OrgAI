import type { ReactElement } from 'react'
import { useCallback, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import { connectionLabel } from '../../lib/connectionLabel'
import { modelKey } from '../../lib/liveModelSwitch'
import { MODEL_HELP_ASK, MODEL_HELP_TEAM, type RunModel } from '../../lib/runSettings'
import { useTriggerAttrs } from './triggerAttrs'
import { ModelPickerList, focusSearchWhenOpen, useModelCatalog } from './ModelPickerList'
import '../../styles/run-settings.css'

/**
 * The New run page's model chip. It only picks the root agent's model for this draft; nothing is interrupted or handed
 * off (that is the live switch). `picked` is the user's choice, `defaultModel` what the run would use anyway.
 */
export function StartModelControl({
  picked,
  defaultModel,
  ask,
  mockProject,
  onChange
}: {
  picked: RunModel | null
  defaultModel: RunModel | null
  ask: boolean
  /** A mock project runs every model on the mock adapter. */
  mockProject: boolean
  onChange: (next: RunModel | null) => void
}): ReactElement {
  const attrs = useTriggerAttrs({ 'data-default': picked ? 'false' : 'true' })
  const [open, setOpen] = useState(false)
  const catalog = useModelCatalog(open)
  const [query, setQuery] = useState('')
  const [choice, setChoice] = useState('')
  const shown = picked ?? defaultModel
  const shownText = shown ? `${shown.label} · ${connectionLabel(shown.connection)}` : 'Project default'
  const selected = catalog.models.find((m) => modelKey(m.connection, m.id) === choice)
  const unchanged = !selected || (!!shown && selected.id === shown.model && selected.connection === shown.connection)
  const defaultWord = ask ? 'Use default' : 'Use project default'
  const focusSearch = useCallback((node: HTMLInputElement | null) => (node ? focusSearchWhenOpen(node) : undefined), [])

  return (
    <span ref={attrs} className="run-setting run-setting--model">
      <Popover
        placement="bottom-start"
        label="Choose model for this run"
        triggerTestId="run-model-change"
        testId="run-model-picker"
        className="live-model-switch__picker run-model-picker"
        triggerClassName="run-chip"
        triggerTitle={shown ? `${shown.model} via ${connectionLabel(shown.connection)}. ${ask ? MODEL_HELP_ASK : MODEL_HELP_TEAM}` : MODEL_HELP_TEAM}
        trigger={
          <>
            <span className="run-chip__label">Model:</span>
            <span className="run-chip__value" data-testid="run-model-current">
              {shownText}
            </span>
            <span className="run-chip__state">{picked ? 'Changed' : 'Default'}</span>
            <Icon icon={ChevronDown} size="xs" />
          </>
        }
        onOpenChange={(value) => {
          setOpen(value)
          if (value) {
            setQuery('')
            setChoice(shown ? modelKey(shown.connection, shown.model) : '')
          }
        }}
      >
        {({ close }) => (
          <>
            <ModelPickerList
              testIdPrefix="run-model"
              catalog={catalog}
              query={query}
              onQuery={setQuery}
              choice={choice}
              onChoose={(model) => setChoice(modelKey(model.connection, model.id))}
              current={defaultModel ? { model: defaultModel.model, connection: defaultModel.connection } : null}
              currentWord="Default"
              currentText={defaultModel ? `${defaultModel.label} · ${connectionLabel(defaultModel.connection)}` : 'set by the project'}
              searchRef={focusSearch}
              onEscape={close}
            />
            <div className="live-model-switch__footer">
              <p data-testid="run-model-help">{ask ? MODEL_HELP_ASK : MODEL_HELP_TEAM}</p>
              <div className="live-model-switch__actions">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={unchanged || catalog.loading}
                  testId="run-model-apply"
                  onClick={() => {
                    if (!selected) return
                    const same = !!defaultModel && selected.id === defaultModel.model && selected.connection === defaultModel.connection
                    onChange(same ? null : { model: selected.id, connection: selected.connection, adapter: mockProject ? 'mock' : selected.adapter, label: selected.label || selected.id })
                    close()
                  }}
                >
                  Use this model
                </Button>
                <Button size="sm" onClick={close} testId="run-model-cancel">
                  Cancel
                </Button>
                {picked && (
                  <button
                    type="button"
                    className="link-btn"
                    data-testid="run-model-default"
                    onClick={() => {
                      onChange(null)
                      close()
                    }}
                  >
                    {defaultWord}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </Popover>
    </span>
  )
}
