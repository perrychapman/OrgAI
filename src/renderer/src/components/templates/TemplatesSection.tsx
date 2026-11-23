import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { openNewProject, useAppStore } from '../../store/useAppStore'
import { DetailActions, DetailChips, DetailHeader, DetailNote, SettingsGallery, type GalleryItem } from '../settings/SettingsGallery'
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
  const [selected, setSelected] = useState<string | null>(null)
  const kinds = [...new Set((templates ?? []).map((t) => t.kind))]

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
      setSelected(null)
      // Its panel and Remove button are gone: land on the section heading.
      window.setTimeout(() => {
        const h = document.querySelector<HTMLElement>('[data-testid=templates-section] .settings-section-title')
        h?.setAttribute('tabindex', '-1')
        h?.focus()
      }, 60)
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
        <SettingsGallery
          label="Team templates"
          testId="template-gallery"
          searchLabel={templates.length > 6 ? 'Search templates' : undefined}
          filters={kinds.length > 1 ? kinds.map((k) => ({ id: k, label: templateKindLabel(k) })) : undefined}
          selected={selected}
          onSelect={setSelected}
          sections={[{ id: 'saved', label: 'Saved from your projects', note: `${templates.length} ${templates.length === 1 ? 'template' : 'templates'}` }]}
          items={templates.map(
            (t): GalleryItem => ({
              id: t.id,
              name: t.name,
              section: 'saved',
              filter: t.kind,
              tag: `${templateKindLabel(t.kind)} · ${roleCountText(t.roleCount)}`,
              summary: t.description ? <span className="mcp-clamp">{t.description}</span> : undefined,
              searchText: `${t.description} ${t.roleNames.join(' ')}`,
              status: { text: savedDateLine(t.updatedAt), tone: 'info' },
              testId: 'template-row',
              data: { template: t.id }
            })
          )}
          renderDetail={(item) => {
            const t = templates.find((x) => x.id === item.id)
            if (!t) return null
            const more = t.roleCount - t.roleNames.length
            return (
              <div key={t.id} className="template-detail" data-testid="template-detail" data-template={t.id}>
                <DetailHeader name={t.name} tag={`${templateKindLabel(t.kind)} · ${savedDateLine(t.updatedAt)}`} />
                {t.description && <DetailNote tone="off">{t.description}</DetailNote>}
                <DetailChips title={`The team (${roleCountText(t.roleCount)})`} chips={more > 0 ? [...t.roleNames, `and ${more} more`] : t.roleNames} empty="No roles" />
                <p className="settings-detail-hint muted">
                  A template keeps the roles and how they report. It does not keep tool or skill access, or secrets. Use it when you create a project, or on a project's Team tab under Templates.
                </p>
                <DetailActions>
                  <Button size="sm" variant="primary" icon={Plus} testId="template-new-project" onClick={openNewProject}>
                    Start a new project
                  </Button>
                  <Button size="sm" variant="danger" icon={Trash2} ariaLabel={`Remove the template ${t.name}`} testId="template-remove" onClick={() => void remove(t.id, t.name)}>
                    Remove...
                  </Button>
                </DetailActions>
              </div>
            )
          }}
        />
      )}
      {dialog}
    </SettingsSection>
  )
}
