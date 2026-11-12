import { useEffect, type KeyboardEvent, type ReactElement } from 'react'
import { backToChat, dismissNavBanner, navBannerAnchor, useChangeWaiting, useNavBanner } from '../lib/useAppNavigate'
import { Banner } from './ui/Banner'
import { Button } from './ui/Button'

export const CHANGE_WAITING_TEXT = 'A change is waiting for you in the chat.'

/**
 * The visible line an agent's navigation leaves at the destination (UX self-help H2, docs/design/self-help.md):
 * "<agent> opened <path> for you." with Back to chat and Dismiss. One at a time; the next navigation replaces it,
 * Back and leaving the place clear it. A named region, not a live region: useAppNavigate announces the sentence
 * through the app's one status region, so it is read once. While the asking run has a decision card open the line
 * adds that a change is waiting and Back reads "Back to chat to decide" (re-walk M1). The banner sits above the page
 * heading in the DOM, so Tab from the heading the navigation landed on moves into it (M3), and Esc dismisses it.
 */
export default function AppNavigateBanner(): ReactElement | null {
  const banner = useNavBanner()
  const waiting = useChangeWaiting(banner?.runId)
  const seq = banner?.seq
  useEffect(() => {
    if (seq === undefined) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Tab' || e.shiftKey || e.defaultPrevented) return
      const anchor = navBannerAnchor()
      if (!anchor || document.activeElement !== anchor) return
      const first = document.querySelector<HTMLElement>('[data-testid=app-navigate-banner] button')
      if (!first) return
      e.preventDefault()
      first.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [seq])
  if (!banner) return null
  const runId = banner.runId
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      dismissNavBanner()
    }
  }
  return (
    <div className="app-navigate-banner" key={banner.seq} onKeyDown={onKeyDown}>
      <Banner
        tone="info"
        label="Opened for you"
        testId="app-navigate-banner"
        onDismiss={dismissNavBanner}
        actions={
          runId ? (
            <Button size="sm" variant={waiting ? 'primary' : undefined} testId="app-navigate-back" onClick={() => void backToChat(runId)}>
              {waiting ? 'Back to chat to decide' : 'Back to chat'}
            </Button>
          ) : undefined
        }
      >
        <span data-testid="app-navigate-text">{banner.message}</span>
        {waiting && (
          <>
            {' '}
            <span data-testid="app-navigate-waiting">{CHANGE_WAITING_TEXT}</span>
          </>
        )}
      </Banner>
    </div>
  )
}
