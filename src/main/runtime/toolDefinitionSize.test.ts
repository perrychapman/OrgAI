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
 */
const BUDGET: Record<string, { claude: number; codex: number }> = {
  orchestrator: { claude: 17_450, codex: 19_425 },
  implementer: { claude: 6_200, codex: 6_725 },
  single: { claude: 9_575, codex: 10_150 }
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

  it('measures the tools each agent really gets: every agent saves outputs, only the root proposes changes', () => {
    const names = (slug: MeasureSlug, opts = { isolation: true, arch: true }) => codexToolSizes(measureCase(slug, opts)).map((t) => t.name)
    expect(names('orchestrator')).toEqual(expect.arrayContaining(['produce_output', 'propose_mcp_servers', 'propose_org_change', 'spawn_report', 'orgai_update_plan']))
    expect(names('implementer')).toContain('produce_output')
    expect(names('implementer')).not.toContain('propose_mcp_servers')
    expect(names('single', { isolation: false, arch: true })).toContain('set_plan')
    expect(claudeToolSizes(measureCase('implementer', { isolation: true, arch: true })).map((t) => t.name)).toContain('mcp__orgai__produce_output')
  })
})
