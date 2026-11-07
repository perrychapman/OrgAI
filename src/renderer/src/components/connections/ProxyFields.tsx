import type { ReactElement } from 'react'
import { Input } from '../ui/Input'
import { defaultModelsUrl, defaultOpenAIUrl, otherModelsHost } from '../../lib/proxyForm'
import type { ProxyFormErrors, ProxyFormValues } from '../../lib/proxyForm'

type Fields = Pick<ProxyFormValues, 'name' | 'anthropicBaseUrl' | 'openaiBaseUrl' | 'modelsUrl'>

/** The four proxy fields shared by the Add proxy dialog and the proxy card. `prefix` makes the DOM ids unique per use. */
export function ProxyFields({
  prefix,
  values,
  errors,
  onChange,
  testIds = true,
  autofocusName
}: {
  prefix: string
  values: Fields
  errors: ProxyFormErrors
  onChange: (patch: Partial<Fields>) => void
  testIds?: boolean
  autofocusName?: boolean
}): ReactElement {
  const openaiDefault = defaultOpenAIUrl(values.anthropicBaseUrl)
  const modelsDefault = defaultModelsUrl(values.anthropicBaseUrl, values.openaiBaseUrl)
  const otherHost = otherModelsHost(values.anthropicBaseUrl, values.openaiBaseUrl, values.modelsUrl)
  const tid = (n: string): string | undefined => (testIds ? n : undefined)
  const field = (key: keyof Fields, label: string, opts: { mono?: boolean; placeholder?: string; hint?: string; testId: string }): ReactElement => {
    const err = errors[key]
    const id = `${prefix}-${key}`
    const describedBy = [err ? `${id}-error` : '', opts.hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <Input id={id} data-autofocus={autofocusName && key === 'name' ? '' : undefined} data-testid={tid(opts.testId)} mono={opts.mono} placeholder={opts.placeholder} value={values[key]} invalid={!!err} aria-describedby={describedBy} autoComplete="off" spellCheck={false} onChange={(v) => onChange({ [key]: v })} />
        {err && (
          <span className="field-error" id={`${id}-error`}>
            {err}
          </span>
        )}
        {opts.hint && (
          <span className="hint" id={`${id}-hint`}>
            {opts.hint}
          </span>
        )}
      </div>
    )
  }
  return (
    <div className="conn-fields">
      {field('name', 'Name', { placeholder: 'Work gateway', testId: 'proxy-name' })}
      {field('anthropicBaseUrl', 'Anthropic URL (Claude)', { mono: true, placeholder: 'https://proxy.example.com', testId: 'proxy-anthropic-url' })}
      {field('openaiBaseUrl', 'OpenAI URL (Codex, optional)', {
        mono: true,
        placeholder: openaiDefault || 'https://proxy.example.com/v1',
        hint: openaiDefault ? `Left empty: ${openaiDefault}` : 'Left empty, it is the Anthropic URL plus /v1.',
        testId: 'proxy-openai-url'
      })}
      <div className="conn-field-wide">
        {field('modelsUrl', 'Models endpoint (optional)', {
          mono: true,
          placeholder: modelsDefault || 'https://proxy.example.com/v1/models',
          hint: modelsDefault ? `Left empty: ${modelsDefault}` : 'Left empty, it is the OpenAI URL plus /models.',
          testId: 'proxy-models-url'
        })}
        {otherHost && (
          <p className="field-msg warn" data-testid="proxy-models-host-note">
            The key will be sent to {otherHost}, a different host from the proxy URL. Only use a host you trust.
          </p>
        )}
      </div>
    </div>
  )
}
