import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import type { ProviderAuth } from '@shared/types'

export const DEFAULT_API_KEY_ENV = 'ANTHROPIC_API_KEY'

/** Radio choice between the Claude Code login and an API key read from an environment variable. */
export default function ProviderAuthPicker({
  value,
  onChange,
  name
}: {
  value: ProviderAuth
  onChange: (auth: ProviderAuth) => void
  /** Distinguishes radio groups when several pickers are on screen. */
  name: string
}): ReactElement {
  // Remember the env var name while the user flips back to subscription and again to apiKey.
  const [envVar, setEnvVar] = useState(value.kind === 'apiKey' ? value.envVar : DEFAULT_API_KEY_ENV)
  useEffect(() => {
    if (value.kind === 'apiKey') setEnvVar(value.envVar)
  }, [value])

  return (
    <div className="field">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label className={`check ${value.kind === 'subscription' ? 'on' : ''}`}>
          <input
            type="radio"
            name={name}
            checked={value.kind === 'subscription'}
            onChange={() => onChange({ kind: 'subscription' })}
          />
          Claude Code login
        </label>
        <label className={`check ${value.kind === 'apiKey' ? 'on' : ''}`}>
          <input
            type="radio"
            name={name}
            checked={value.kind === 'apiKey'}
            onChange={() => onChange({ kind: 'apiKey', envVar: envVar.trim() || DEFAULT_API_KEY_ENV })}
          />
          API key from environment variable
        </label>
      </div>
      {value.kind === 'apiKey' && (
        <>
          <input
            className="input"
            style={{ maxWidth: 320, fontFamily: 'var(--mono, monospace)' }}
            value={envVar}
            placeholder={DEFAULT_API_KEY_ENV}
            onChange={(e) => {
              const v = e.target.value.replace(/[^A-Za-z0-9_]/g, '')
              setEnvVar(v)
              if (v) onChange({ kind: 'apiKey', envVar: v })
            }}
          />
          <span className="hint">
            The key itself is never stored by OrgAI. It is read from this variable in OrgAI&apos;s environment when a run starts and passed to the agents as
            ANTHROPIC_API_KEY.
          </span>
        </>
      )}
      {value.kind === 'subscription' && <span className="hint">Uses the account the Claude Code CLI is logged in with (`claude auth login`).</span>}
    </div>
  )
}
