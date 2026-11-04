import type { ReactElement } from 'react'
import { useState } from 'react'
import { Download, Upload } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { clampLabel } from '../../lib/clampLabel'
import { showHidden } from '../../lib/hiddenChars'
import { kitApi, type KitApplyResult, type KitExportResult, type KitImportPreview } from '../../lib/kitApi'
import { KIT_LAST_KEY, importedCount, importedLine, kitLastLine, needsSecretsLine, parseKitLast, type KitLast } from '../../lib/kit'
import { APP_SETTINGS_PANES, requestAppSettingsSection } from '../../lib/settingsTarget'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { CopyButton } from '../ui/CopyButton'
import { SettingsSection } from '../settings/SettingsSection'
import KitExportDialog from './KitExportDialog'
import KitImportDialog from './KitImportDialog'
import '../../styles/kit.css'

function readLast(): KitLast | null {
  try {
    return parseKitLast(localStorage.getItem(KIT_LAST_KEY))
  } catch {
    return null
  }
}

function writeLast(kind: KitLast['kind'], count: number): KitLast {
  const last: KitLast = { kind, count, at: Date.now() }
  try {
    localStorage.setItem(KIT_LAST_KEY, JSON.stringify(last))
  } catch {
    /* storage unavailable: the line just shows for this session */
  }
  return last
}

/** App settings > Templates and kit > Practice kit (engagement-2 section 8). Absent when the build has no kit runtime. */
export default function KitSection(): ReactElement | null {
  const api = kitApi()
  const [exporting, setExporting] = useState(false)
  const [preview, setPreview] = useState<KitImportPreview | null>(null)
  const [saved, setSaved] = useState<KitExportResult | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [notice, setNotice] = useState<KitApplyResult | null>(null)
  const [last, setLast] = useState<KitLast | null>(readLast)
  const [picking, setPicking] = useState(false)

  if (!api) return null

  const startImport = async (): Promise<void> => {
    setRefusal(null)
    setPicking(true)
    try {
      const path = await api.pickImportPath()
      if (!path) return
      setPreview(await api.previewImport({ path }))
    } catch (e) {
      setRefusal(cleanIpcError(e))
    } finally {
      setPicking(false)
    }
  }

  const openConnectors = (): void => {
    requestAppSettingsSection(APP_SETTINGS_PANES.mcpLibrary)
    window.dispatchEvent(new Event('orgai:settings-section'))
  }

  return (
    <SettingsSection
      id="appsettings-section-kit"
      title="Practice kit"
      description="Your skills, custom servers, presets and templates in one file, to move to another computer or share with a colleague. Secret values and sign-ins never go in it."
      testId="kit-section"
      actions={
        <>
          <Button icon={Upload} testId="kit-export" onClick={() => { setSaved(null); setRefusal(null); setExporting(true) }}>
            Export a kit...
          </Button>
          <Button icon={Download} loading={picking} testId="kit-import" onClick={() => void startImport()}>
            Import a kit...
          </Button>
        </>
      }
    >
      {last && (
        <p className="kit-last muted" data-testid="kit-last">
          {kitLastLine(last)}
        </p>
      )}
      <div className="kit-status" role="status" aria-live="polite" data-testid="kit-status">
        {saved && (
          <>
            <p className="kit-saved">
              <span>Saved the kit to {clampLabel(showHidden(saved.path), 200)}.</span>
              <CopyButton text={saved.path} label="Copy the kit's path" />
            </p>
            {saved.notes.length > 0 && (
              <ul className="kit-left-out muted" aria-label="Left out of the kit">
                {saved.notes.map((n, i) => (
                  <li key={i}>{clampLabel(showHidden(n), 240)}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      {refusal && (
        <p className="field-error" role="alert" data-testid="kit-refusal">
          {refusal}
        </p>
      )}
      {notice && <ImportNotice result={notice} onOpenConnectors={openConnectors} onDismiss={() => setNotice(null)} />}
      {exporting && (
        <KitExportDialog
          onClose={() => setExporting(false)}
          onSaved={(result) => {
            setExporting(false)
            setSaved(result)
            setLast(writeLast('exported', result.counts.skills + result.counts.mcpServers + result.counts.connectorPresets + result.counts.templates))
          }}
        />
      )}
      {preview && (
        <KitImportDialog
          preview={preview}
          onClose={() => setPreview(null)}
          onApplied={(result) => {
            setPreview(null)
            setNotice(result)
            setLast(writeLast('imported', importedCount(result)))
            void useAppStore.getState().loadTemplates()
          }}
        />
      )}
    </SettingsSection>
  )
}

function ImportNotice({ result, onOpenConnectors, onDismiss }: { result: KitApplyResult; onOpenConnectors: () => void; onDismiss: () => void }): ReactElement {
  const secrets = needsSecretsLine(result.needsSecrets)
  return (
    <Banner
      tone="success"
      title={importedLine(importedCount(result))}
      onDismiss={onDismiss}
      testId="kit-import-notice"
      actions={
        result.needsSecrets.length > 0 ? (
          <Button size="sm" testId="kit-open-connectors" onClick={onOpenConnectors}>
            Open Connectors
          </Button>
        ) : undefined
      }
    >
      {result.failed.length > 0 && (
        <ul className="kit-failed" aria-label="Items that could not be imported">
          {result.failed.map((f) => (
            <li key={f.key}>
              {clampLabel(showHidden(f.name), 80)} was not imported: {clampLabel(showHidden(f.reason), 200)}
            </li>
          ))}
        </ul>
      )}
      {secrets && <p>{clampLabel(showHidden(secrets), 600)}</p>}
      {result.notes.length > 0 && (
        <ul className="kit-left-out">
          {result.notes.map((n, i) => (
            <li key={i}>{clampLabel(showHidden(n), 240)}</li>
          ))}
        </ul>
      )}
    </Banner>
  )
}
