/**
 * Pure helpers for the desktop updater UI (App settings > About > Updates and the sidebar notice;
 * docs/agent-notes/updates.md "Renderer"). Everything here maps an `UpdateState` from main to words and one action;
 * nothing reads the DOM or calls IPC, so `updates.test.ts` covers every status, capability and refusal.
 */
import type { UpdateActionResult, UpdateCapabilityReason, UpdateProgress, UpdateState } from '@shared/types'
import { formatDateTime } from '@shared/view/dates'

/** The one primary action the Updates block offers for a state. */
export type UpdateActionKind = 'check' | 'download' | 'open-release' | 'install' | 'none'

export interface UpdateActionView {
  kind: UpdateActionKind
  label: string
  /** True while a step is under way: the button stays focusable but does nothing (aria-disabled). */
  busy: boolean
}

/** Why a build cannot install updates itself (capability 'manual' or 'none'), as one plain sentence. */
export function capabilityNote(reason: UpdateCapabilityReason | undefined): string {
  switch (reason) {
    case 'dev':
      return 'Updates are not available in a development build.'
    case 'test':
      return 'Updates are not available in a test build.'
    case 'portable':
      return 'This portable copy is updated by hand: OrgAI checks for new versions, and you download the new copy from the release page.'
    case 'unpacked':
      return 'This copy was not set up with the installer, so it is updated by hand: OrgAI checks for new versions, and you download them from the release page.'
    case 'platform':
      return 'On this system OrgAI is updated by hand: it checks for new versions, and you download and install them from the release page.'
    default:
      return ''
  }
}

/** "35 MB of 100 MB" (whole megabytes; '' when the total is unknown). */
export function progressBytes(p: UpdateProgress | undefined): string {
  if (!p || !(p.totalBytes > 0)) return ''
  const mb = (n: number): string => `${Math.max(0, Math.round(n / (1024 * 1024)))} MB`
  return `${mb(p.transferredBytes)} of ${mb(p.totalBytes)}`
}

/** A whole percent in 0..100 (0 for a missing or unusable value). */
export function progressPercent(p: UpdateProgress | undefined): number {
  const v = p?.percent
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.min(100, Math.max(0, Math.round(v)))
}

const versionOf = (s: UpdateState): string => (s.availableVersion ? `Version ${s.availableVersion}` : 'A new version')

/** The status line under "Updates": one sentence for every status (and capability 'none'). */
export function updateStatusLine(s: UpdateState): string {
  if (s.installing) return `Restarting to install ${versionOf(s).toLowerCase()}…`
  if (s.capability === 'none') return capabilityNote(s.reason) || 'Updates are not available in this build.'
  switch (s.status) {
    case 'idle':
      return 'Not checked yet.'
    case 'checking':
      return 'Checking for updates…'
    case 'up-to-date':
      return `OrgAI ${s.currentVersion} is up to date.`
    case 'available':
      return `${versionOf(s)} is available.`
    case 'downloading':
      return `Downloading ${versionOf(s).toLowerCase()}: ${progressPercent(s.progress)}%.`
    case 'downloaded':
      return `${versionOf(s)} is ready. Restart to install it now, or it installs the next time OrgAI quits.`
    case 'error':
      // A failed download keeps the version: say which step failed.
      if (canRetryDownload(s)) return `Could not download version ${s.availableVersion}. ${s.error || 'The download failed.'}`
      return s.error || 'The update did not work.'
  }
}

/** "Last checked 17 Nov 2026 11:46", or '' before the first finished check. */
export function lastCheckedLine(s: UpdateState): string {
  const when = formatDateTime(s.checkedAt)
  return when ? `Last checked ${when}` : ''
}

/** A failed download keeps `availableVersion`, so it can be retried (types.ts UpdateStatus). */
export function canRetryDownload(s: UpdateState): boolean {
  return s.capability === 'auto' && s.status === 'error' && !!s.availableVersion
}

/** The one primary action that follows the state. */
export function updateAction(s: UpdateState): UpdateActionView {
  if (s.capability === 'none') return { kind: 'none', label: '', busy: false }
  if (s.installing) return { kind: 'install', label: 'Restarting…', busy: true }
  // 'manual' never downloads or installs here: a known version leads to the release page, anything else to a check.
  if (s.capability === 'manual') {
    if (s.status === 'checking') return { kind: 'check', label: 'Checking…', busy: true }
    if (s.availableVersion && s.status !== 'up-to-date' && s.status !== 'error') return { kind: 'open-release', label: 'Open release page', busy: false }
    return { kind: 'check', label: s.status === 'error' ? 'Check again' : 'Check for updates', busy: false }
  }
  switch (s.status) {
    case 'checking':
      return { kind: 'check', label: 'Checking…', busy: true }
    case 'available':
      return { kind: 'download', label: 'Download update', busy: false }
    case 'downloading':
      return { kind: 'download', label: 'Downloading…', busy: true }
    case 'downloaded':
      return { kind: 'install', label: 'Restart and install', busy: false }
    case 'error':
      return canRetryDownload(s) ? { kind: 'download', label: 'Retry download', busy: false } : { kind: 'check', label: 'Check again', busy: false }
    default:
      return { kind: 'check', label: 'Check for updates', busy: false }
  }
}

/** "1 working run" / "3 working runs". */
export function runsPhrase(n: number): string {
  return `${n} working run${n === 1 ? '' : 's'}`
}

/** The body of the install confirmation when runs are live. */
export function activeRunsConfirmBody(n: number | undefined): string {
  const runs = typeof n === 'number' && n > 0 ? runsPhrase(n) : 'the working runs'
  return `Installing restarts OrgAI and stops ${runs}. They stay in History and can be continued, as after Quit.`
}

/** A plain sentence for a refused download or install ('' for ok). 'active-runs' is normally answered by the confirmation. */
export function refusalSentence(r: UpdateActionResult): string {
  if (r.ok) return ''
  switch (r.reason) {
    case 'active-runs':
      return typeof r.activeRuns === 'number' && r.activeRuns > 0
        ? `Not installed: ${runsPhrase(r.activeRuns)} would stop. Try again when you are ready.`
        : 'Not installed: runs are still working. Try again when you are ready.'
    case 'not-downloaded':
      return 'The update has not been downloaded yet. Download it first.'
    case 'not-available':
      return 'No newer version is known yet. Check for updates first.'
    case 'unsupported':
      return 'This copy cannot update itself. Use the release page instead.'
    case 'quitting':
      return 'OrgAI is already closing.'
    default:
      return 'The update did not work.'
  }
}

/**
 * The polite announcement for a state change (one sentence), or '' when nothing worth saying changed. Progress is
 * announced only when it crosses 50 percent, never on every step.
 */
export function updateAnnouncement(prev: UpdateState | null, next: UpdateState): string {
  if (next.installing && !prev?.installing) return updateStatusLine(next)
  if (prev && prev.status === next.status) {
    if (next.status === 'downloading' && progressPercent(prev.progress) < 50 && progressPercent(next.progress) >= 50) return 'Download halfway.'
    if (next.status === 'error' && prev.error !== next.error) return updateStatusLine(next)
    return ''
  }
  switch (next.status) {
    case 'idle':
      return ''
    case 'downloading':
      return `Downloading ${versionOf(next).toLowerCase()}.`
    case 'downloaded':
      return `${versionOf(next)} is downloaded. Restart and install is ready.`
    default:
      return updateStatusLine(next)
  }
}

/** What the sidebar notice says, or null when it should not show (no newer version, or dismissed for this version). */
export function updateNotice(s: UpdateState | null, dismissedVersion: string | null): { text: string; version: string } | null {
  if (!s || s.capability === 'none' || s.installing || !s.availableVersion) return null
  if (s.availableVersion === dismissedVersion) return null
  if (s.status === 'downloaded' && s.capability === 'auto') return { text: `Update ready: ${s.availableVersion}`, version: s.availableVersion }
  if (s.status === 'available' || s.status === 'downloading' || s.status === 'downloaded') return { text: `Update available: ${s.availableVersion}`, version: s.availableVersion }
  return null
}
