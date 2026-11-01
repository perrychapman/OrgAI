import { describe, expect, it } from 'vitest'
import type { ConnectorInfo } from '@shared/types'
import { CONNECTORS } from '@shared/connectors'
import {
  accessWords,
  clampText,
  noteForUser,
  connectMissing,
  connectorInitial,
  filterConnectors,
  honestyNote,
  missingSentence,
  plainToolName,
  removeConsequence,
  roleAccessSummary,
  sortForGallery,
  stateChip
} from './connectors'

import { BRAND_GAPS, BRAND_MARKS, brandMark } from '../components/brand/brandMarks'

describe('brand marks', () => {
  it('every connector and provider id has a mark or is a listed gap', () => {
    for (const id of [...CONNECTORS.map((c) => c.id), 'anthropic', 'openai', 'litellm']) {
      expect(brandMark(id) !== null || (BRAND_GAPS as readonly string[]).includes(id), id).toBe(true)
    }
  })
  it('path data is non-empty SVG path characters and colours are hex', () => {
    for (const [id, m] of Object.entries(BRAND_MARKS)) {
      expect(m.d.length, id).toBeGreaterThan(20)
      for (const d of [m.d, ...(m.extra ?? []).map((p) => p.d)]) expect(d, id).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/)
      for (const h of [m.hex, ...(m.extra ?? []).map((p) => p.hex)]) if (h !== null) expect(h, id).toMatch(/^#[0-9A-F]{6}$/)
      if (m.viewBox) expect(m.viewBox, id).toMatch(/^0 0 \d+ \d+$/)
    }
  })
  it('gaps have no mark', () => {
    for (const id of BRAND_GAPS) expect(brandMark(id)).toBeNull()
  })
})

const info = (i: number, state: ConnectorInfo['state']): ConnectorInfo => ({ connector: CONNECTORS[i], state })

describe('connectors lib', () => {
  it('chips say words', () => {
    expect(stateChip(info(0, 'available')).label).toBe('Not connected')
    expect(stateChip(info(0, 'needsSetup')).label).toBe('Not signed in')
    expect(stateChip(info(0, 'error')).tone).toBe('danger')
    expect(stateChip(info(0, 'connected')).label).toBe('Connected')
  })
  it('names the account', () => {
    const c = { ...info(0, 'connected'), library: { auth: { state: 'authorized', account: 'a@b.c' } } } as unknown as ConnectorInfo
    expect(stateChip(c).label).toBe('Connected as a@b.c')
  })
  it('initials', () => {
    expect(connectorInitial({ name: 'Slack' })).toBe('S')
    expect(connectorInitial({ name: 'Google Drive' })).toBe('GD')
  })
  it('access words', () => {
    expect(accessWords({ readOnly: true })).toBe('Can read')
    expect(accessWords({ readOnly: false })).toBe('Can read and change')
  })
  it('lists what is missing per auth kind', () => {
    expect(connectMissing({ kind: 'oauth' }, { clientId: '', clientSecret: '', token: '' })).toEqual([])
    const oc = { kind: 'oauthClient', consoleUrl: 'https://x.y', clientSecret: 'required' } as const
    expect(connectMissing(oc, { clientId: ' ', clientSecret: '', token: '' })).toEqual(['Client ID', 'Client secret'])
    expect(connectMissing({ ...oc, clientSecret: 'optional' }, { clientId: 'a', clientSecret: '', token: '' })).toEqual([])
    const t = { kind: 'token', header: 'Authorization', label: 'Access token', help: '' } as const
    expect(connectMissing(t, { clientId: '', clientSecret: '', token: '' })).toEqual(['Access token'])
    expect(missingSentence(['Client ID', 'Client secret'])).toBe('Add the Client ID and Client secret to continue.')
    expect(missingSentence([])).toBe('')
  })
  it('honesty note', () => {
    expect(honestyNote({ status: 'preview', verified: false })).toMatch(/not yet tested/)
    expect(honestyNote({ status: 'stable', verified: true })).toBeUndefined()
  })
  it('plain tool names', () => {
    expect(plainToolName('search_messages')).toBe('Search messages')
    expect(plainToolName('listIssues')).toBe('List issues')
    expect(plainToolName('mcp__slack__send_message')).toBe('Send message')
  })
  it('names roles', () => {
    const roles = [
      { slug: 'a', name: 'Reviewer' },
      { slug: 'b', name: 'Researcher' },
      { slug: 'c', name: 'Lead' }
    ]
    expect(roleAccessSummary(roles, undefined)).toBe('All roles')
    expect(roleAccessSummary(roles, ['a', 'b'])).toBe('Reviewer, Researcher')
    expect(roleAccessSummary(roles, [])).toBe('No roles')
    expect(roleAccessSummary([], undefined)).toBe('No roles yet')
  })
  it('sorts connected first and filters', () => {
    const list = [info(0, 'available'), info(1, 'connected'), info(2, 'needsSetup')]
    expect(sortForGallery(list).map((i) => i.state)).toEqual(['connected', 'needsSetup', 'available'])
    expect(filterConnectors(list, CONNECTORS[1].name.toLowerCase()).length).toBeGreaterThan(0)
    expect(filterConnectors(list, 'zzzz-none')).toEqual([])
  })
  it('consequence names projects', () => {
    expect(removeConsequence([{ projectName: 'Acme' }], 'remove')).toContain('Acme will lose access')
    expect(removeConsequence([], 'disconnect')).toContain('No project')
  })
})

describe('clampText', () => {
  it('keeps short text and clamps long text with an ellipsis', () => {
    expect(clampText('abc', 5)).toBe('abc')
    expect(clampText('abcdef', 4)).toBe('abc…')
    expect(Array.from(clampText('x'.repeat(500), 200))).toHaveLength(200)
    expect(clampText('abc', 0)).toBe('')
  })
})

describe('noteForUser', () => {
  it('hides developer caveats and implementation details', () => {
    expect(noteForUser(['Unverified: dynamic client registration.', 'The token is stored with Electron safeStorage and sent as Authorization: Bearer.'], 'X')).toEqual([])
  })
  it('puts the redirect caveat first in plain words and keeps useful notes', () => {
    const out = noteForUser(['The server includes write tools.', 'Slack documents that redirect URLs must use HTTPS. Unverified.', 'Unverified: the token response shape.'], 'Slack')
    expect(out).toEqual(["Slack may refuse OrgAI's sign-in address or need an admin's approval.", 'The server includes write tools.'])
    expect(noteForUser(undefined, 'X')).toEqual([])
  })
})
