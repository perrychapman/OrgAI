import type { ReactElement } from 'react'
import { useAssistantRunsOn } from '../../lib/assistantModels'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'
import { useAppStore } from '../../store/useAppStore'

/** "Runs on <tier> (<model>) via <Connection>." with the link to App settings > General > Assistant models. */
export default function AssistantModelLine({ modelKey }: { modelKey: 'mcpAssistModel' | 'skillAssistModel' }): ReactElement {
  // Resolved on the effective default connection (the store value), never the raw setting.
  const { text } = useAssistantRunsOn(modelKey)
  return (
    <p className="muted assistant-model-line" data-testid="assistant-model-line">
      {text}.{' '}
      <button
        type="button"
        className="link-btn"
        onClick={() => {
          requestAppSettingsSection(APP_SETTINGS_SECTIONS.assistantModels)
          useAppStore.getState().setView('appSettings')
          window.dispatchEvent(new Event('orgai:settings-section'))
        }}
      >
        Change in App settings
      </button>
    </p>
  )
}
