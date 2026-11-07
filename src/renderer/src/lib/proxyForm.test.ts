import { describe, expect, it } from 'vitest'
import { PROXY_NAME_MAX } from '@shared/types'
import { defaultModelsUrl, defaultOpenAIUrl, nameProblem, otherModelsHost, takenNames, urlProblem, validateProxyForm } from './proxyForm'

describe('nameProblem', () => {
  const taken = takenNames(['Work gateway'])
  it('requires a name within the limit', () => {
    expect(nameProblem('  ', taken)).toMatch(/Give the proxy a name/)
    expect(nameProblem('x'.repeat(PROXY_NAME_MAX + 1), taken)).toMatch(/at most/)
    expect(nameProblem('x'.repeat(PROXY_NAME_MAX), taken)).toBeNull()
  })
  it('refuses duplicates case-insensitively, built-ins included', () => {
    expect(nameProblem('work  GATEWAY', taken)).toMatch(/already exists/)
    expect(nameProblem('openai', taken)).toMatch(/already exists/)
    expect(nameProblem('Other', taken)).toBeNull()
  })
  it('refuses hidden characters', () => {
    expect(nameProblem('a‮b', taken)).toMatch(/hidden/)
  })
})

describe('urlProblem', () => {
  it('requires https, or http for local and private hosts', () => {
    expect(urlProblem('https://proxy.example.com', 'Anthropic URL', true)).toBeNull()
    expect(urlProblem('http://localhost:4000', 'Anthropic URL', true)).toBeNull()
    expect(urlProblem('http://192.168.1.5:4000', 'Anthropic URL', true)).toBeNull()
    expect(urlProblem('http://proxy.example.com', 'Anthropic URL', true)).toMatch(/Use https/)
    expect(urlProblem('ftp://proxy.example.com', 'Anthropic URL', true)).toMatch(/https/)
    expect(urlProblem('proxy.example.com', 'Anthropic URL', true)).toMatch(/not a valid URL/)
  })
  it('lets an optional field be empty but not a required one', () => {
    expect(urlProblem('', 'OpenAI URL', false)).toBeNull()
    expect(urlProblem('', 'Anthropic URL', true)).toMatch(/Enter the/)
  })
  it('refuses credentials and queries', () => {
    expect(urlProblem('https://u:p@proxy.example.com', 'x', true)).toMatch(/user name/)
    expect(urlProblem('https://proxy.example.com/?a=1', 'x', true)).toMatch(/query/)
  })
})

describe('default previews', () => {
  it('derives the OpenAI URL and models endpoint', () => {
    expect(defaultOpenAIUrl('')).toBe('')
    expect(defaultOpenAIUrl('https://proxy.example.com/')).toBe('https://proxy.example.com/v1')
    expect(defaultOpenAIUrl('https://proxy.example.com/v1')).toBe('https://proxy.example.com/v1')
    expect(defaultModelsUrl('https://proxy.example.com', '')).toBe('https://proxy.example.com/v1/models')
    expect(defaultModelsUrl('https://proxy.example.com', 'https://openai.example.com/v1')).toBe('https://openai.example.com/v1/models')
    expect(defaultModelsUrl('', '')).toBe('')
  })
})

describe('otherModelsHost', () => {
  it('names a models host that differs from the base hosts', () => {
    expect(otherModelsHost('https://a.example.com', '', 'https://a.example.com/v1/models')).toBeNull()
    expect(otherModelsHost('https://a.example.com', '', 'https://b.example.com/models')).toBe('b.example.com')
    expect(otherModelsHost('https://a.example.com', 'https://c.example.com/v1', 'https://c.example.com/v1/models')).toBeNull()
    expect(otherModelsHost('https://a.example.com', '', '')).toBeNull()
    expect(otherModelsHost('https://a.example.com', '', 'not a url')).toBeNull()
  })
})

describe('validateProxyForm', () => {
  it('collects one message per bad field', () => {
    const errs = validateProxyForm({ name: '', kind: 'litellm', anthropicBaseUrl: 'nope', openaiBaseUrl: 'http://x.example.com', modelsUrl: '' }, [])
    expect(Object.keys(errs).sort()).toEqual(['anthropicBaseUrl', 'name', 'openaiBaseUrl'])
    expect(validateProxyForm({ name: 'Gate', kind: 'litellm', anthropicBaseUrl: 'https://mock-proxy.example.com', openaiBaseUrl: '', modelsUrl: '' }, [])).toEqual({})
  })
})
