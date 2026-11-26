import type { SkillServiceApi } from './types'
import type { EvolveServiceDeps } from '../evolve/service'

/**
 * The skills port the host hands the evolution engine (EvolveServiceDeps.skills), self-healing efficiency D8.
 *
 * Evolution can DRAFT a skill, never switch one on. Every skill it creates is stored disabled in the same save, so no run
 * can load it before a person has read it, and nothing here can turn a skill on:
 *
 *  - `create` stores the skill with `enabled: false` (SkillService.create opts) and only grants the roles the engine
 *    passes (the engine passes the plan's `grantTo` slugs that still exist; the gate already removed the root and the
 *    checking roles). Source 'suggestion', like a skill drafted by the evaluation.
 *  - `setEnabled` accepts only `false` (the engine's belt-and-braces call after create). A request to enable throws:
 *    the unattended pass (afterRun), `org evolve --apply` and a rollback all reach the skill only through this port, and
 *    a person who approves a plan turns a skill on in the Skills page (skills:update), not through evolution.
 *  - `remove` refuses a skill that is switched on: a person enabled it after reviewing it, so it is theirs and a rollback
 *    or a failed apply leaves it (the engine reports "could not remove added skill").
 *  - `readDraft` is read-only.
 *
 * Disabled skills cost nothing: SkillService.forRun lists only enabled, granted skills in a run's prompt.
 */
export function evolveSkillsPort(skills: SkillServiceApi): NonNullable<EvolveServiceDeps['skills']> {
  return {
    create: (input) => skills.create(input, 'suggestion', { enabled: false }),
    setEnabled: (projectId, skillId, enabled) => {
      if (enabled !== false) throw new Error('Evolution never switches a skill on: a person reviews it and turns it on in the Skills page.')
      skills.update({ projectId, skillId, enabled: false })
    },
    remove: (input) => {
      const spec = skills.list(input.projectId).find((s) => s.spec.id === input.skillId)?.spec
      if (spec?.enabled) throw new Error(`${spec.name} is switched on, so evolution leaves it for you to remove.`)
      return skills.remove(input)
    },
    readDraft: (projectId, skillId) => {
      try {
        const info = skills.list(projectId).find((s) => s.spec.id === skillId)
        if (!info) return null
        return { name: info.spec.name, description: info.spec.description, body: skills.read({ projectId, skillId }).body }
      } catch {
        return null
      }
    }
  }
}
