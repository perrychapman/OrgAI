import type { ReactElement } from 'react'
import { backToChat, dismissNavBanner, useNavBanner } from '../lib/useAppNavigate'
import { Banner } from './ui/Banner'
import { Button } from './ui/Button'

/**
 * The visible line an agent's navigation leaves at the destination (UX self-help H2, docs/design/self-help.md):
 * "<agent> opened <path> for you." with Back to chat and Dismiss. One at a time; the next navigation replaces it,
 * Back and leaving the place clear it. A named region, not a live region: useAppNavigate announces the sentence
 * through the app's one status region, so it is read once.
 */
export default function AppNavigateBanner(): ReactElement | null {
  const banner = useNavBanner()
  if (!banner) return null
  const runId = banner.runId
  return (
    <div className="app-navigate-banner" key={banner.seq}>
      <Banner
        tone="info"
        label="Opened for you"
        testId="app-navigate-banner"
        onDismiss={dismissNavBanner}
        actions={
          runId ? (
            <Button size="sm" testId="app-navigate-back" onClick={() => void backToChat(runId)}>
              Back to chat
            </Button>
          ) : undefined
        }
      >
        <span data-testid="app-navigate-text">{banner.message}</span>
      </Banner>
    </div>
  )
}
