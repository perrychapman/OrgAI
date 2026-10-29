import type { ReactElement } from 'react'
import { useId } from 'react'

export interface ModelOption {
  value: string
  label: string
  disabled?: boolean
}
export interface ModelGroup {
  /** Omit for options that sit outside any optgroup. */
  label?: string
  options: ModelOption[]
}

/** Native select with optgroups for model pickers. Option text is mono so ids align. */
export function ModelSelect({
  label,
  hideLabel,
  value,
  groups,
  onChange,
  disabled,
  invalid,
  message,
  description,
  placeholder,
  testId,
  dataTier
}: {
  label: string
  hideLabel?: boolean
  value: string
  groups: ModelGroup[]
  onChange: (value: string) => void
  disabled?: boolean
  invalid?: boolean
  /** Invalid or helper message under the select. */
  message?: string
  description?: string
  /** Shown as a disabled first option when value is ''. */
  placeholder?: string
  testId?: string
  dataTier?: string
}): ReactElement {
  const id = useId()
  const msgId = `${id}-msg`
  return (
    <div className="model-select">
      <label htmlFor={id} className={hideLabel ? 'sr-only' : undefined}>
        {label}
      </label>
      <select
        id={id}
        className={`select mono-select${invalid ? ' invalid' : ''}`}
        value={value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={message || description ? msgId : undefined}
        data-testid={testId}
        data-tier={dataTier}
        onChange={(e) => onChange(e.target.value)}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {groups.map((g, i) =>
          g.label ? (
            <optgroup key={g.label + i} label={g.label}>
              {g.options.map((o) => (
                <option key={o.value} value={o.value} disabled={o.disabled}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ) : (
            g.options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))
          )
        )}
      </select>
      {(message || description) && (
        <span id={msgId} className={invalid ? 'hint invalid-text' : 'hint'}>
          {message ?? description}
        </span>
      )}
    </div>
  )
}
