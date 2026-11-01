import type { ReactElement } from 'react'
import { useAssistantModelName } from '../../lib/assistantModels'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'
import { useAppStore } from '../../store/useAppStore'

/** "Runs on <model>. Change in App settings > Defaults." with the link that opens that pane. */
export default function AssistantModelLine({ modelKey }: { modelKey: 'mcpAssistModel' | 'skillAssistModel' }): ReactElement {
  const model = useAssistantModelName(modelKey)
  return (
    <p className="muted assistant-model-line" data-testid="assistant-model-line">
      Runs on {model}.{' '}
      <button
        type="button"
        className="link-btn"
        onClick={() => {
          requestAppSettingsSection(APP_SETTINGS_SECTIONS.defaults)
          useAppStore.getState().setView('appSettings')
          window.dispatchEvent(new Event('orgai:settings-section'))
        }}
      >
        Change in App settings &gt; Defaults
      </button>
    </p>
  )
}
