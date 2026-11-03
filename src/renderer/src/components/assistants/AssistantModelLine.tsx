import type { ReactElement } from 'react'
import { useAssistantModelName } from '../../lib/assistantModels'
import { CONNECTION_NAME } from '../../lib/settingsCopy'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'
import { useAppStore } from '../../store/useAppStore'

/** "Runs on <model> via <Connection>." with the link to App settings > General > Assistant models. */
export default function AssistantModelLine({ modelKey }: { modelKey: 'mcpAssistModel' | 'skillAssistModel' }): ReactElement {
  const model = useAssistantModelName(modelKey)
  // The effective default connection (the store value), never the raw setting.
  const connection = useAppStore((s) => s.defaultConnection)
  return (
    <p className="muted assistant-model-line" data-testid="assistant-model-line">
      Runs on {model}
      {connection ? ` via ${CONNECTION_NAME[connection]}` : ''}.{' '}
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
