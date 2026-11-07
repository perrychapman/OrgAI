import { describe, expect, it } from 'vitest'
import { familyCountsText, mixedFamilies, routeHintFor, withFamily } from './modelFamily'

describe('model family words', () => {
  it('names the family only when families are mixed', () => {
    expect(withFamily('gpt-5', 'openai', true)).toBe('gpt-5 · GPT')
    expect(withFamily('gemini-2.5-pro', 'other', true)).toBe('gemini-2.5-pro · Other')
    expect(withFamily('gpt-5', 'openai', false)).toBe('gpt-5')
    expect(mixedFamilies([{ family: 'claude' }, { family: 'claude' }])).toBe(false)
    expect(mixedFamilies([{ family: 'claude' }, { family: 'other' }])).toBe(true)
  })
  it('counts per family in a fixed order and skips empty families', () => {
    expect(familyCountsText([{ family: 'other' }, { family: 'claude' }, { family: 'claude' }, { family: 'openai' }])).toBe('Claude 2, GPT 1, Other 1')
    expect(familyCountsText([{ family: 'openai' }])).toBe('GPT 1')
  })
  it('explains the two routes once, only when they differ', () => {
    expect(routeHintFor([{ family: 'claude', baseUrl: 'https://a.example/' }, { family: 'openai', baseUrl: 'https://a.example/v1' }])).toContain('Anthropic URL')
    expect(routeHintFor([{ family: 'claude', baseUrl: 'https://a.example/' }, { family: 'openai', baseUrl: 'https://a.example/' }])).toBeUndefined()
    expect(routeHintFor([{ family: 'claude' }, { family: 'openai' }])).toBeUndefined()
    expect(routeHintFor([{ family: 'claude', baseUrl: 'https://a.example/' }])).toBeUndefined()
  })
})
