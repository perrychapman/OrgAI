import { describe, expect, it } from 'vitest'
import type { FolderConfigReview, Project } from '@shared/types'
import {
  canAccept,
  canRevoke,
  filesSummary,
  folderTrustDismissKey,
  folderTrustState,
  folderTrustSentence,
  folderTrustSummary,
  hasContent,
  hasFolderTrustField,
  hiddenBadgeText,
  isLongText,
  itemBadges,
  readDismissedDigest,
  reviewSections,
  showFolderTrustNotice,
  writeDismissedDigest
} from './folderTrust'

const D1 = 'a'.repeat(64)
const D2 = 'b'.repeat(64)

function review(over: Partial<FolderConfigReview> = {}): FolderConfigReview {
  return { projectId: 'p', state: 'untrusted', digest: D1, files: [], commands: [], env: [], allowRules: [], mcpServers: [], otherSettings: [], truncated: false, ...over }
}

function memory(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

describe('state', () => {
  it('prefers the fetched review, then the stored field, then none', () => {
    const p = { folderConfigTrust: { state: 'trusted' as const } }
    expect(folderTrustState(p, review({ state: 'changed' }))).toBe('changed')
    expect(folderTrustState(p, null)).toBe('trusted')
    expect(folderTrustState({}, null)).toBe('none')
  })
  it('gates code projects with the field only', () => {
    expect(hasFolderTrustField({ folderConfigTrust: { state: 'untrusted' } } as Project)).toBe(true)
    expect(hasFolderTrustField({} as Project)).toBe(false)
    expect(hasFolderTrustField({ kind: 'engagement', folderConfigTrust: { state: 'untrusted' } } as Project)).toBe(false)
    expect(hasFolderTrustField(null)).toBe(false)
  })
  it('has a sentence per state', () => {
    expect(folderTrustSentence('untrusted')).toBe("Agents are ignoring this folder's own settings until you allow them.")
    expect(folderTrustSentence('changed')).toMatch(/changed since you allowed them/)
    expect(folderTrustSentence('trusted', '2026-11-04T10:00:00.000Z')).toMatch(/^Agents use this folder's own settings\. Allowed \d{1,2} \w{3} 2026\.$/)
    expect(folderTrustSentence('trusted')).toBe("Agents use this folder's own settings.")
    expect(folderTrustSentence('trusted', 'junk')).toBe("Agents use this folder's own settings.")
    expect(folderTrustSentence('none')).toBe('')
    expect(folderTrustSummary('none')).toBe('')
    expect(folderTrustSummary('changed')).not.toBe('')
  })
})

describe('notice', () => {
  it('shows only while ignored and not dismissed for this digest', () => {
    expect(showFolderTrustNotice('untrusted', D1, null)).toBe(true)
    expect(showFolderTrustNotice('changed', D1, D1)).toBe(false)
    expect(showFolderTrustNotice('changed', D2, D1)).toBe(true)
    expect(showFolderTrustNotice('trusted', D1, null)).toBe(false)
    expect(showFolderTrustNotice('none', undefined, null)).toBe(false)
  })
  it('stores the dismissed digest per project', () => {
    const s = memory()
    expect(readDismissedDigest('p1', s)).toBeNull()
    writeDismissedDigest('p1', D1, s)
    expect(readDismissedDigest('p1', s)).toBe(D1)
    expect(readDismissedDigest('p2', s)).toBeNull()
    expect(folderTrustDismissKey('p1')).not.toBe(folderTrustDismissKey('p2'))
  })
  it('drops junk and refuses to store a non-digest', () => {
    const s = memory()
    s.data.set(folderTrustDismissKey('p1'), 'nope')
    expect(readDismissedDigest('p1', s)).toBeNull()
    writeDismissedDigest('p1', 'short', s)
    expect(s.data.get(folderTrustDismissKey('p1'))).toBe('nope')
    expect(readDismissedDigest('p1', null)).toBeNull()
  })
})

describe('review parts', () => {
  it('orders sections and leaves empty ones out', () => {
    const r = review({
      files: [{ path: 'a', effect: 'tools', kind: 'file', sizeBytes: 1, digested: true }],
      allowRules: [{ source: 's', rule: 'Bash(ls:*)' }],
      commands: [{ source: 's', kind: 'hook', label: 'PreToolUse', command: 'x' }]
    })
    expect(reviewSections(r).map((s) => s.key)).toEqual(['commands', 'allowRules', 'files'])
    expect(hasContent(r, 'env')).toBe(false)
    expect(hasContent(r, 'commands')).toBe(true)
  })
  it('reads badges', () => {
    expect(itemBadges({ masked: true, hiddenChar: 'U+202E' })).toEqual({ masked: true, hidden: 'U+202E' })
    expect(itemBadges({})).toEqual({ masked: false, hidden: null })
    expect(hiddenBadgeText('U+200B')).toContain('U+200B')
  })
  it('offers Accept only for a reviewable, not yet allowed config', () => {
    expect(canAccept(review())).toBe(true)
    expect(canAccept(review({ state: 'changed' }))).toBe(true)
    expect(canAccept(review({ state: 'trusted' }))).toBe(false)
    expect(canAccept(review({ unreviewable: 'Too large.' }))).toBe(false)
    expect(canAccept(null)).toBe(false)
    expect(canRevoke(review({ state: 'trusted' }))).toBe(true)
    expect(canRevoke(review())).toBe(false)
  })
  it('says which files are not checked', () => {
    const f = (digested: boolean) => ({ path: 'p', effect: 'tools' as const, kind: 'file' as const, sizeBytes: 1, digested })
    expect(filesSummary({ files: [f(true), f(false)] })).toMatch(/1 checked.*other 1.*can change while you trust/)
    expect(filesSummary({ files: [f(true)] })).toBe('1 file, 1 checked for changes.')
  })
  it('clamps long text', () => {
    expect(isLongText('short')).toBe(false)
    expect(isLongText('x'.repeat(601))).toBe(true)
    expect(isLongText('a\n'.repeat(11))).toBe(true)
  })
})
