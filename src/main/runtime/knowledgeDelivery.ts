import { composeFirstMessage } from './prompts'
import { RESUME_TEXT } from './runManager'
import { ROOT_AGENT_ID, type RuntimeContext } from './types'

/**
 * Where every adapter hands RuntimeContext.knowledgeContext its text, so the three stay alike: user messages and
 * spawn briefs only (harness nudges, peer messages and the auto-resume text never come here). The block goes beside
 * the text on its way to the model; the caller writes the transcript entry from the original text. Never throws and is
 * synchronous, so it can neither delay nor break a send or a spawn.
 */

type Warn = (message: string) => void

function contextBlock(ctx: Pick<RuntimeContext, 'knowledgeContext'>, text: string, opts: { agentId?: string; purpose: 'spawn' | 'message' }, warn: Warn): string | null {
  if (!ctx.knowledgeContext || !text.trim()) return null
  try {
    return ctx.knowledgeContext(text, opts) || null
  } catch (e) {
    warn(`Could not look up known items for a ${opts.purpose === 'spawn' ? 'spawn brief' : 'user message'}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/** The block for a user message to the root, or null. No text (an images-only message) and the auto-resume text get none. */
export function userMessageKnowledge(ctx: Pick<RuntimeContext, 'knowledgeContext'>, text: string, warn: Warn): string | null {
  if (text.trim() === RESUME_TEXT.trim()) return null
  return contextBlock(ctx, text, { agentId: ROOT_AGENT_ID, purpose: 'message' }, warn)
}

/** A user message as the model receives it, block included. The block never goes in the transcript entry. */
export function withUserMessageKnowledge(text: string, block: string | null): string {
  return block ? composeFirstMessage(text, block) : text
}

/** ctx.hiddenContext for the first message, with the prompt's knowledge block after it (a resumed run's RESUME_TEXT gets none). */
export function firstMessageHiddenContext(ctx: Pick<RuntimeContext, 'knowledgeContext' | 'hiddenContext' | 'prompt'>, warn: Warn): string | undefined {
  const block = userMessageKnowledge(ctx, ctx.prompt, warn)
  if (!block) return ctx.hiddenContext
  return ctx.hiddenContext ? `${ctx.hiddenContext}\n\n${block}` : block
}

/**
 * The block for a spawn's brief, or null. `agentId` is the spawned agent when known. Claude's PreToolUse does not know
 * it yet and passes undefined, which per the context's contract means no dedupe and the row on the root.
 */
export function spawnKnowledge(ctx: Pick<RuntimeContext, 'knowledgeContext'>, brief: string, agentId: string | undefined, warn: Warn): string | null {
  return contextBlock(ctx, brief, { ...(agentId ? { agentId } : {}), purpose: 'spawn' }, warn)
}

/** A brief as the spawned agent receives it. The block carries its own label saying it is data, not instructions. */
export function withSpawnKnowledge(brief: string, block: string | null): string {
  return block ? `${brief}\n\n---\n${block}` : brief
}
