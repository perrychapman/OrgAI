import { describe, expect, it } from 'vitest'
import { claudeToolSizes, codexToolSizes, measureCase, sumChars, type MeasureSlug } from './toolDefinitionSize'

/**
 * Budget on the harness tool definitions (name + description + input schema as JSON) the default chart sends with
 * every model request (docs/design/orchestration-efficiency.md 4.6). Same builders and fixture as
 * scripts/measure-prompt-size.mjs, which prints the per-tool breakdown.
 *
 * Phase 0 (fd6a420d) -> after the tool-definition diet:
 *   team root          Claude 28,718 -> 16,699   Codex 31,298 -> 18,581
 *   writing report     Claude 10,119 ->  5,981   Codex 10,980 ->  6,484
 *   single assistant   Claude 15,420 ->  9,197   Codex 16,335 ->  9,754
 * Each bound is about 5% above the figure after the diet. Raising a bound is a deliberate decision: say in the
 * change why the new tool text earns its place on every request, and update the figures here.
 *
 * Plan graph (set_plan / update_plan take after, paths and staff {role, tier enum, effort enum}; orchestration-efficiency
 * 4.2): +1,060 chars on both adapters, because staff is declared in full in three places (set_plan steps, update_plan
 * steps and add) so the model sees the allowed tiers and efforts and every provider's schema conversion keeps them.
 *   team root          Claude 16,699 -> 17,759   Codex 18,581 -> 19,641
 *   single assistant   Claude  9,197 -> 10,257   Codex  9,754 -> 10,814
 *   writing report     unchanged (no plan tools)
 * Bounds rose to the next 50 above the new figure (about 0.3% to 1.5% headroom). The fields earn their place because
 * the ready lines and the ready nudge need them to let the root start independent steps together.
 *
 * spawn_report tier and effort (Codex only; the Claude Agent tool is the SDK's own; orchestration-efficiency 4.3): +247 chars,
 * two enums with a few words each, so the orchestrator can state a pick on the call itself, which wins over its plan step.
 *   team root          Codex 19,641 -> 19,888 (Claude unchanged)
 *   writing report, single assistant: unchanged (no spawn_report)
 * The Codex team-root bound rose to 19,950 (about 0.3% headroom).
 *
 * spawn_report files (Codex only; context pack, split-execution 3.2): +126 chars, one optional string array whose
 * description states the limits, so a lead can hand its report the files it already read and save the report's first
 * round trips (a report's cold start is on the critical path of every split).
 *   team root          Codex 19,888 -> 20,014 (Claude unchanged)
 *   writing report, single assistant: unchanged (no spawn_report)
 * The Codex team-root bound rose to 20,050 (about 0.2% headroom).
 */
/*
 * Lean surface (reports of a code project get no output tools or app_reference; the single assistant has no
 * plan `staff` field; produce_output's description is shorter). Codex keeps
 * list_skills / load_skill even with no skills at start (a skill approved mid-run must be loadable):
 *   team root          Claude 17,759 -> 17,657   Codex 19,888 -> 19,950
 *   writing report     Claude  5,981 ->    442   Codex  6,484 ->    921 (request_permission_rules and the skill tools)
 *   single assistant   Claude 10,257 ->  9,441   Codex 10,814 ->  9,998 (engagement_context kept for the context notes)
 */
/*
 * Schedules (docs/design/schedules.md 4): list_schedules (246 chars) and propose_schedule (2,159 chars, a compact flat
 * schema with five actions, the target, the four timing kinds and the optional run settings) are offered to the root of
 * work and single runs so a project run can schedule itself; reports get neither. +2,405 chars on both adapters:
 *   team root          Claude 17,657 -> 20,066   Codex 19,950 -> 22,367
 *   single assistant   Claude  9,441 -> 11,846   Codex  9,998 -> 12,415
 *   writing report     unchanged
 * Bounds rose to the next 50 above the new figure.
 */
const BUDGET: Record<string, { claude: number; codex: number }> = {
  orchestrator: { claude: 20_100, codex: 22_400 },
  implementer: { claude: 500, codex: 1_000 },
  single: { claude: 11_850, codex: 12_450 }
}

const CASES: { label: string; slug: MeasureSlug; opts: { isolation: boolean; arch: boolean } }[] = [
  { label: 'team root', slug: 'orchestrator', opts: { isolation: true, arch: true } },
  { label: 'writing report', slug: 'implementer', opts: { isolation: true, arch: true } },
  { label: 'single assistant', slug: 'single', opts: { isolation: false, arch: true } }
]

describe('harness tool definition budget (default chart)', () => {
  for (const c of CASES) {
    it(`${c.label}: Claude and Codex tool definitions stay within budget`, () => {
      const mc = measureCase(c.slug, c.opts)
      const claude = claudeToolSizes(mc)
      const codex = codexToolSizes(mc)
      expect(claude.length).toBeGreaterThan(0)
      expect(codex.length).toBeGreaterThanOrEqual(claude.length)
      expect(sumChars(claude)).toBeLessThanOrEqual(BUDGET[c.slug].claude)
      expect(sumChars(codex)).toBeLessThanOrEqual(BUDGET[c.slug].codex)
    })
  }

  it('measures the tools each agent really gets: only the root and the single assistant save outputs, only the root proposes changes', () => {
    const names = (slug: MeasureSlug, opts = { isolation: true, arch: true }) => codexToolSizes(measureCase(slug, opts)).map((t) => t.name)
    expect(names('orchestrator')).toEqual(expect.arrayContaining(['produce_output', 'propose_mcp_servers', 'propose_org_change', 'spawn_report', 'orgai_update_plan']))
    // A report on a code project saves nothing itself: the orchestrator produces the deliverables.
    expect(names('implementer')).not.toContain('produce_output')
    expect(names('implementer')).not.toContain('register_output')
    expect(names('implementer')).not.toContain('read_output')
    expect(names('implementer')).not.toContain('app_reference')
    expect(names('implementer')).not.toContain('propose_mcp_servers')
    expect(names('single', { isolation: false, arch: true })).toContain('set_plan')
    expect(claudeToolSizes(measureCase('implementer', { isolation: true, arch: true })).map((t) => t.name)).not.toContain('mcp__orgai__produce_output')
    // The single assistant works alone, so it keeps the outputs tools and engagement_context (the context notes), but not the plan staff field.
    const single = names('single', { isolation: false, arch: true })
    expect(single).toContain('produce_output')
    expect(single).toContain('engagement_context')
  })
})
