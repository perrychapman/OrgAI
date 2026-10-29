import type { ReactElement } from 'react'
import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { RemapNotice } from './ui/RemapNotice'
import { Button } from './ui/Button'

const MAX_VISIBLE = 3

/**
 * In-flow stack of model-change notices at the top of a page column. Pass projectId to show only that
 * project's entries (project settings, org chart); omit it for App settings.
 */
export default function RemapNotices({ projectId }: { projectId?: string }): ReactElement | null {
  const notices = useAppStore((s) => s.remapNotices)
  const dismiss = useAppStore((s) => s.dismissRemapNotice)
  const undo = useAppStore((s) => s.undoRemap)
  const [all, setAll] = useState(false)

  const scoped = notices
    .map((n) => ({ ...n, projects: projectId ? n.projects.filter((p) => p.projectId === projectId) : n.projects }))
    .filter((n) => n.projects.length > 0)
  if (scoped.length === 0) return null
  const shown = all ? scoped : scoped.slice(0, MAX_VISIBLE)
  return (
    <div className="remap-stack">
      {shown.map((n) => (
        <RemapNotice
          key={n.id}
          title={`Models updated for ${n.projects.length} project${n.projects.length === 1 ? '' : 's'} ${n.cause}`}
          projects={n.projects}
          onUndo={(pid) => void undo(n.id, pid)}
          onDismiss={() => dismiss(n.id)}
        />
      ))}
      {scoped.length > MAX_VISIBLE && (
        <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `+${scoped.length - MAX_VISIBLE} more`}
        </Button>
      )}
    </div>
  )
}
