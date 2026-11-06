import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { ShieldQuestion } from 'lucide-react'
import type { Project } from '@shared/types'
import { Banner } from './ui/Banner'
import { Button } from './ui/Button'
import { Badge } from './ui/Badge'
import { useFolderTrustReview } from './settings/useFolderTrustReview'
import { openProjectSettings } from '../lib/openProjectSettings'
import { PROJECT_SETTINGS_SECTIONS } from '../lib/settingsTarget'
import {
  FOLDER_TRUST_CARD_LINE,
  folderTrustIgnored,
  folderTrustNoticeText,
  folderTrustState,
  hasFolderTrustField,
  readDismissedDigest,
  requestFolderTrustReview,
  showFolderTrustNotice,
  writeDismissedDigest
} from '../lib/folderTrust'

/** Open Settings > Permissions with the folder settings review dialog on top. */
export function openFolderTrustReview(projectId: string): void {
  requestFolderTrustReview(projectId)
  openProjectSettings(projectId, PROJECT_SETTINGS_SECTIONS.permissions)
}

/**
 * A quiet in-flow notice while agents ignore the folder's own settings. Never blocks starting a run; Review opens the
 * project's Permissions settings with the review dialog, Dismiss hides it for this digest only.
 */
export default function FolderTrustNotice({ project }: { project: Project }): ReactElement | null {
  const { review } = useFolderTrustReview(project)
  const [dismissed, setDismissed] = useState<{ id: string; digest: string | null }>(() => ({ id: project.id, digest: readDismissedDigest(project.id) }))
  const dismissedDigest = dismissed.id === project.id ? dismissed.digest : readDismissedDigest(project.id)
  // Wait for the review: its digest is what a dismissal is keyed by, and only it can say 'changed'.
  if (!review) return null
  const state = folderTrustState(project, review)
  if (!showFolderTrustNotice(state, review.digest, dismissedDigest)) return null
  return (
    <Banner
      tone="info"
      testId="folder-trust-notice"
      actions={
        <>
          <Button size="sm" testId="folder-trust-notice-review" onClick={() => openFolderTrustReview(project.id)}>
            Review
          </Button>
          <Button
            size="sm"
            variant="ghost"
            testId="folder-trust-notice-dismiss"
            onClick={() => {
              writeDismissedDigest(project.id, review.digest)
              setDismissed({ id: project.id, digest: review.digest })
              // The focused button unmounts: land on the page's prompt box, else its heading.
              setTimeout(() => document.querySelector<HTMLElement>('.new-run textarea, .new-run h1, .new-run h2')?.focus(), 0)
            }}
          >
            Dismiss
          </Button>
        </>
      }
    >
      {folderTrustNoticeText(state, review)}
    </Banner>
  )
}

/**
 * One quiet line for a permission card: while the folder's own settings are ignored, say so and link to the review. The
 * allow rules in them may be the very thing that would have answered this card.
 */
export function FolderTrustCardLine({ project }: { project: Project }): ReactElement | null {
  const { review } = useFolderTrustReview(project)
  if (!review || !folderTrustIgnored(folderTrustState(project, review))) return null
  return (
    <p className="perm-trust-line" data-testid="perm-trust-line">
      {FOLDER_TRUST_CARD_LINE}{' '}
      <button type="button" className="link-btn" data-testid="perm-trust-review" onClick={() => openFolderTrustReview(project.id)}>
        Review
      </button>
    </p>
  )
}

/**
 * A findable pointer in the project topbar while agents ignore the folder's settings, on every project view. It is not
 * dismissable: the New run notice is, this is only a small mark that stays until the user decides.
 */
export function FolderTrustPointer({ project, view }: { project: Project; view: string }): ReactElement | null {
  const { review, refresh } = useFolderTrustReview(project)
  // The topbar outlives the views: read the folder again when the user moves between them, so an edit made since the
  // allow ('changed') shows here too, not only on a page that mounts fresh.
  useEffect(() => {
    if (hasFolderTrustField(project)) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, project.id])
  if (!review || !folderTrustIgnored(folderTrustState(project, review))) return null
  return (
    <button
      type="button"
      className="topbar-needs topbar-trust"
      data-testid="topbar-folder-trust"
      title={`${FOLDER_TRUST_CARD_LINE} Review them.`}
      onClick={() => openFolderTrustReview(project.id)}
    >
      <Badge tone="info" icon={ShieldQuestion}>
        Folder settings ignored
      </Badge>
    </button>
  )
}
