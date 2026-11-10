import { ProviderToolNames, startProviderToolGateway, type ClaudeToolGateway } from './claudeToolGateway'

type Json = Record<string, unknown>
const record = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
interface Identity { name: string; namespace?: string }

/** Responses namespace+function pairs can exceed Bedrock's bound when a proxy joins them. Flatten at the wire only. */
export class CodexProviderTools {
  private registry = new ProviderToolNames()
  private name(identity: Identity): string {
    return this.registry.encode(identity.namespace === undefined ? identity.name : `orgai_fn_${JSON.stringify([identity.namespace, identity.name])}`)
  }

  request(body: Json): { body: Json; decode(value: unknown): unknown } {
    const names = new Map<string, Identity>()
    const tools: unknown[] = []
    const add = (tool: Json, namespace?: string): void => {
      if (typeof tool.name !== 'string') throw new Error('Invalid provider function name.')
      const identity = { name: tool.name, ...(namespace !== undefined ? { namespace } : {}) }
      const alias = this.name(identity)
      if (names.has(alias)) throw new Error('Duplicate provider function name.')
      names.set(alias, identity)
      tools.push({ ...tool, name: alias })
      if (tools.length > 10000) throw new Error('Provider tool definition limit exceeded.')
    }
    if (Array.isArray(body.tools)) {
      for (const tool of body.tools) {
        if (!record(tool)) throw new Error('Invalid provider tool.')
        if (tool.type === 'namespace') {
          if (typeof tool.name !== 'string' || !Array.isArray(tool.tools)) throw new Error('Invalid provider namespace.')
          for (const nested of tool.tools) {
            if (!record(nested) || nested.type !== 'function') throw new Error('Unsupported provider namespace tool.')
            add(nested, tool.name)
          }
        } else if (tool.type === 'function') add(tool)
        else tools.push(tool)
        if (tools.length > 10000) throw new Error('Provider tool definition limit exceeded.')
      }
    }
    const encode = (value: unknown): unknown => {
      if (!record(value)) return value
      if ((value.type === 'function_call' || value.type === 'function_call_output' || value.type === 'function') && typeof value.name === 'string') {
        const { namespace, ...rest } = value
        if (namespace !== undefined && typeof namespace !== 'string') throw new Error('Invalid provider call namespace.')
        return { ...rest, name: this.name({ name: value.name, ...(typeof namespace === 'string' ? { namespace } : {}) }) }
      }
      if (value.type === 'allowed_tools') {
        if (!Array.isArray(value.tools)) throw new Error('Invalid provider allowed-tools choice.')
        return { ...value, tools: value.tools.flatMap(choice => {
          if (record(choice) && choice.type === 'namespace') {
            const matches = [...names].filter(([, identity]) => identity.namespace === choice.name)
            if (!matches.length) throw new Error('Unknown provider namespace choice.')
            return matches.map(([name]) => ({ type: 'function', name }))
          }
          return [encode(choice)]
        }) }
      }
      if (value.type === 'namespace' || 'functions' in value) throw new Error('Unsupported provider tool choice.')
      return value
    }
    const decode = (value: unknown): unknown => {
      if (!record(value)) return value
      if (value.type === 'error') return { type: 'error', code: 'api_error', message: 'Provider request failed.' }
      if (value.type === 'response.failed') return { type: 'response.failed', response: { status: 'failed', error: { code: 'api_error', message: 'Provider request failed.' } } }
      if (value.type === 'function_call' || (value.type === 'response.function_call_arguments.done' && typeof value.name === 'string')) {
        if (typeof value.name !== 'string' || !names.has(value.name) || (value.namespace !== undefined && value.namespace !== null)) throw new Error('Unknown provider function call.')
        const { namespace: _namespace, ...rest } = value
        return { ...rest, ...names.get(value.name)! }
      }
      const out = { ...value }
      if (Array.isArray(value.output)) out.output = value.output.map(decode)
      if (record(value.item)) out.item = decode(value.item)
      if (record(value.response)) out.response = decode(value.response)
      return out
    }
    return { body: { ...body, ...(body.tools !== undefined ? { tools } : {}), ...(Array.isArray(body.input) ? { input: body.input.map(encode) } : {}), ...(record(body.tool_choice) ? { tool_choice: encode(body.tool_choice) } : {}) }, decode }
  }
}

export function startCodexToolGateway(base: string, apiKey: string): Promise<ClaudeToolGateway> {
  const tools = new CodexProviderTools()
  return startProviderToolGateway(base, { token: apiKey }, {
    route: /^responses(?:\/compact)?(?:\?[^#]*)?$/,
    request: body => tools.request(body)
  })
}
