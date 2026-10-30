import { useEffect, useState } from 'react'
import { CLAUDE_MODEL_OPTIONS } from '@shared/types'

/** Display name of a model setting ("opus" -> "Opus"); an unknown id shows as written. */
export function modelDisplayName(value: string): string {
  return CLAUDE_MODEL_OPTIONS.find((m) => m.value === value)?.label ?? value
}

type AssistantKey = 'setupModel' | 'mcpAssistModel'

/** The saved model of a built-in assistant ('opus' until settings load), kept current across saves. */
export function useAssistantModel(key: AssistantKey): string {
  const [value, setValue] = useState('opus')
  useEffect(() => {
    let live = true
    void window.orgai.settings.get().then((s) => {
      if (live && s[key]) setValue(s[key])
    }, () => undefined)
    const off = window.orgai.onSettingsChanged((s) => {
      if (s[key]) setValue(s[key])
    })
    return () => {
      live = false
      off()
    }
  }, [key])
  return value
}
