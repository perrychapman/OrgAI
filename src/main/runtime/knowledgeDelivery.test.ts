import { describe, expect, it, vi } from 'vitest'
import { firstMessageHiddenContext, spawnKnowledge, userMessageKnowledge, withSpawnKnowledge, withUserMessageKnowledge } from './knowledgeDelivery'
import { KNOWLEDGE_BLOCK_MARK, RESUME_TEXT, composeFirstMessage } from './prompts'
import { ROOT_AGENT_ID, type RuntimeContext } from './types'

const context = (block: string | null = 'BLOCK') => vi.fn<NonNullable<RuntimeContext['knowledgeContext']>>(() => block)

describe('userMessageKnowledge', () => {
  it('names the root explicitly and asks with purpose message', () => {
    const knowledgeContext = context()
    expect(userMessageKnowledge({ knowledgeContext }, 'About Acme', vi.fn())).toBe('BLOCK')
    expect(knowledgeContext).toHaveBeenCalledWith('About Acme', { agentId: ROOT_AGENT_ID, purpose: 'message' })
  })

  it('skips empty text (an images-only message), the auto-resume text and a run with no context', () => {
    const knowledgeContext = context()
    expect(userMessageKnowledge({ knowledgeContext }, '', vi.fn())).toBeNull()
    expect(userMessageKnowledge({ knowledgeContext }, '  \n', vi.fn())).toBeNull()
    expect(userMessageKnowledge({ knowledgeContext }, RESUME_TEXT, vi.fn())).toBeNull()
    expect(userMessageKnowledge({ knowledgeContext }, ` ${RESUME_TEXT.trim()} `, vi.fn())).toBeNull()
    expect(knowledgeContext).not.toHaveBeenCalled()
    expect(userMessageKnowledge({}, 'About Acme', vi.fn())).toBeNull()
  })

  it('catches a throw from the context and warns', () => {
    const warn = vi.fn()
    const knowledgeContext = vi.fn(() => {
      throw new Error('boom')
    })
    expect(userMessageKnowledge({ knowledgeContext }, 'About Acme', warn)).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'))
  })
})

describe('firstMessageHiddenContext', () => {
  it('adds the block after any hidden context, and leaves the hidden context alone without a block', () => {
    expect(firstMessageHiddenContext({ prompt: 'p', knowledgeContext: context() }, vi.fn())).toBe(`${KNOWLEDGE_BLOCK_MARK}BLOCK`)
    expect(firstMessageHiddenContext({ prompt: 'p', hiddenContext: 'H', knowledgeContext: context() }, vi.fn())).toBe(`H${KNOWLEDGE_BLOCK_MARK}BLOCK`)
    expect(firstMessageHiddenContext({ prompt: 'p', hiddenContext: 'H', knowledgeContext: context(null) }, vi.fn())).toBe('H')
    expect(firstMessageHiddenContext({ prompt: 'p', knowledgeContext: context(null) }, vi.fn())).toBeUndefined()
  })

  it('the block lands under its own separator, never under the "not visible to the user" heading', () => {
    const warn = vi.fn()
    const both = composeFirstMessage('p', firstMessageHiddenContext({ prompt: 'p', hiddenContext: 'PROFILE', knowledgeContext: context() }, warn))
    expect(both).toBe('p\n\n---\nContext from the harness (not visible to the user):\nPROFILE\n\n---\nBLOCK')
    const only = composeFirstMessage('p', firstMessageHiddenContext({ prompt: 'p', knowledgeContext: context() }, warn))
    expect(only).toBe('p\n\n---\nBLOCK')
    expect(only).not.toContain('not visible')
    // A hidden context that happens to hold the mark text before the real block cannot move the block under the heading.
    const tricky = composeFirstMessage('p', firstMessageHiddenContext({ prompt: 'p', hiddenContext: `a${KNOWLEDGE_BLOCK_MARK}b`, knowledgeContext: context() }, warn))
    expect(tricky.endsWith('\n\n---\nBLOCK')).toBe(true)
    // The transcript entry is written from the original prompt, which has none of it.
    expect('p').not.toContain('BLOCK')
    expect(composeFirstMessage('p', undefined)).toBe('p')
  })

  it('an auto-resume gets no block', () => {
    const knowledgeContext = context()
    expect(firstMessageHiddenContext({ prompt: RESUME_TEXT, knowledgeContext }, vi.fn())).toBeUndefined()
    expect(knowledgeContext).not.toHaveBeenCalled()
  })
})

describe('spawnKnowledge', () => {
  it('names a known child, and passes no agentId at all when the child is unknown', () => {
    const knowledgeContext = context()
    spawnKnowledge({ knowledgeContext }, 'brief', 'a-1', vi.fn())
    expect(knowledgeContext).toHaveBeenLastCalledWith('brief', { agentId: 'a-1', purpose: 'spawn' })
    spawnKnowledge({ knowledgeContext }, 'brief', undefined, vi.fn())
    expect(knowledgeContext).toHaveBeenLastCalledWith('brief', { purpose: 'spawn' })
  })

  it('skips an empty brief and catches a throw', () => {
    const warn = vi.fn()
    const throwing = vi.fn(() => {
      throw new Error('boom')
    })
    expect(spawnKnowledge({ knowledgeContext: throwing }, '', undefined, warn)).toBeNull()
    expect(throwing).not.toHaveBeenCalled()
    expect(spawnKnowledge({ knowledgeContext: throwing }, 'brief', undefined, warn)).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
  })
})

describe('placing the block', () => {
  it('leaves the text as it is without a block, and keeps the text first with one', () => {
    expect(withUserMessageKnowledge('text', null)).toBe('text')
    expect(withSpawnKnowledge('brief', null)).toBe('brief')
    expect(withUserMessageKnowledge('text', 'BLOCK')).toBe('text\n\n---\nBLOCK')
    expect(withUserMessageKnowledge('text', 'BLOCK')).not.toContain('not visible')
    expect(withSpawnKnowledge('brief', 'BLOCK')).toBe('brief\n\n---\nBLOCK')
  })
})
