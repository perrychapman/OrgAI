import type { ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Project } from '@shared/types'
import { knowledgeAutoContextOn } from '@shared/knowledge'
import { cleanIpcError } from '../../lib/ipcError'
import { SettingRow, settingDescId } from '../ui/SettingRow'
import { Switch } from '../ui/Switch'
import { knowledgeSummaryLine } from '../../lib/knowledge'
import { PROJECT_SETTINGS_SECTIONS } from '../../lib/settingsTarget'
import { useAppStore } from '../../store/useAppStore'
import { Banner } from '../ui/Banner'
import { SettingsSection } from './SettingsSection'

/**
 * Project settings > General > Context notes (engagements only; docs/design/knowledge.md section 9): one summary line
 * of what the team knows ("5 items (1 person, 4 systems), 2 notes, 6 facts") and a link to the Knowledge tab, where notes and items are
 * browsed and edited. Refetched on every engagement change push (notes and knowledge).
 */
export function ContextNotesSection({ project }: { project: Project }): ReactElement {
  const [summary, setSummary] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The newest request wins: a push can arrive while an earlier read is still in flight.
  const seq = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const mine = ++seq.current
    try {
      const [graph, notes] = await Promise.all([window.orgai.knowledge.get(project.id), window.orgai.engagement.listNotes(project.id)])
      if (mine !== seq.current) return
      setSummary(knowledgeSummaryLine(graph, notes))
      setError(null)
    } catch (e) {
      if (mine !== seq.current) return
      setError(cleanIpcError(e))
      setSummary((s) => s ?? '')
    }
  }, [project.id])

  useEffect(() => {
    setSummary(null)
    setError(null)
    void load()
    return window.orgai.onEngagementChanged((ev) => {
      if (ev.projectId === project.id && (ev.what === 'notes' || ev.what === 'knowledge')) void load()
    })
  }, [project.id, load])

  // Off saves false; on removes the field (unset = on). Saved at once, like the other switches.
  const [autoError, setAutoError] = useState<string | null>(null)
  const setAutoContext = (on: boolean): void => {
    const st = useAppStore.getState()
    const current = st.projects.find((p) => p.id === project.id) ?? project
    const { knowledgeAutoContext: _drop, ...rest } = current
    const updated: Project = on ? rest : { ...rest, knowledgeAutoContext: false }
    setAutoError(null)
    st.updateProject(updated)
    st.saveProjectNow(updated).catch((e: unknown) => setAutoError(`Could not save: ${cleanIpcError(e)}`))
  }

  return (
    <SettingsSection
      id={PROJECT_SETTINGS_SECTIONS.contextNotes}
      title="Context notes"
      testId="context-notes-section"
      description="Background the team can look up when it needs it: meeting notes, client preferences, terms. Agents read and write these notes; do not put passwords or keys here."
    >
      {error && (
        <Banner tone="danger" title="Context notes" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}
      <p className="settings-card-note knowledge-summary-line">
        <span data-testid="knowledge-summary">{error ? 'Could not read what the team recorded' : summary === null ? 'Looking…' : summary || 'Nothing recorded yet'}</span>
        {' · '}
        <button type="button" className="link-btn" data-testid="knowledge-open" onClick={() => useAppStore.getState().openKnowledgeItem({ projectId: project.id })}>
          Open Knowledge
        </button>
      </p>
      <SettingRow
        id="knowledge-auto-context-title"
        title="Add known items to what agents receive"
        description="When a message or brief names an item you added yourself, OrgAI adds a short note about it. This adds a little text to agents' messages."
        control={<Switch checked={knowledgeAutoContextOn(project)} onChange={setAutoContext} label="Add known items to what agents receive" describedBy={settingDescId('knowledge-auto-context-title')} testId="knowledge-auto-context" />}
      />
      {autoError && (
        <p className="field-msg error" role="alert" data-testid="knowledge-auto-context-error">
          {autoError}
        </p>
      )}
    </SettingsSection>
  )
}
