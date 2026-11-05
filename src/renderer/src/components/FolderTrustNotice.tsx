import type { ReactElement } from 'react'
import { useState } from 'react'
import type { Project } from '@shared/types'
import { Banner } from './ui/Banner'
import { Button } from './ui/Button'
import { useFolderTrustReview } from './settings/useFolderTrustReview'
import { openProjectSettings } from '../lib/openProjectSettings'
import { PROJECT_SETTINGS_SECTIONS } from '../lib/settingsTarget'
import {
  FOLDER_TRUST_NOTICE_TEXT,
  folderTrustState,
  readDismissedDigest,
  requestFolderTrustReview,
  showFolderTrustNotice,
  writeDismissedDigest
} from '../lib/folderTrust'

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
          <Button
            size="sm"
            testId="folder-trust-notice-review"
            onClick={() => {
              requestFolderTrustReview(project.id)
              openProjectSettings(project.id, PROJECT_SETTINGS_SECTIONS.permissions)
            }}
          >
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
      {FOLDER_TRUST_NOTICE_TEXT}
    </Banner>
  )
}
