import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { roleCountText, savedDateLine, templateKindLabel } from '../../lib/templates'
import { APP_SETTINGS_SECTIONS } from '../../lib/settingsTarget'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { useConfirm } from '../ui/ConfirmDialog'
import { SettingsSection } from '../settings/SettingsSection'

/** App settings > Templates and kit > Team templates (engagement-2 section 3): the saved teams and their removal. */
export default function TemplatesSection(): ReactElement {
  const templates = useAppStore((s) => s.templates)
  const templatesError = useAppStore((s) => s.templatesError)
  const removeTemplate = useAppStore((s) => s.removeTemplate)
  const { confirm, dialog } = useConfirm()
  const [status, setStatus] = useState('')
  const [removeError, setRemoveError] = useState<string | null>(null)

  useEffect(() => {
    void useAppStore.getState().loadTemplates()
  }, [])

  const remove = async (id: string, name: string): Promise<void> => {
    const ok = await confirm({
      title: `Remove the template ${name}?`,
      body: 'Projects made from it keep their teams.',
      confirmLabel: 'Remove template',
      danger: true
    })
    if (!ok) return
    setRemoveError(null)
    try {
      await removeTemplate(id)
      setStatus(`Removed the template ${name}.`)
    } catch (e) {
      setRemoveError(cleanIpcError(e))
    }
  }

  return (
    <SettingsSection
      id={APP_SETTINGS_SECTIONS.templates}
      title="Team templates"
      description="Teams you saved from a project. Use one when you create a project or on a project's Team tab."
      testId="templates-section"
    >
      {/* One polite region for the section, rendered empty before it is used. */}
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      {(removeError || (templatesError && templates === null)) && (
        <Banner tone="danger" title={removeError ? 'Could not remove the template' : 'Could not load the templates'}>
          {removeError ?? templatesError}
        </Banner>
      )}
      {templates === null ? (
        !templatesError && <div className="skeleton template-skeleton" aria-busy="true" aria-label="Loading the templates" />
      ) : templates.length === 0 ? (
        <p className="card-block template-empty muted" data-testid="templates-empty">
          No templates yet. On a project's Team tab, choose Templates &gt; Save this team as a template.
        </p>
      ) : (
        <ul className="card-block template-list" aria-label="Team templates">
          {templates.map((t) => (
            <li key={t.id} className="template-row" data-testid="template-row" data-template={t.id}>
              <div className="template-row-main">
                <span className="template-row-name">{t.name}</span>
                {t.description && <span className="template-row-desc muted">{t.description}</span>}
                <span className="template-row-meta muted">
                  {templateKindLabel(t.kind)} · {roleCountText(t.roleCount)} · {savedDateLine(t.updatedAt)}
                </span>
              </div>
              <Button size="sm" variant="danger" icon={Trash2} ariaLabel={`Remove the template ${t.name}`} testId="template-remove" onClick={() => void remove(t.id, t.name)}>
                Remove...
              </Button>
            </li>
          ))}
        </ul>
      )}
      {dialog}
    </SettingsSection>
  )
}
