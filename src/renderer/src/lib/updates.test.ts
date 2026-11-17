import { describe, expect, it } from 'vitest'
import type { UpdateActionResult, UpdateCapabilityReason, UpdateState, UpdateStatus } from '@shared/types'
import { UPDATE_RELEASES_URL } from '@shared/types'
import {
  activeRunsConfirmBody,
  canRetryDownload,
  capabilityNote,
  lastCheckedLine,
  progressBytes,
  progressPercent,
  refusalSentence,
  updateAction,
  updateAnnouncement,
  updateNotice,
  updateStatusLine
} from './updates'

const base = (over: Partial<UpdateState> = {}): UpdateState => ({ capability: 'auto', status: 'idle', currentVersion: '0.9.0', releaseUrl: UPDATE_RELEASES_URL, ...over })
const MB = 1024 * 1024

describe('updateStatusLine', () => {
  it('says something for every status', () => {
    const lines: Record<UpdateStatus, string> = {
      idle: 'Not checked yet.',
      checking: 'Checking for updates…',
      'up-to-date': 'OrgAI 0.9.0 is up to date.',
      available: 'Version 99.0.0 is available.',
      downloading: 'Downloading version 99.0.0: 35%.',
      downloaded: 'Version 99.0.0 is ready. Restart to install it now, or it installs the next time OrgAI quits.',
      error: 'You appear to be offline.'
    }
    for (const [status, line] of Object.entries(lines) as [UpdateStatus, string][]) {
      const s = base({ status, availableVersion: status === 'up-to-date' || status === 'idle' || status === 'error' ? undefined : '99.0.0', progress: { percent: 35.4, transferredBytes: 35 * MB, totalBytes: 100 * MB }, error: status === 'error' ? 'You appear to be offline.' : undefined })
      expect(updateStatusLine(s)).toBe(line)
    }
  })
  it('names the version when a download failed (a check failure stays the plain sentence)', () => {
    expect(updateStatusLine(base({ status: 'error', availableVersion: '99.0.0', error: 'OrgAI could not reach GitHub.' }))).toBe('Could not download version 99.0.0. OrgAI could not reach GitHub.')
    expect(updateStatusLine(base({ capability: 'manual', reason: 'platform', status: 'error', availableVersion: '99.0.0', error: 'X.' }))).toBe('X.')
  })
  it('falls back when an error has no text and when no version is known', () => {
    expect(updateStatusLine(base({ status: 'error' }))).toBe('The update did not work.')
    expect(updateStatusLine(base({ status: 'available' }))).toBe('A new version is available.')
  })
  it('explains capability none by reason, and installing wins over the status', () => {
    expect(updateStatusLine(base({ capability: 'none', reason: 'dev' }))).toBe('Updates are not available in a development build.')
    expect(updateStatusLine(base({ capability: 'none', reason: 'test' }))).toBe('Updates are not available in a test build.')
    expect(updateStatusLine(base({ capability: 'none' }))).toBe('Updates are not available in this build.')
    expect(updateStatusLine(base({ status: 'downloaded', availableVersion: '99.0.0', installing: true }))).toBe('Restarting to install version 99.0.0…')
  })
})

describe('capabilityNote', () => {
  it('has a sentence for every reason and none for auto', () => {
    for (const r of ['dev', 'test', 'portable', 'unpacked', 'platform'] as UpdateCapabilityReason[]) expect(capabilityNote(r)).toMatch(/\.$/)
    expect(capabilityNote('portable')).toMatch(/release page/)
    expect(capabilityNote(undefined)).toBe('')
  })
})

describe('updateAction', () => {
  it('follows the state with auto', () => {
    expect(updateAction(base())).toEqual({ kind: 'check', label: 'Check for updates', busy: false })
    expect(updateAction(base({ status: 'checking' }))).toMatchObject({ kind: 'check', busy: true })
    expect(updateAction(base({ status: 'up-to-date' }))).toMatchObject({ kind: 'check', label: 'Check for updates' })
    expect(updateAction(base({ status: 'available', availableVersion: '99.0.0' }))).toMatchObject({ kind: 'download', label: 'Download update', busy: false })
    expect(updateAction(base({ status: 'downloading', availableVersion: '99.0.0' }))).toMatchObject({ kind: 'download', busy: true })
    expect(updateAction(base({ status: 'downloaded', availableVersion: '99.0.0' }))).toMatchObject({ kind: 'install', label: 'Restart and install', busy: false })
    expect(updateAction(base({ status: 'downloaded', availableVersion: '99.0.0', installing: true }))).toMatchObject({ kind: 'install', busy: true })
  })
  it('retries a failed download, else checks again', () => {
    const failedDownload = base({ status: 'error', availableVersion: '99.0.0', error: 'x' })
    expect(canRetryDownload(failedDownload)).toBe(true)
    expect(updateAction(failedDownload)).toMatchObject({ kind: 'download', label: 'Retry download' })
    expect(updateAction(base({ status: 'error', error: 'x' }))).toMatchObject({ kind: 'check', label: 'Check again' })
  })
  it('never offers download or install with manual, and nothing with none', () => {
    const m = (status: UpdateStatus): UpdateState => base({ capability: 'manual', reason: 'platform', status, availableVersion: '99.0.0' })
    for (const status of ['idle', 'checking', 'up-to-date', 'available', 'downloading', 'downloaded', 'error'] as UpdateStatus[]) {
      expect(['check', 'open-release']).toContain(updateAction(m(status)).kind)
    }
    expect(updateAction(m('available'))).toMatchObject({ kind: 'open-release', label: 'Open release page' })
    expect(canRetryDownload(m('error'))).toBe(false)
    expect(updateAction(base({ capability: 'none', reason: 'dev' })).kind).toBe('none')
  })
})

describe('progress', () => {
  it('clamps and rounds the percent and shows whole megabytes', () => {
    expect(progressPercent(undefined)).toBe(0)
    expect(progressPercent({ percent: 120, transferredBytes: 0, totalBytes: 0 })).toBe(100)
    expect(progressPercent({ percent: Number.NaN, transferredBytes: 0, totalBytes: 0 })).toBe(0)
    expect(progressBytes({ percent: 60, transferredBytes: 60 * MB, totalBytes: 100 * MB })).toBe('60 MB of 100 MB')
    expect(progressBytes({ percent: 60, transferredBytes: 60, totalBytes: 0 })).toBe('')
  })
})

describe('refusals and the confirmation', () => {
  it('has a plain sentence for every refusal', () => {
    const cases: [UpdateActionResult, RegExp][] = [
      [{ ok: false, reason: 'active-runs', activeRuns: 2 }, /2 working runs would stop/],
      [{ ok: false, reason: 'active-runs' }, /runs are still working/],
      [{ ok: false, reason: 'not-downloaded' }, /not been downloaded/],
      [{ ok: false, reason: 'not-available' }, /Check for updates first/],
      [{ ok: false, reason: 'unsupported' }, /release page/],
      [{ ok: false, reason: 'quitting' }, /already closing/]
    ]
    for (const [r, re] of cases) expect(refusalSentence(r)).toMatch(re)
    expect(refusalSentence({ ok: true })).toBe('')
  })
  it('says how many runs stop and that they stay continuable', () => {
    expect(activeRunsConfirmBody(1)).toBe('Installing restarts OrgAI and stops 1 working run. They stay in History and can be continued, as after Quit.')
    expect(activeRunsConfirmBody(3)).toMatch(/stops 3 working runs/)
    expect(activeRunsConfirmBody(undefined)).toMatch(/stops the working runs/)
  })
})

describe('lastCheckedLine', () => {
  it('is empty before the first check', () => {
    expect(lastCheckedLine(base())).toBe('')
    expect(lastCheckedLine(base({ checkedAt: Date.UTC(2026, 10, 17, 12, 0) }))).toMatch(/^Last checked \d{1,2} Nov 2026 \d\d:\d\d$/)
  })
})

describe('updateAnnouncement', () => {
  const p = (percent: number): UpdateState => base({ status: 'downloading', availableVersion: '99.0.0', progress: { percent, transferredBytes: 0, totalBytes: 0 } })
  it('speaks on status changes and once at halfway, never per step', () => {
    expect(updateAnnouncement(null, base({ status: 'up-to-date' }))).toBe('OrgAI 0.9.0 is up to date.')
    expect(updateAnnouncement(base({ status: 'checking' }), base({ status: 'checking' }))).toBe('')
    expect(updateAnnouncement(base({ status: 'available', availableVersion: '99.0.0' }), p(10))).toBe('Downloading version 99.0.0.')
    expect(updateAnnouncement(p(10), p(35))).toBe('')
    expect(updateAnnouncement(p(35), p(60))).toBe('Download halfway.')
    expect(updateAnnouncement(p(60), p(85))).toBe('')
    expect(updateAnnouncement(p(100), base({ status: 'downloaded', availableVersion: '99.0.0' }))).toBe('Version 99.0.0 is downloaded. Restart and install is ready.')
    expect(updateAnnouncement(base({ status: 'downloaded', availableVersion: '99.0.0' }), base({ status: 'downloaded', availableVersion: '99.0.0', installing: true }))).toBe('Restarting to install version 99.0.0…')
    expect(updateAnnouncement(base({ status: 'checking' }), base({ status: 'idle' }))).toBe('')
  })
})

describe('updateNotice', () => {
  it('shows for a newer version until dismissed for that version', () => {
    const avail = base({ status: 'available', availableVersion: '99.0.0' })
    expect(updateNotice(avail, null)).toEqual({ text: 'Update available: 99.0.0', version: '99.0.0' })
    expect(updateNotice(avail, '99.0.0')).toBeNull()
    expect(updateNotice(base({ status: 'available', availableVersion: '99.1.0' }), '99.0.0')).not.toBeNull()
    expect(updateNotice(base({ status: 'downloaded', availableVersion: '99.0.0' }), null)?.text).toBe('Update ready: 99.0.0')
    expect(updateNotice(base({ capability: 'manual', reason: 'platform', status: 'available', availableVersion: '99.0.0' }), null)?.text).toBe('Update available: 99.0.0')
  })
  it('stays away otherwise', () => {
    expect(updateNotice(null, null)).toBeNull()
    expect(updateNotice(base({ status: 'up-to-date' }), null)).toBeNull()
    expect(updateNotice(base({ status: 'error', availableVersion: '99.0.0' }), null)).toBeNull()
    expect(updateNotice(base({ status: 'downloaded', availableVersion: '99.0.0', installing: true }), null)).toBeNull()
    expect(updateNotice(base({ capability: 'none', reason: 'dev', status: 'available', availableVersion: '99.0.0' }), null)).toBeNull()
  })
})
