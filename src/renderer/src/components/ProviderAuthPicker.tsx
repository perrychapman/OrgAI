import type { ReactElement } from 'react'
import { useEffect, useId, useState } from 'react'
import type { ProviderAuth } from '@shared/types'
import { Input } from './ui/Input'
import { SegmentedControl } from './ui/SegmentedControl'

export const DEFAULT_API_KEY_ENV = 'ANTHROPIC_API_KEY'

/** Choice between the Claude Code login and an API key read from an environment variable. */
export default function ProviderAuthPicker({
  value,
  onChange,
  name
}: {
  value: ProviderAuth
  onChange: (auth: ProviderAuth) => void
  /** Accessible name of the choice group when several pickers are on screen. */
  name: string
}): ReactElement {
  // Remember the env var name while the user flips back to subscription and again to apiKey.
  const [envVar, setEnvVar] = useState(value.kind === 'apiKey' ? value.envVar : DEFAULT_API_KEY_ENV)
  const id = useId()
  useEffect(() => {
    if (value.kind === 'apiKey') setEnvVar(value.envVar)
  }, [value])

  return (
    <div className="field">
      <SegmentedControl
        label={`Authentication ${name}`}
        value={value.kind}
        options={[
          { value: 'subscription', label: 'Claude Code login' },
          { value: 'apiKey', label: 'API key from environment' }
        ]}
        onChange={(kind) => onChange(kind === 'subscription' ? { kind: 'subscription' } : { kind: 'apiKey', envVar: envVar.trim() || DEFAULT_API_KEY_ENV })}
      />
      {value.kind === 'apiKey' && (
        <>
          <label htmlFor={id}>Environment variable</label>
          <Input
            id={id}
            mono
            value={envVar}
            placeholder={DEFAULT_API_KEY_ENV}
            onChange={(raw) => {
              const v = raw.replace(/[^A-Za-z0-9_]/g, '')
              setEnvVar(v)
              if (v) onChange({ kind: 'apiKey', envVar: v })
            }}
          />
          <span className="hint">
            OrgAI never stores the key. It reads it from this variable when a run starts and passes it to the agents as ANTHROPIC_API_KEY.
          </span>
        </>
      )}
      {value.kind === 'subscription' && <span className="hint">Uses the account the Claude Code CLI is signed in with (claude auth login).</span>}
    </div>
  )
}
