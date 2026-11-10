import { describe, expect, it } from 'vitest'
import { CodexProviderTools } from './codexToolGateway'

const fn = (name: string) => ({ type: 'function', name, parameters: { type: 'object' } })
const ns = (name: string, tool = 'same') => ({ type: 'namespace', name, tools: [fn(tool)] })

describe('Codex Responses provider identities', () => {
  it('flattens ambiguous namespace pairs with unique bounded names and reverses structured calls only', () => {
    const registry = new CodexProviderTools()
    const mapped = registry.request({ model: 'us.openai.gpt-6.1-terra', tools: [ns('a__b', 'c'), ns('a', 'b__c'), ns('other', 'c'), fn('Read')],
      input: [{ type: 'function_call', name: 'c', namespace: 'a__b', call_id: 'id', arguments: '{"name":"c"}' }],
      tool_choice: { type: 'function', name: 'c', namespace: 'a__b' } })
    const tools = mapped.body.tools as { name: string; type: string }[]
    const names = tools.map(tool => tool.name)
    expect(new Set(names).size).toBe(4)
    expect(names.every(name => name.length <= 64)).toBe(true)
    expect(names[3]).toBe('Read')
    expect(tools.every(tool => tool.type === 'function')).toBe(true)
    expect(mapped.body.model).toBe('us.openai.gpt-6.1-terra')
    expect(mapped.body.input).toEqual([{ type: 'function_call', name: names[0], call_id: 'id', arguments: '{"name":"c"}' }])
    expect(mapped.body.tool_choice).toEqual({ type: 'function', name: names[0] })
    const call = { type: 'function_call', name: names[0], call_id: 'id', id: 'fc', arguments: '{"name":"c"}' }
    const decoded = { ...call, name: 'c', namespace: 'a__b' }
    expect(mapped.decode(call)).toEqual(decoded)
    expect(mapped.decode({ type: 'response.output_item.added', item: call })).toEqual({ type: 'response.output_item.added', item: decoded })
    expect(mapped.decode({ type: 'response.output_item.done', item: call })).toEqual({ type: 'response.output_item.done', item: decoded })
    expect(mapped.decode({ type: 'response.completed', response: { output: [call] } })).toEqual({ type: 'response.completed', response: { output: [decoded] } })
    expect(mapped.decode({ output: [call] })).toEqual({ output: [decoded] })
    expect(mapped.decode({ ...call, type: 'response.function_call_arguments.done' })).toEqual({ ...decoded, type: 'response.function_call_arguments.done' })
    expect(() => mapped.decode({ ...call, namespace: 'a__b' })).toThrow('Unknown')
    expect(() => mapped.decode({ ...call, name: 'unknown' })).toThrow('Unknown')
  })

  it('reserves alias lookalikes, preserves allowed-tools constraints and fails closed for duplicate/unsupported tools', () => {
    const registry = new CodexProviderTools()
    const first = registry.request({ tools: [ns('first')] })
    const alias = (first.body.tools as { name: string }[])[0]!.name
    const mapped = registry.request({ tools: [ns('first'), ns('second'), fn(alias)], tool_choice: {
      type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'same', namespace: 'first' }, { type: 'function', name: 'same', namespace: 'second' }]
    } })
    const names = (mapped.body.tools as { name: string }[]).map(tool => tool.name)
    expect(new Set(names).size).toBe(3)
    expect(names[0]).toBe(alias)
    expect(mapped.body.tool_choice).toEqual({ type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: names[0] }, { type: 'function', name: names[1] }] })
    expect(() => registry.request({ tools: [ns('first'), ns('first')] })).toThrow('Duplicate')
    expect(() => registry.request({ tools: [{ type: 'namespace', name: 'bad', tools: [{ type: 'custom', name: 'x' }] }] })).toThrow('Unsupported')
    const removed = registry.request({ tools: [ns('second')], input: [{ type: 'function_call', name: 'same', namespace: 'first' }] })
    expect(() => removed.decode({ type: 'function_call', name: alias })).toThrow('Unknown')
    const choice = registry.request({ tools: [ns('first'), ns('second')], tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'namespace', name: 'second' }] } })
    expect(choice.body.tool_choice).toMatchObject({ type: 'allowed_tools', tools: [{ type: 'function', name: names[1] }] })
    expect(() => registry.request({ tool_choice: { type: 'allowed_tools', tools: [{ type: 'namespace', name: 'missing' }] } })).toThrow('Unknown')
    expect(() => registry.request({ tool_choice: { type: 'namespace', name: 'first' } })).toThrow('Unsupported')
    expect(JSON.stringify(mapped.decode({ type: 'error', message: 'SECRET', code: 'SECRET', error: { message: 'SECRET' } }))).not.toContain('SECRET')
    expect(JSON.stringify(mapped.decode({ type: 'response.failed', message: 'SECRET', response: { error: { message: 'SECRET' } } }))).not.toContain('SECRET')
  })
})
