import { describe, expect, it } from 'vitest'
import type { ConnectorInfo } from '@shared/types'
import {
  CATEGORY_GROUP_THRESHOLD,
  capList,
  dialogTitle,
  filterConnectors,
  gallerySections,
  infoEase,
  matchRank,
  serviceCount,
  sortForGallery,
  tileAction
} from './connectors'

type Kind = 'oauth' | 'token' | 'oauthClient' | 'none'

const make = (id: string, name: string, kind: Kind, extra: Record<string, unknown> = {}, state: ConnectorInfo['state'] = 'available', connectedAt?: number): ConnectorInfo => {
  const auth =
    kind === 'token'
      ? { kind, header: 'Authorization', label: 'Token', help: '' }
      : kind === 'oauthClient'
        ? { kind, consoleUrl: 'https://x.y', clientSecret: 'required' }
        : { kind }
  return {
    connector: {
      id,
      name,
      vendor: name,
      publisher: 'official',
      category: 'dev',
      description: `About ${name}`,
      status: 'stable',
      docsUrl: 'https://x.y',
      variants: [{ id: 'v', label: 'V', transport: 'http', url: 'https://x.y', readOnly: true, auth }],
      defaultVariant: 'v',
      setup: [],
      verified: true,
      ...extra
    },
    state,
    connectedAt
  } as unknown as ConnectorInfo
}

describe('ease, order and search at scale', () => {
  const list = [
    make('own', 'Alpha', 'oauthClient'),
    make('tok', 'Beta', 'token'),
    make('sign', 'Zeta', 'oauth'),
    make('open', 'Yota', 'none'),
    make('old', 'Mu', 'oauth', {}, 'connected', 100),
    make('new', 'Nu', 'oauth', {}, 'connected', 200),
    make('half', 'Xi', 'oauth', {}, 'needsSetup')
  ]
  it('derives the method and the button words from the variant', () => {
    expect(list.map(infoEase)).toEqual(['ownApp', 'token', 'signIn', 'none', 'signIn', 'signIn', 'signIn'])
    expect(tileAction(list[2])).toEqual({ label: 'Sign in', aria: 'Sign in with Zeta', primary: true })
    expect(tileAction(list[3])).toMatchObject({ label: 'Add', primary: true })
    expect(tileAction(list[1])).toMatchObject({ label: 'Add token', primary: false })
    expect(tileAction(list[0])).toMatchObject({ label: 'Set up', primary: false })
    expect(tileAction(list[4]).label).toBe('Manage')
    expect(tileAction(list[6]).label).toBe('Finish setup')
  })
  it('sorts connected by recency, then easy sign-in, tokens, own app, by name', () => {
    expect(sortForGallery(list).map((i) => i.connector.id)).toEqual(['new', 'old', 'half', 'open', 'sign', 'tok', 'own'])
  })
  it('ranks name matches before alias and description matches', () => {
    const docs = make('gd', 'Google Docs', 'oauthClient', { aliases: ['documents'] })
    const notion = make('n', 'Notion', 'oauth', { description: 'Read your docs and pages' })
    const drive = make('dr', 'Drive', 'oauthClient', { aliases: ['docs'] })
    expect(filterConnectors([notion, drive, docs], 'doc').map((i) => i.connector.id)).toEqual(['gd', 'dr', 'n'])
    expect(matchRank(docs.connector, 'google docs')).toBe(1)
    expect(matchRank(docs.connector, 'zzz')).toBeNull()
    expect(filterConnectors([notion], 'mail')).toEqual([])
  })
  it('counts in words', () => {
    expect(serviceCount(0)).toBe('No services')
    expect(serviceCount(1)).toBe('1 service')
    expect(serviceCount(12)).toBe('12 services')
  })
  it('sections: connected first, grouped by effort past the threshold, flat for a query or filter', () => {
    expect(gallerySections(list, { query: '', filter: 'all' }).map((s) => s.title)).toEqual(['Connected', 'Available'])
    const many = Array.from({ length: CATEGORY_GROUP_THRESHOLD + 1 }, (_, i) => make(`s${i}`, `Svc ${String(i).padStart(2, '0')}`, 'oauth', { category: i % 2 ? 'chat' : 'email' }))
    expect(gallerySections(many, { query: '', filter: 'all' }).map((s) => s.title)).toEqual(['Easy sign-in'])
    const mixed = [...many, make('t', 'Tok', 'token'), make('o', 'Own', 'oauthClient'), make('c', 'Conn', 'oauth', {}, 'connected', 5)]
    expect(gallerySections(mixed, { query: '', filter: 'all' }).map((s) => s.title)).toEqual(['Connected', 'Easy sign-in', 'Needs a token', 'Needs your own app'])
    expect(gallerySections(many, { query: 'svc 01', filter: 'all' })).toHaveLength(1)
    expect(gallerySections(many, { query: '', filter: 'chat' })[0].items.every((i) => i.connector.category === 'chat')).toBe(true)
    expect(gallerySections(list, { query: '', filter: 'easy' })[0].items.map((i) => i.connector.id)).not.toContain('tok')
    expect(gallerySections(list, { query: 'nothing-here', filter: 'all' })).toEqual([])
  })
  it('puts no-sign-in services before sign-in ones, then by name', () => {
    const l = [make('a', 'Aaa', 'oauth'), make('b', 'Bbb', 'none'), make('c', 'Ccc', 'oauth'), make('d', 'Ddd', 'none')]
    expect(sortForGallery(l).map((i) => i.connector.id)).toEqual(['b', 'd', 'a', 'c'])
  })
  it('search knows the ease labels', () => {
    const l = [make('a', 'Aaa', 'oauth'), make('b', 'Bbb', 'none'), make('t', 'Ttt', 'token'), make('o', 'Ooo', 'oauthClient')]
    const ids = (q: string): string[] => filterConnectors(l, q).map((i) => i.connector.id)
    expect(ids('sign in')).toEqual(expect.arrayContaining(['a', 'b']))
    expect(ids('sign in')[0]).toBe('a')
    expect(ids('no sign-in')).toEqual(['b'])
    expect(ids('token')).toEqual(['t'])
    expect(ids('own app')).toEqual(['o'])
  })
  it('Easy sign-in combines with a category', () => {
    const l = [make('a', 'Aaa', 'oauth', { category: 'chat' }), make('b', 'Bbb', 'oauth', { category: 'email' }), make('t', 'Ttt', 'token', { category: 'chat' })]
    const ids = gallerySections(l, { query: '', filter: 'chat', easy: true })[0].items.map((i) => i.connector.id)
    expect(ids).toEqual(['a'])
  })
  it('caps lists and titles the dialog by method', () => {
    expect(capList([1, 2, 3, 4, 5, 6, 7], 5)).toEqual({ shown: [1, 2, 3, 4, 5], more: 2 })
    expect(capList([1], 5)).toEqual({ shown: [1], more: 0 })
    expect(dialogTitle({ name: 'Notion' }, 'signIn', false)).toBe('Sign in with Notion')
    expect(dialogTitle({ name: 'DeepWiki' }, 'none', false)).toBe('Add DeepWiki')
    expect(dialogTitle({ name: 'Notion' }, 'signIn', true)).toBe('Notion')
  })
})
