import { describe, expect, it } from 'vitest'
import { EFFORTS, MODEL_TIERS, type Effort, type ModelTier, type TeamFileChange } from '@shared/types'
import type { TeamDoc } from './doc'
import { normalizeDoc } from './digest'
import { CHART_REASON, FIRST_SEEN_REASON, describeChanges, gateTeam, isElevatedTool, permissionRank, type LinkResolver } from './gate'
import { role, sampleDoc } from './doc.fixture'
import { resolveStaffing } from '../runtime/staffing'
import { canonicalJson } from './digest'

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)

const clone = <T>(v: T): T => structuredClone(v)
const dev = (d: TeamDoc) => d.roles.find((r) => r.slug === 'dev')!
const reviewer = (d: TeamDoc) => d.roles.find((r) => r.slug === 'reviewer')!
const lead = (d: TeamDoc) => d.roles.find((r) => r.slug === 'lead')!
const wiki = (d: TeamDoc) => d.mcp.find((m) => m.name === 'wiki')!

function gate(mutate: (disk: TeamDoc) => void, opts: { firstSeen?: boolean; approved?: TeamDoc } = {}) {
  const approved = opts.approved ?? sampleDoc()
  const disk = clone(approved)
  mutate(disk)
  const r = gateTeam(approved, disk, { firstSeen: opts.firstSeen })
  // Every gate must be idempotent: the effective team against the same disk applies nothing and pends the same.
  const again = gateTeam(r.effective, disk, { firstSeen: opts.firstSeen })
  if (!opts.firstSeen) expect(again.applied).toEqual([])
  expect(again.pending.map((c) => [c.id, c.summary, c.reason])).toEqual(r.pending.map((c) => [c.id, c.summary, c.reason]))
  expect(again.effective).toEqual(r.effective)
  return { ...r, approved: normalizeDoc(approved), disk: normalizeDoc(disk), ids: { pending: r.pending.map((c) => c.id), applied: r.applied.map((c) => c.id) } }
}

describe('gateTeam basics', () => {
  it('has nothing to do for an identical team', () => {
    const r = gate(() => {})
    expect(r.pending).toEqual([])
    expect(r.applied).toEqual([])
    expect(r.effective).toEqual(r.approved)
  })

  it('applies prompt and description changes at once, with before and after', () => {
    const r = gate((d) => {
      dev(d).prompt = 'New prompt'
      dev(d).description = 'New description'
    })
    expect(r.pending).toEqual([])
    expect(r.ids.applied).toEqual(['role:dev:details', 'role:dev:prompt'])
    expect(dev(r.effective).prompt).toBe('New prompt')
    expect(dev(r.effective).description).toBe('New description')
    const c = r.applied.find((x) => x.id === 'role:dev:prompt')!
    expect(c).toMatchObject({ before: 'You are the dev.', after: 'New prompt', kind: 'role', file: '.orgai/agents/dev.md', needsApproval: false })
  })

  it('applies a removed role (and drops what pointed at it)', () => {
    const r = gate((d) => {
      d.roles = d.roles.filter((x) => x.slug !== 'reviewer')
      lead(d).spawnable = ['dev']
    })
    expect(r.pending).toEqual([])
    expect(r.effective.roles.map((x) => x.slug)).toEqual(['dev', 'lead'])
    expect(r.applied.some((c) => c.id === 'role:reviewer' && c.action === 'removed')).toBe(true)
  })
})

describe('tools', () => {
  it('applies the intersection and keeps additions pending', () => {
    const r = gate((d) => {
      dev(d).tools = ['Glob', 'Read', 'WebFetch', 'WebSearch']
    })
    expect(dev(r.effective).tools).toEqual(['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'].filter((t) => ['Glob', 'Read'].includes(t)))
    const p = r.pending.find((c) => c.id === 'role:dev:tools')!
    expect(p).toMatchObject({ toolsAdded: ['WebFetch', 'WebSearch'], toolsBefore: ['Glob', 'Read'], toolsAfter: ['Glob', 'Read', 'WebFetch', 'WebSearch'], needsApproval: true })
    expect(p.elevatedAdded).toBeUndefined()
    expect(p.summary).toBe('Dev gains WebFetch and WebSearch.')
    expect(r.applied.some((c) => c.id === 'role:dev:tools-removed')).toBe(true)
  })

  it('names elevated tools', () => {
    const r = gate((d) => {
      reviewer(d).tools = ['Bash', 'Glob', 'Grep', 'Read', 'Write']
    })
    const p = r.pending[0]
    expect(p.summary).toBe('Reviewer gains Bash and Write.')
    expect(p.elevatedAdded).toEqual(['Bash', 'Write'])
    expect(reviewer(r.effective).tools).toEqual(['Glob', 'Grep', 'Read'])
  })

  it('lowered tools apply at once', () => {
    const r = gate((d) => {
      dev(d).tools = ['Read']
    })
    expect(r.pending).toEqual([])
    expect(dev(r.effective).tools).toEqual(['Read'])
  })
})

describe('spawning', () => {
  it('canSpawn turned on pends, turned off applies', () => {
    const on = gate((d) => {
      dev(d).canSpawn = true
    })
    expect(on.ids.pending).toEqual(['role:dev:spawn'])
    expect(on.pending[0].elevatedAdded).toEqual(['canSpawn'])
    expect(dev(on.effective).canSpawn).toBe(false)
    const off = gate((d) => {
      lead(d).canSpawn = false
    })
    expect(off.pending).toEqual([])
    expect(lead(off.effective).canSpawn).toBe(false)
  })

  it('wider spawnable pends, narrower applies', () => {
    const wider = gate((d) => {
      lead(d).spawnable = ['dev', 'reviewer', 'lead2']
      d.roles.push(role('lead2', { reportsTo: 'lead' }))
    })
    expect(wider.ids.pending).toContain('role:lead:spawn')
    expect(lead(wider.effective).spawnable).toEqual(['dev', 'reviewer'])
    const narrower = gate((d) => {
      lead(d).spawnable = ['dev']
    })
    expect(narrower.pending).toEqual([])
    expect(lead(narrower.effective).spawnable).toEqual(['dev'])
  })
})

describe('skills and grants', () => {
  it('a new skill grant pends and a removed grant applies', () => {
    const r = gate((d) => {
      reviewer(d).skills = ['code-style']
      dev(d).skills = []
    })
    expect(r.ids.pending).toEqual(['role:reviewer:skills'])
    expect(reviewer(r.effective).skills).toEqual([])
    expect(dev(r.effective).skills).toEqual([])
    expect(r.ids.applied).toEqual(['role:dev:skills-removed'])
  })

  it('a new skill pends, is not in the effective team, and neither is a grant to it', () => {
    const r = gate((d) => {
      d.skills.push({ name: 'fresh', description: 'New one.', body: 'Do it.', files: [{ path: 'run.sh', text: 'echo hi\n' }], enabled: true })
      reviewer(d).skills = ['fresh']
    })
    // Most powerful first: skills before the rest, then by id.
    expect(r.ids.pending).toEqual(['skill:fresh', 'role:reviewer:skills'])
    expect(r.effective.skills.map((s) => s.name)).not.toContain('fresh')
    expect(reviewer(r.effective).skills).toEqual([])
    const c = r.pending.find((x) => x.id === 'skill:fresh')!
    expect(c).toMatchObject({ kind: 'skill', action: 'added', scripts: ['run.sh'], file: '.orgai/skills/fresh' })
  })

  it('a changed skill (body or files) pends and keeps the approved content', () => {
    const body = gate((d) => {
      d.skills[0].body = 'Changed body'
    })
    expect(body.ids.pending).toEqual(['skill:code-style'])
    expect(body.effective.skills[0].body).toBe(body.approved.skills[0].body)
    const files = gate((d) => {
      d.skills[0].files = []
    })
    expect(files.ids.pending).toEqual(['skill:code-style'])
    expect(files.effective.skills[0].files.length).toBe(2)
  })

  it('a skill turned on pends, turned off applies, removed applies', () => {
    const on = gate((d) => {
      d.skills.find((s) => s.name === 'old-skill')!.enabled = true
    })
    expect(on.ids.pending).toEqual(['skill:old-skill:enabled'])
    expect(on.effective.skills.find((s) => s.name === 'old-skill')!.enabled).toBe(false)
    const off = gate((d) => {
      d.skills[0].enabled = false
    })
    expect(off.pending).toEqual([])
    expect(off.effective.skills[0].enabled).toBe(false)
    const removed = gate((d) => {
      d.skills = d.skills.filter((s) => s.name !== 'code-style')
      dev(d).skills = []
    })
    expect(removed.pending).toEqual([])
    expect(removed.effective.skills.map((s) => s.name)).toEqual(['old-skill'])
  })
})

describe('mcp servers', () => {
  it('a new server pends with its full target and secret names, and is absent from the effective team with its grants', () => {
    const long = `${'a'.repeat(390)}`
    const r = gate((d) => {
      d.mcp.push({ name: 'fresh', transport: 'stdio', command: 'npx', args: ['-y', long], secretEnv: ['FRESH_KEY'], enabled: true })
      reviewer(d).mcpServers = ['fresh']
    })
    expect(r.ids.pending).toEqual(['mcp:fresh', 'role:reviewer:mcpServers'])
    expect(r.effective.mcp.map((m) => m.name)).not.toContain('fresh')
    expect(reviewer(r.effective).mcpServers).toEqual([])
    const c = r.pending.find((x) => x.id === 'mcp:fresh')!
    expect(c.target).toBe(`npx -y ${long}`)
    expect(c.secretNames).toEqual(['FRESH_KEY'])
  })

  it('a changed launch definition pends and keeps the approved one: command, args, env, url, secrets, connector', () => {
    for (const mutate of [
      (d: TeamDoc) => (d.mcp[0].command = 'node'),
      (d: TeamDoc) => (d.mcp[0].args = ['-y', 'docs-server@9.9.9']),
      (d: TeamDoc) => (d.mcp[0].env = { MODE: 'write' }),
      (d: TeamDoc) => (d.mcp[0].secretEnv = ['OTHER']),
      (d: TeamDoc) => (wiki(d).url = 'https://evil.example/mcp'),
      (d: TeamDoc) => (wiki(d).headers = { 'X-Team': 'b' }),
      (d: TeamDoc) => (wiki(d).connectorId = 'other-co'),
      (d: TeamDoc) => (wiki(d).connectorVariant = 'write')
    ]) {
      const r = gate(mutate)
      expect(r.pending).toHaveLength(1)
      expect(r.pending[0].id).toMatch(/^mcp:.*:launch$/)
      expect(r.pending[0].target).toBeTruthy()
      expect(r.effective.mcp).toEqual(r.approved.mcp)
    }
  })

  it('a server turned on pends, turned off applies, description applies', () => {
    const base = sampleDoc()
    base.mcp[0].enabled = false
    const on = gate((d) => (d.mcp[0].enabled = true), { approved: base })
    expect(on.ids.pending).toEqual(['mcp:docs:enabled'])
    expect(on.effective.mcp[0].enabled).toBe(false)
    const off = gate((d) => {
      d.mcp[0].enabled = false
      d.mcp[0].description = 'Now described'
    })
    expect(off.pending).toEqual([])
    expect(off.effective.mcp[0].enabled).toBe(false)
    expect(off.effective.mcp[0].description).toBe('Now described')
  })

  it('a role gaining access through server.roles pends; through role.mcpServers pends; narrowing applies', () => {
    const viaServer = gate((d) => (wiki(d).roles = ['dev', 'lead', 'reviewer']))
    expect(viaServer.ids.pending).toEqual(['mcp:wiki:roles'])
    expect(wiki(viaServer.effective).roles).toEqual(['dev', 'lead'])
    const toAll = gate((d) => delete wiki(d).roles)
    expect(toAll.ids.pending).toEqual(['mcp:wiki:roles'])
    expect(wiki(toAll.effective).roles).toEqual(['dev', 'lead'])
    const viaGrant = gate((d) => (lead(d).mcpServers = ['wiki']))
    expect(viaGrant.ids.pending).toEqual(['role:lead:mcpServers'])
    expect(lead(viaGrant.effective).mcpServers).toEqual([])
    const narrowServer = gate((d) => (wiki(d).roles = ['dev']))
    expect(narrowServer.pending).toEqual([])
    expect(wiki(narrowServer.effective).roles).toEqual(['dev'])
    const fromAll = sampleDoc()
    delete wiki(fromAll).roles
    const narrowFromAll = gate((d) => (wiki(d).roles = ['dev']), { approved: fromAll })
    expect(narrowFromAll.pending).toEqual([])
    expect(wiki(narrowFromAll.effective).roles).toEqual(['dev'])
    const narrowGrant = gate((d) => (dev(d).mcpServers = []))
    expect(narrowGrant.pending).toEqual([])
    expect(dev(narrowGrant.effective).mcpServers).toEqual([])
  })

  it('a removed server applies and the grants to it go with it', () => {
    const r = gate((d) => {
      d.mcp = d.mcp.filter((m) => m.name !== 'docs')
      dev(d).mcpServers = []
    })
    expect(r.pending).toEqual([])
    expect(r.effective.mcp.map((m) => m.name)).toEqual(['wiki'])
  })
})

describe('new roles', () => {
  const plain = (slug = 'tester', over = {}) => role(slug, { reportsTo: 'lead', ...over })

  it('a plain new role applies at once, unless first seen', () => {
    const r = gate((d) => d.roles.push(plain()))
    expect(r.pending).toEqual([])
    expect(r.effective.roles.map((x) => x.slug)).toContain('tester')
    expect(r.applied.find((c) => c.id === 'role:tester')).toMatchObject({ action: 'added', needsApproval: false })
    const first = gate((d) => d.roles.push(plain()), { firstSeen: true })
    expect(first.effective.roles.map((x) => x.slug)).not.toContain('tester')
    expect(first.pending.every((c) => c.reason === FIRST_SEEN_REASON)).toBe(true)
  })

  it('a new role with an elevated tool, canSpawn, skills or servers pends', () => {
    for (const [over, reason] of [
      [{ tools: ['Bash'] }, /elevated/],
      [{ tools: ['Write'] }, /elevated/],
      [{ canSpawn: true }, /./],
      [{ skills: ['code-style'] }, /skills or services/],
      [{ mcpServers: ['docs'] }, /skills or services/]
    ] as const) {
      const r = gate((d) => d.roles.push(plain('tester', over)))
      expect(r.ids.pending).toEqual(['role:tester'])
      expect(r.effective.roles.map((x) => x.slug)).not.toContain('tester')
      expect(r.pending[0].reason).toMatch(reason)
    }
    // Held through a server's own role list too.
    const viaServer = gate((d) => {
      d.roles.push(plain())
      wiki(d).roles = ['dev', 'lead', 'tester']
    })
    expect(viaServer.ids.pending).toContain('role:tester')
  })

  it('a new role reporting to a pending role stays pending too', () => {
    const r = gate((d) => {
      d.roles.push(plain('boss', { tools: ['Bash'] }))
      d.roles.push(plain('helper', { reportsTo: 'boss' }))
    })
    expect(r.ids.pending).toEqual(['role:boss', 'role:helper'])
    expect(r.pending.find((c) => c.id === 'role:helper')!.reason).toMatch(/needs review/)
    expect(r.effective.roles.map((x) => x.slug)).toEqual(['dev', 'lead', 'reviewer'])
  })
})

describe('chart validity', () => {
  it('falls back to the approved team with every difference pending when the result is no chart', () => {
    const r = gate((d) => {
      // The old root is replaced by a new elevated one: the new root waits, so the children would be orphaned.
      d.roles = d.roles.filter((x) => x.slug !== 'lead')
      d.roles.push(role('boss', { reportsTo: null, tools: ['Bash'] }))
      dev(d).reportsTo = 'boss'
      reviewer(d).reportsTo = 'boss'
      dev(d).description = 'Harmless change that now waits too'
    })
    expect(r.effective).toEqual(r.approved)
    expect(r.applied).toEqual([])
    expect(r.pending.length).toBeGreaterThan(2)
    expect(r.pending.every((c) => c.reason === CHART_REASON && c.needsApproval)).toBe(true)
  })
})

describe('settings', () => {
  it('orders permission modes', () => {
    const order = (['plan', 'dontAsk', 'default', 'acceptEdits', 'auto', 'bypassPermissions'] as const).map(permissionRank)
    expect(order).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('looser settings pend and stricter ones apply', () => {
    const cases: [string, (d: TeamDoc) => void, boolean][] = [
      ['permissionMode loosened', (d) => (d.settings.permissionMode = 'acceptEdits'), true],
      ['permissionMode bypass', (d) => (d.settings.permissionMode = 'bypassPermissions'), true],
      ['permissionMode tightened', (d) => (d.settings.permissionMode = 'plan'), false],
      ['isolateWriters off', (d) => (d.settings.isolateWriters = false), true],
      ['isolateWriters on again', (d) => (d.settings.isolateWriters = true), false],
      ['reviewMerges off from on', (d) => (d.settings.reviewMerges = false), true],
      ['autoContinue turned on', (d) => (d.settings.autoContinue = true), true],
      ['runMessaging turned on', (d) => (d.settings.runMessaging = true), true],
      ['budget raised', (d) => (d.settings.maxBudgetUsd = 50), true],
      ['budget removed', (d) => delete d.settings.maxBudgetUsd, true],
      ['budget lowered', (d) => (d.settings.maxBudgetUsd = 1), false],
      // Effective values: unset depth is automatic (here 2 from the chart), an explicit one clamps to the limit (5).
      ['depth set above the automatic value', (d) => (d.settings.maxSubagentDepth = 5), true],
      ['depth set to the automatic value', (d) => (d.settings.maxSubagentDepth = 2), false],
      ['depth 0 reads as automatic', (d) => (d.settings.maxSubagentDepth = 0), false],
      ['concurrency set high over unset', (d) => (d.settings.maxConcurrentSubagents = 20), true],
      ['concurrency set low over unset', (d) => (d.settings.maxConcurrentSubagents = 4), false],
      ['budget 0 means no cap', (d) => (d.settings.maxBudgetUsd = 0), true],
      ['auto-continue limit raised over unset', (d) => (d.settings.maxAutoContinues = 1000), true],
      ['auto-continue limit lowered under unset', (d) => (d.settings.maxAutoContinues = 10), false],
      ['window share set', (d) => (d.settings.maxWindowShare = 50), false],
      ['plan guard off', (d) => (d.settings.preferEverydayNearLimit = false), true],
      ['team review spends more', (d) => (d.settings.teamReview = { auto: 'ai', tokenBudget: 90000, everyRuns: 3 }), true],
      ['team review runs more often', (d) => (d.settings.teamReview = { auto: 'ai', tokenBudget: 20000, everyRuns: 1 }), true],
      ['team review spends less', (d) => (d.settings.teamReview = { auto: 'free', tokenBudget: 20000, everyRuns: 3 }), false],
      ['skill evaluation switched on with a bigger budget', (d) => (d.settings.skillEvaluation = { enabled: true, tokenBudget: 90000 }), true],
      ['brief', (d) => (d.settings.brief = 'A different brief'), false]
    ]
    for (const [label, mutate, pends] of cases) {
      const base = sampleDoc()
      if (label.startsWith('reviewMerges')) base.settings.reviewMerges = true
      if (label.startsWith('isolateWriters on')) base.settings.isolateWriters = false
      if (label.startsWith('autoContinue') || label.startsWith('runMessaging')) {
        base.settings.autoContinue = false
        base.settings.runMessaging = false
      }
      const r = gate(mutate, { approved: base })
      expect(r.pending.length > 0, label).toBe(pends)
      expect(r.applied.length > 0, label).toBe(!pends)
      if (pends) expect(r.effective.settings).toEqual(r.approved.settings)
    }
  })

  it('applies the stricter part of a mixed settings change and keeps the looser part pending', () => {
    const r = gate((d) => {
      d.settings.permissionMode = 'auto'
      d.settings.maxBudgetUsd = 1
    })
    expect(r.ids.pending).toEqual(['settings:permissionMode'])
    expect(r.ids.applied).toEqual(['settings:maxBudgetUsd'])
    expect(r.effective.settings.permissionMode).toBe('default')
    expect(r.effective.settings.maxBudgetUsd).toBe(1)
  })
})

describe('text in changes', () => {
  it('replaces hidden characters, caps text and always sets file and reason', () => {
    const r = gate((d) => {
      dev(d).name = 'De‮v​'
      dev(d).prompt = `Prompt‮ text\n${'x'.repeat(250_000)}`
      dev(d).tools = ['Bash', 'Read']
      d.mcp.push({ name: 'fresh', transport: 'stdio', command: 'run‮', enabled: true })
    })
    for (const c of r.pending) {
      expect(c.file).toBeTruthy()
      expect(c.reason).toBeTruthy()
      expect(c.summary).not.toMatch(/[‮​]/)
      expect(c.name).not.toMatch(/[‮​]/)
    }
    const prompt = r.applied.find((c) => c.id === 'role:dev:prompt')!
    expect(prompt.after!.length).toBeLessThanOrEqual(200_000)
    expect(prompt.after!.startsWith('Prompt? text\n')).toBe(true)
    expect(r.pending.find((c) => c.id === 'mcp:fresh')!.target).toBe('run?')
  })

  it('never cuts a target, even a long one', () => {
    const cmd = 'x'.repeat(2000)
    const r = gate((d) => d.mcp.push({ name: 'fresh', transport: 'stdio', command: cmd, enabled: true }))
    expect(r.pending.find((c) => c.id === 'mcp:fresh')!.target).toBe(cmd)
  })

  it('applied and pending changes are separate lists and all flagged correctly', () => {
    const r = gate((d) => {
      dev(d).prompt = 'p'
      dev(d).tools = ['Read', 'Bash', 'WebFetch']
    })
    expect(r.applied.every((c: TeamFileChange) => c.needsApproval === false && c.reason === undefined)).toBe(true)
    expect(r.pending.every((c: TeamFileChange) => c.needsApproval === true)).toBe(true)
  })
})

describe('first seen and previews', () => {
  it('first seen: everything pends and nothing applies, effective is the approved team', () => {
    const r = gate(
      (d) => {
        dev(d).prompt = 'p'
        d.roles = d.roles.filter((x) => x.slug !== 'reviewer')
        lead(d).spawnable = ['dev']
      },
      { firstSeen: true }
    )
    expect(r.applied).toEqual([])
    expect(r.pending.length).toBeGreaterThan(1)
    expect(r.pending.every((c) => c.reason === FIRST_SEEN_REASON)).toBe(true)
    expect(r.effective).toEqual(r.approved)
  })

  it('describeChanges(null, doc) lists everything as added and needing approval', () => {
    const changes = describeChanges(null, sampleDoc())
    expect(changes.every((c) => c.needsApproval && c.reason)).toBe(true)
    const ids = changes.map((c) => c.id)
    expect(ids).toContain('role:lead')
    expect(ids).toContain('role:dev')
    expect(ids).toContain('skill:code-style')
    expect(ids).toContain('mcp:docs')
    expect(changes.filter((c) => c.kind === 'role').every((c) => c.action === 'added')).toBe(true)
    expect(changes.find((c) => c.id === 'mcp:docs')!.target).toBe('MODE=read npx -y docs-server@1.2.3')
  })
})

describe('security review fixes', () => {
  const plain = (slug = 'tester', over = {}) => role(slug, { reportsTo: 'lead', ...over })

  it('a new role is trivial only with allowlisted tools: shell, MultiEdit and unknown tools pend', () => {
    for (const tools of [['PowerShell'], ['MultiEdit'], ['SomeNewTool'], ['Read', 'WebFetch'], ['Bash']]) {
      const r = gate((d) => d.roles.push(plain('tester', { tools })))
      expect(r.ids.pending, tools.join()).toEqual(['role:tester'])
      expect(r.effective.roles.map((x) => x.slug)).not.toContain('tester')
    }
    const ok = gate((d) => d.roles.push(plain('tester', { tools: ['Glob', 'Grep', 'Read', 'TodoWrite'] })))
    expect(ok.pending).toEqual([])
    expect(isElevatedTool('PowerShell')).toBe(true)
    expect(isElevatedTool('MultiEdit')).toBe(true)
    expect(isElevatedTool('Mystery')).toBe(true)
    expect(isElevatedTool('WebFetch')).toBe(false)
    expect(isElevatedTool('Read')).toBe(false)
  })

  it('added PowerShell and MultiEdit count as elevated on an existing role', () => {
    const r = gate((d) => (reviewer(d).tools = ['Glob', 'Grep', 'MultiEdit', 'PowerShell', 'Read']))
    expect(r.pending[0].elevatedAdded).toEqual(['MultiEdit', 'PowerShell'])
  })

  it('a new root always pends, and a root swap stays at the approved root', () => {
    const newRoot = gate((d) => d.roles.push(role('x', { reportsTo: null })))
    expect(newRoot.ids.pending).toEqual(['role:x'])
    expect(newRoot.pending[0].reason).toBe('New top of the chart')
    // new x.md root plus the old root reporting to x
    const swap = gate((d) => {
      d.roles.push(role('x', { reportsTo: null }))
      lead(d).reportsTo = 'x'
    })
    expect(swap.ids.pending).toEqual(['role:lead:root', 'role:x'])
    expect(lead(swap.effective).reportsTo).toBeNull()
    expect(swap.effective.roles.map((r) => r.slug)).toEqual(['dev', 'lead', 'reviewer'])
    // an existing role becoming the root pends; moving under a different parent applies
    const promote = gate((d) => (dev(d).reportsTo = null))
    expect(promote.ids.pending).toEqual(['role:dev:root'])
    expect(dev(promote.effective).reportsTo).toBe('lead')
    const move = gate((d) => (dev(d).reportsTo = 'reviewer'))
    expect(move.pending).toEqual([])
    expect(dev(move.effective).reportsTo).toBe('reviewer')
  })

  it('a model that may spend more or a raised effort pends; a lower tier applies', () => {
    const cases: [string, (d: TeamDoc) => void, boolean][] = [
      ['tier raised', (d) => (dev(d).tier = 'top'), true],
      ['tier lowered', (d) => (dev(d).tier = 'fast'), false],
      ['pinned model', (d) => ((dev(d).tier = undefined), (dev(d).model = 'some-model-1')), true],
      ['inherit', (d) => ((dev(d).tier = undefined), (dev(d).model = 'inherit')), true],
      ['effort raised', (d) => (lead(d).effort = 'max'), true],
      ['effort lowered', (d) => (lead(d).effort = 'low'), false],
      ['effort set over unset', (d) => (dev(d).effort = 'low'), true]
    ]
    for (const [label, mutate, pends] of cases) {
      const r = gate(mutate)
      expect(r.pending.length > 0, label).toBe(pends)
      if (pends) expect(r.pending[0].reason).toBe('May spend more')
    }
    const pinned = sampleDoc()
    dev(pinned).tier = undefined
    dev(pinned).model = 'one-model'
    const between = gate((d) => (dev(d).model = 'other-model'), { approved: pinned })
    expect(between.ids.pending).toEqual(['role:dev:model'])
    expect(dev(between.effective).model).toBe('one-model')
  })

  it('turning fromLibrary on or off is a launch change and waits', () => {
    const on = gate((d) => (d.mcp[0].fromLibrary = true))
    expect(on.ids.pending).toEqual(['mcp:docs:launch'])
    expect(on.effective.mcp[0].fromLibrary).toBeUndefined()
    const base = sampleDoc()
    base.mcp[0].fromLibrary = true
    const off = gate((d) => delete d.mcp[0].fromLibrary, { approved: base })
    expect(off.ids.pending).toEqual(['mcp:docs:launch'])
  })

  it('a linked server shows the ENTRY target, says it uses the stored sign-in and names the roles that reach it', () => {
    const link: LinkResolver = (m) => (m.name === 'gh' || m.name === 'any' ? { target: 'https://entry.example/mcp' } : null)
    const approved = sampleDoc()
    const disk = clone(approved)
    disk.mcp.push({ name: 'gh', transport: 'http', url: 'https://entry.example/mcp', enabled: true, connectorId: 'github', roles: ['dev'] })
    disk.mcp.push({ name: 'any', transport: 'http', url: 'https://entry.example/mcp', enabled: true, connectorId: 'github' })
    const r = gateTeam(approved, disk, { link })
    const gh = r.pending.find((c) => c.id === 'mcp:gh')!
    expect(gh).toMatchObject({ target: 'https://entry.example/mcp', usesStoredSignIn: true, reachesRoles: ['dev'] })
    expect(gh.summary).toContain('sign-in stored on this computer')
    expect(gh.summary).toContain('Available to dev')
    const any = r.pending.find((c) => c.id === 'mcp:any')!
    expect(any.summary).toContain('Available to every role')
    expect(any.reachesRoles).toBeUndefined()
    // Without a resolved link the file's own target is shown and nothing claims a stored sign-in.
    const plainLink = gateTeam(approved, disk).pending.find((c) => c.id === 'mcp:gh')!
    expect(plainLink.usesStoredSignIn).toBeUndefined()
  })

  it('N3: a connector with no entry on this computer yet says the user will need to sign in, not that a stored sign-in is used', () => {
    const link: LinkResolver = () => ({ target: 'https://entry.example/mcp', stored: false })
    const approved = sampleDoc()
    const disk = clone(approved)
    disk.mcp.push({ name: 'gh', transport: 'http', url: 'https://entry.example/mcp', enabled: true, connectorId: 'github' })
    const gh = gateTeam(approved, disk, { link }).pending.find((c) => c.id === 'mcp:gh')!
    expect(gh.usesStoredSignIn).toBeUndefined()
    expect(gh.summary).toContain('and you will need to sign in.')
    expect(gh.summary).not.toContain('stored on this computer')
    expect(gh.summary).toBe('New service gh would connect to the address shown, and you will need to sign in. Available to every role.')
  })

  it('lists the most powerful changes first: loosening settings, elevated roles, services, skills, the rest', () => {
    const r = gate((d) => {
      d.settings.permissionMode = 'bypassPermissions'
      d.skills.push({ name: 'aaa', description: 'x', body: 'y', files: [], enabled: true })
      d.mcp.push({ name: 'zzz', transport: 'stdio', command: 'npx', args: ['-y', 'zzz@1.0.0'], enabled: true })
      d.roles.push(plain('boss', { tools: ['Bash'] }))
      d.roles.push(plain('mere', { tools: ['Read', 'WebFetch'] }))
    })
    expect(r.ids.pending).toEqual(['settings:permissionMode', 'role:boss', 'mcp:zzz', 'skill:aaa', 'role:mere'])
  })
})

describe('gateTeam staffing', () => {
  /** An approved team with `setup` applied, then the same change made on disk. */
  function staffed(setup: (d: TeamDoc) => void, mutate: (d: TeamDoc) => void) {
    const approved = sampleDoc()
    setup(approved)
    return gate(mutate, { approved })
  }
  /** arch: a deep role on high effort under the lead (the root itself runs as fixed, whatever its staffing says). */
  const arch = (d: TeamDoc) => d.roles.find((r) => r.slug === 'arch')!
  const withArch = (d: TeamDoc): void => void d.roles.push(role('arch', { tier: 'deep', effort: 'high', tools: ['Read'] }))
  const staffedA = (setup: (d: TeamDoc) => void, mutate: (d: TeamDoc) => void) => staffed((d) => (withArch(d), setup(d)), mutate)
  const gateA = (mutate: (d: TeamDoc) => void) => staffedA(() => {}, mutate)
  const held = (r: ReturnType<typeof gate>, id: string): void => {
    expect(r.ids.pending).toEqual([id])
    expect(r.pending[0]).toMatchObject({ needsApproval: true, reason: 'May spend more' })
  }

  it('holds a raised maxEffort and applies a lowered one', () => {
    const setup = (d: TeamDoc): void => void (arch(d).staffing = { mode: 'auto', maxEffort: 'medium' })
    const up = staffedA(setup, (d) => (arch(d).staffing = { mode: 'auto', maxEffort: 'xhigh' }))
    held(up, 'role:arch:staffing')
    expect(arch(up.effective).staffing).toEqual({ mode: 'auto', maxEffort: 'medium' })
    const down = staffedA(setup, (d) => (arch(d).staffing = { mode: 'auto', maxEffort: 'low' }))
    expect(down.pending).toEqual([])
    expect(down.ids.applied).toContain('role:arch:details')
    expect(arch(down.effective).staffing).toEqual({ mode: 'auto', maxEffort: 'low' })
  })

  it('judges a first maxEffort against the effective ceiling (the role effort, else high)', () => {
    // arch: effort high, no staffing: ceiling high.
    held(gateA((d) => (arch(d).staffing = { mode: 'auto', maxEffort: 'max' })), 'role:arch:staffing')
    expect(gateA((d) => (arch(d).staffing = { mode: 'auto', maxEffort: 'high' })).pending).toEqual([])
    expect(gateA((d) => (arch(d).staffing = { mode: 'auto', maxEffort: 'low' })).pending).toEqual([])
    // dev: no effort and no staffing: ceiling high.
    held(gateA((d) => (dev(d).staffing = { mode: 'auto', maxEffort: 'xhigh' })), 'role:dev:staffing')
    expect(gateA((d) => (dev(d).staffing = { mode: 'auto', maxEffort: 'medium' })).pending).toEqual([])
  })

  it('holds a removed maxEffort only when that raises the ceiling', () => {
    // arch (effort high): maxEffort low removed -> ceiling high: raised.
    const raised = staffedA((d) => (arch(d).staffing = { mode: 'auto', maxEffort: 'low' }), (d) => (arch(d).staffing = { mode: 'auto' }))
    held(raised, 'role:arch:staffing')
    // arch: maxEffort max removed -> ceiling high: lowered.
    const lowered = staffedA((d) => (arch(d).staffing = { mode: 'auto', maxEffort: 'max' }), (d) => (arch(d).staffing = { mode: 'auto' }))
    expect(lowered.pending).toEqual([])
    // dev (no effort): maxEffort medium removed -> high: raised; xhigh removed -> high: lowered; high removed -> high: same.
    held(staffed((d) => (dev(d).staffing = { mode: 'auto', maxEffort: 'medium' }), (d) => (dev(d).staffing = { mode: 'auto' })), 'role:dev:staffing')
    expect(staffed((d) => (dev(d).staffing = { mode: 'auto', maxEffort: 'xhigh' }), (d) => (dev(d).staffing = { mode: 'auto' })).pending).toEqual([])
    expect(staffed((d) => (dev(d).staffing = { mode: 'auto', maxEffort: 'high' }), (d) => (dev(d).staffing = { mode: 'auto' })).pending).toEqual([])
    // The whole staffing block removed is the same thing.
    held(staffed((d) => (dev(d).staffing = { mode: 'auto', maxEffort: 'low' }), (d) => delete dev(d).staffing), 'role:dev:staffing')
  })

  const summary = (r: ReturnType<typeof gate>, id: string): string | undefined => r.pending.find((c) => c.id === id)?.summary
  /** Every role on an effort of its own at or above high: a project switch to automatic then raises nobody's maximum. */
  const allHigh = (d: TeamDoc): void => void d.roles.forEach((r) => (r.effort = r.effort ?? 'high'))

  it('holds a removed role effort when it raises the most a run may send, and keeps the approved effort', () => {
    // Automatic, no cap: low -> picked up to high.
    const r = staffed((d) => (dev(d).effort = 'low'), (d) => delete dev(d).effort)
    held(r, 'role:dev:effort')
    expect(dev(r.effective).effort).toBe('low')
    expect(summary(r, 'role:dev:effort')).toBe("Dev's reasoning effort is removed, so it may be picked up to high effort instead of low and it runs at medium effort when nothing is picked (low before). This may spend more.")
    // Rewritten ('ok', from the review): automatic with a cap of low. The cap still bounds it (the resolver sends the cap
    // when no effort is given, runtime/staffing.ts rule 3), so the most a run may send stays low and it applies.
    const ok = staffed((d) => ((dev(d).effort = 'low'), (dev(d).staffing = { mode: 'auto', maxEffort: 'low' })), (d) => delete dev(d).effort)
    expect(ok.pending).toEqual([])
    expect(dev(ok.effective).effort).toBeUndefined()
    // The same removal on a fixed role (or under a fixed project) runs at the default, medium: held (defect 2 below).
    // Removing an effort at or above the default, or above an automatic role's reach, applies.
    expect(staffed((d) => ((d.settings.staffing = 'fixed'), (dev(d).effort = 'medium')), (d) => delete dev(d).effort).pending).toEqual([])
    expect(staffed((d) => ((d.settings.staffing = 'fixed'), (dev(d).effort = 'high')), (d) => delete dev(d).effort).pending).toEqual([])
    expect(gate((d) => delete lead(d).effort).pending).toEqual([])
    // A lowered effort applies in either mode.
    expect(gate((d) => (lead(d).effort = 'low')).pending).toEqual([])
    expect(staffed((d) => (d.settings.staffing = 'fixed'), (d) => (lead(d).effort = 'low')).pending).toEqual([])
  })

  it('a removed effort with a cap added in the same save applies when the cap keeps the maximum, as it does over two saves', () => {
    // Rewritten ('both', from the review): automatic, effort low removed and cap low added: the most a run may send stays
    // low (the staffing row is judged alone, the effort row on the staffing as it settles), so both apply.
    const both = staffed((d) => (dev(d).effort = 'low'), (d) => (delete dev(d).effort, (dev(d).staffing = { mode: 'auto', maxEffort: 'low' })))
    expect(both.pending).toEqual([])
    expect(dev(both.effective).effort).toBeUndefined()
    expect(dev(both.effective).staffing).toEqual({ mode: 'auto', maxEffort: 'low' })
    expect(both.applied.find((c) => c.id === 'role:dev:details')?.summary).toBe("Dev's effort and staffing limits changed.")
    // Split over two saves: the cap first, then the effort; the same team at the end.
    const first = staffed((d) => (dev(d).effort = 'low'), (d) => (dev(d).staffing = { mode: 'auto', maxEffort: 'low' }))
    expect(first.pending).toEqual([])
    const second = gate((d) => delete dev(d).effort, { approved: first.effective })
    expect(second.pending).toEqual([])
    expect(second.effective).toEqual(both.effective)
    // The other order: the effort alone waits (nothing caps it yet); once the cap is approved it applies.
    held(staffed((d) => (dev(d).effort = 'low'), (d) => delete dev(d).effort), 'role:dev:effort')
    // Under a fixed project the cap does nothing and the effort falls to the default, medium: the effort row waits, in one
    // save or in two.
    const fixedBoth = staffed((d) => ((d.settings.staffing = 'fixed'), (dev(d).effort = 'low')), (d) => (delete dev(d).effort, (dev(d).staffing = { mode: 'auto', maxEffort: 'low' })))
    held(fixedBoth, 'role:dev:effort')
    expect(dev(fixedBoth.effective)).toMatchObject({ effort: 'low', staffing: { mode: 'auto', maxEffort: 'low' } })
    expect(summary(fixedBoth, 'role:dev:effort')).toBe("Dev's reasoning effort is removed, so it runs at the default effort (medium) instead of low. This may spend more.")
    const fixedFirst = staffed((d) => ((d.settings.staffing = 'fixed'), (dev(d).effort = 'low')), (d) => (dev(d).staffing = { mode: 'auto', maxEffort: 'low' }))
    expect(fixedFirst.pending).toEqual([])
    held(gate((d) => delete dev(d).effort, { approved: fixedFirst.effective }), 'role:dev:effort')
  })

  it('a removed effort with an inert staffing change holds only the effort row', () => {
    const r = staffed((d) => (dev(d).effort = 'low'), (d) => (delete dev(d).effort, (dev(d).staffing = { mode: 'auto' })))
    held(r, 'role:dev:effort')
    expect(dev(r.effective)).toMatchObject({ effort: 'low', staffing: { mode: 'auto' } })
    expect(r.ids.applied).toEqual(['role:dev:details'])
  })

  it('keeps a raised effort held and judges staffing against the approved effort', () => {
    // effort low -> high is held by the effort rule; maxEffort high added in the same change lifts nothing the effort rule did not.
    const r = staffed((d) => (dev(d).effort = 'low'), (d) => ((dev(d).effort = 'high'), (dev(d).staffing = { mode: 'auto', maxEffort: 'high' })))
    expect(r.ids.pending.sort()).toEqual(['role:dev:effort', 'role:dev:staffing'])
    expect(dev(r.effective).effort).toBe('low')
    expect(dev(r.effective).staffing).toBeUndefined()
    expect(summary(r, 'role:dev:effort')).toBe("Dev's reasoning effort is raised and may spend more.")
    expect(summary(r, 'role:dev:staffing')).toBe("Dev's effort ceiling is raised from low to high. This may spend more.")
  })

  it('holds a tier floor that is added or raised and applies one that is lowered or removed', () => {
    const setup = (d: TeamDoc): void => void (arch(d).staffing = { mode: 'auto', minTier: 'everyday' })
    const added = gateA((d) => (arch(d).staffing = { mode: 'auto', minTier: 'fast' }))
    held(added, 'role:arch:staffing')
    expect(summary(added, 'role:arch:staffing')).toBe('Arch gets a lowest tier of fast. This may spend more.')
    const raised = staffedA(setup, (d) => (arch(d).staffing = { mode: 'auto', minTier: 'deep' }))
    held(raised, 'role:arch:staffing')
    expect(summary(raised, 'role:arch:staffing')).toBe("Arch's lowest tier is raised from everyday to deep. This may spend more.")
    expect(staffedA(setup, (d) => (arch(d).staffing = { mode: 'auto', minTier: 'fast' })).pending).toEqual([])
    expect(staffedA(setup, (d) => (arch(d).staffing = { mode: 'auto' })).pending).toEqual([])
    expect(staffedA(setup, (d) => delete arch(d).staffing).pending).toEqual([])
  })

  it('judges the effective floor: one above the role tier does nothing and applies; on a role with no tier it counts', () => {
    // arch is deep, dev everyday: a floor above them is dropped at run time (effectiveRoleStaffing).
    expect(gateA((d) => (arch(d).staffing = { mode: 'auto', minTier: 'top' })).pending).toEqual([])
    const above = gateA((d) => (dev(d).staffing = { mode: 'auto', minTier: 'deep' }))
    expect(above.pending).toEqual([])
    expect(dev(above.effective).staffing).toEqual({ mode: 'auto', minTier: 'deep' })
    // reviewer inherits (no tier): any floor works.
    held(gate((d) => (reviewer(d).staffing = { mode: 'auto', minTier: 'deep' })), 'role:reviewer:staffing')
    // A floor on a fixed role does nothing and applies; it is counted when the role becomes automatic.
    expect(staffed((d) => (dev(d).staffing = { mode: 'fixed' }), (d) => (dev(d).staffing = { mode: 'fixed', minTier: 'fast' })).pending).toEqual([])
    const toAuto = staffed((d) => (dev(d).staffing = { mode: 'fixed', minTier: 'fast' }), (d) => (dev(d).staffing = { mode: 'auto', minTier: 'fast' }))
    held(toAuto, 'role:dev:staffing')
    expect(summary(toAuto, 'role:dev:staffing')).toBe('Dev becomes automatic and may be picked up to high effort (it ran at medium); Dev gets a lowest tier of fast. This may spend more.')
  })

  it('holds a role going from automatic to fixed, and fixed to automatic only when its maximum rises', () => {
    const toFixed = gate((d) => (dev(d).staffing = { mode: 'fixed' }))
    held(toFixed, 'role:dev:staffing')
    expect(dev(toFixed.effective).staffing).toBeUndefined()
    expect(summary(toFixed, 'role:dev:staffing')).toBe('Dev becomes fixed: it always runs at its configured model and effort. This may spend more.')
    held(staffed((d) => (dev(d).staffing = { mode: 'auto' }), (d) => (dev(d).staffing = { mode: 'fixed' })), 'role:dev:staffing')
    // Even with a low cap: a fixed role ignores it.
    held(gate((d) => (dev(d).staffing = { mode: 'fixed', maxEffort: 'low' })), 'role:dev:staffing')
    // Rewritten: fixed with no effort ran at the default (medium); automatic may pick it up to high.
    const toAuto = staffed((d) => (dev(d).staffing = { mode: 'fixed' }), (d) => (dev(d).staffing = { mode: 'auto' }))
    held(toAuto, 'role:dev:staffing')
    expect(dev(toAuto.effective).staffing).toEqual({ mode: 'fixed' })
    expect(summary(toAuto, 'role:dev:staffing')).toBe('Dev becomes automatic and may be picked up to high effort (it ran at medium). This may spend more.')
    // Fixed at high (or at low with a low cap) to automatic raises nothing: it applies.
    const even = staffed((d) => ((dev(d).effort = 'high'), (dev(d).staffing = { mode: 'fixed' })), (d) => (dev(d).staffing = { mode: 'auto' }))
    expect(even.pending).toEqual([])
    expect(dev(even.effective).staffing).toEqual({ mode: 'auto' })
    expect(staffed((d) => ((dev(d).effort = 'low'), (dev(d).staffing = { mode: 'fixed', maxEffort: 'low' })), (d) => (dev(d).staffing = { mode: 'auto', maxEffort: 'low' })).pending).toEqual([])
    // A role that is automatic only because the project is not fixed: fixed on the role is still a raise.
    held(staffed((d) => (d.settings.staffing = undefined), (d) => (dev(d).staffing = { mode: 'fixed' })), 'role:dev:staffing')
  })

  it('names a raised or removed effort ceiling in the summary', () => {
    const raised = staffedA((d) => (arch(d).staffing = { mode: 'auto', maxEffort: 'medium' }), (d) => (arch(d).staffing = { mode: 'auto', maxEffort: 'xhigh' }))
    expect(summary(raised, 'role:arch:staffing')).toBe("Arch's effort ceiling is raised from medium to xhigh; Arch runs at high effort when nothing is picked (medium before). This may spend more.")
    const removed = staffedA((d) => (dev(d).staffing = { mode: 'auto', maxEffort: 'low' }), (d) => (dev(d).staffing = { mode: 'auto' }))
    expect(summary(removed, 'role:dev:staffing')).toBe("Dev's effort ceiling is removed, so it may be picked up to high effort (up to low before); Dev runs at medium effort when nothing is picked (low before). This may spend more.")
    // Two things at once are both named.
    const twice = gate((d) => (reviewer(d).staffing = { mode: 'auto', maxEffort: 'max', minTier: 'everyday' }))
    expect(summary(twice, 'role:reviewer:staffing')).toBe("Reviewer's effort ceiling is raised from high to max; Reviewer gets a lowest tier of everyday. This may spend more.")
  })

  it('holds the project going from auto to fixed, and fixed to auto only when some role may then spend more', () => {
    const toFixed = gate((d) => (d.settings.staffing = 'fixed'))
    held(toFixed, 'settings:staffing')
    expect(toFixed.effective.settings.staffing).toBeUndefined()
    expect(summary(toFixed, 'settings:staffing')).toBe(
      'Automatic staffing changes from automatic to off (every role runs as configured). Dev and Reviewer would then always run at their configured model and effort, which may spend more.'
    )
    // Every role already fixed on its own: nothing becomes fixed, so it applies.
    const allFixed = (d: TeamDoc): void => void d.roles.forEach((r) => (r.staffing = { mode: 'fixed' }))
    expect(staffed(allFixed, (d) => (d.settings.staffing = 'fixed')).pending).toEqual([])
    // Rewritten: fixed to automatic with dev and reviewer on no effort (the default, medium): they may be picked up to high.
    const toAuto = staffed((d) => (d.settings.staffing = 'fixed'), (d) => delete d.settings.staffing)
    held(toAuto, 'settings:staffing')
    expect(toAuto.effective.settings.staffing).toBe('fixed')
    expect(summary(toAuto, 'settings:staffing')).toBe(
      'Automatic staffing changes from off (every role runs as configured) to automatic. Dev and Reviewer may then run at a higher effort or tier than they do now.'
    )
    // With every role on high, or capped at what fixed ran at, it applies.
    const even = staffed((d) => ((d.settings.staffing = 'fixed'), allHigh(d)), (d) => delete d.settings.staffing)
    expect(even.pending).toEqual([])
    expect(even.ids.applied).toEqual(['settings:staffing'])
    const capped = staffed(
      (d) => ((d.settings.staffing = 'fixed'), (dev(d).staffing = { mode: 'auto', maxEffort: 'medium' }), (reviewer(d).effort = 'low'), (reviewer(d).staffing = { mode: 'auto', maxEffort: 'low' })),
      (d) => delete d.settings.staffing
    )
    expect(capped.pending).toEqual([])
  })

  it('judges a project switch against every role, also roles whose own staffing does not change', () => {
    // Only reviewer would rise; its file is untouched.
    const r = staffed((d) => ((d.settings.staffing = 'fixed'), (dev(d).effort = 'high')), (d) => delete d.settings.staffing)
    held(r, 'settings:staffing')
    expect(summary(r, 'settings:staffing')).toContain('Reviewer may then run at a higher effort or tier than it does now.')
    // A role edit that lowers its reach in the same save is taken into account: a cap on reviewer makes the switch safe.
    const withCap = staffed((d) => ((d.settings.staffing = 'fixed'), (dev(d).effort = 'high')), (d) => (delete d.settings.staffing, (reviewer(d).staffing = { mode: 'auto', maxEffort: 'medium' })))
    expect(withCap.pending).toEqual([])
    expect(withCap.effective.settings.staffing).toBeUndefined()
    expect(reviewer(withCap.effective).staffing).toEqual({ mode: 'auto', maxEffort: 'medium' })
  })

  it('does not hold the goal or the review policy, and still lists them', () => {
    for (const [k, v] of [['staffingGoal', 'speed'], ['staffingGoal', 'cost'], ['reviewPolicy', 'always'], ['reviewPolicy', 'never']] as const) {
      const r = gate((d) => ((d.settings as unknown as Record<string, unknown>)[k] = v))
      expect(r.pending, `${k}=${v}`).toEqual([])
      expect(r.ids.applied).toEqual([`settings:${k}`])
      expect((r.effective.settings as unknown as Record<string, unknown>)[k]).toBe(v)
    }
  })

  it('a project that is fixed does not hide a raised role ceiling', () => {
    // Rewritten so the switch alone raises nobody (every role on high): it applies, and the raised cap is held.
    const r = staffed(
      (d) => ((d.settings.staffing = 'fixed'), allHigh(d), (dev(d).staffing = { mode: 'auto', maxEffort: 'low' })),
      (d) => ((delete d.settings.staffing), (dev(d).staffing = { mode: 'auto', maxEffort: 'max' }))
    )
    expect(r.ids.applied).toContain('settings:staffing')
    held(r, 'role:dev:staffing')
    // While the switch itself waits, a role change is judged under the mode on disk too: the cap raise, inert under
    // fixed, still waits instead of applying and riding along when the switch is approved.
    const waiting = staffed(
      (d) => ((d.settings.staffing = 'fixed'), (dev(d).staffing = { mode: 'auto', maxEffort: 'low' })),
      (d) => ((delete d.settings.staffing), (dev(d).staffing = { mode: 'auto', maxEffort: 'max' }))
    )
    expect(waiting.ids.pending.sort()).toEqual(['role:dev:staffing', 'settings:staffing'])
    expect(dev(waiting.effective).staffing).toEqual({ mode: 'auto', maxEffort: 'low' })
  })

  it('defect 2: a removed effort on a fixed role or under a fixed project is held (the default, medium, is above low)', () => {
    const role = staffed((d) => ((dev(d).effort = 'low'), (dev(d).staffing = { mode: 'fixed', maxEffort: 'low' })), (d) => delete dev(d).effort)
    held(role, 'role:dev:effort')
    expect(dev(role.effective).effort).toBe('low')
    const project = staffed((d) => ((d.settings.staffing = 'fixed'), (dev(d).effort = 'low'), (dev(d).staffing = { mode: 'auto', maxEffort: 'low' })), (d) => delete dev(d).effort)
    held(project, 'role:dev:effort')
    expect(dev(project.effective).effort).toBe('low')
  })

  it('defect 3: fixed becoming automatic is held when it lets a role run above what fixed ran at', () => {
    // The project: dev has no effort and ran at the default (medium); automatic may pick it up to high.
    const project = staffed((d) => (d.settings.staffing = 'fixed'), (d) => delete d.settings.staffing)
    held(project, 'settings:staffing')
    expect(project.effective.settings.staffing).toBe('fixed')
    // The role: fixed at low with a max ceiling; automatic may pick it up to max.
    const role = staffed((d) => ((dev(d).effort = 'low'), (dev(d).staffing = { mode: 'fixed', maxEffort: 'max' })), (d) => (dev(d).staffing = { mode: 'auto', maxEffort: 'max' }))
    held(role, 'role:dev:staffing')
    expect(dev(role.effective).staffing).toEqual({ mode: 'fixed', maxEffort: 'max' })
    expect(summary(role, 'role:dev:staffing')).toBe('Dev becomes automatic and may be picked up to max effort (it ran at low). This may spend more.')
  })

  it('with everything forced pending nothing staffing-related applies', () => {
    const approved = sampleDoc()
    const disk = clone(approved)
    dev(disk).staffing = { mode: 'auto', maxEffort: 'low' }
    const r = gateTeam(approved, disk, { firstSeen: true })
    expect(r.applied).toEqual([])
    expect(dev(r.effective).staffing).toBeUndefined()
  })
})


describe('gateTeam staffing, second review', () => {
  function staffed(setup: (d: TeamDoc) => void, mutate: (d: TeamDoc) => void) {
    const approved = sampleDoc()
    setup(approved)
    return gate(mutate, { approved })
  }
  const summary = (r: ReturnType<typeof gate>, id: string): string | undefined => r.pending.find((c) => c.id === id)?.summary

  it('item 1: the root runs as fixed, so removing its effort under a low cap is held and a switch to fixed does not name it', () => {
    const r = staffed((d) => ((lead(d).effort = 'low'), (lead(d).staffing = { mode: 'auto', maxEffort: 'low' })), (d) => delete lead(d).effort)
    expect(r.ids.pending).toEqual(['role:lead:effort'])
    expect(lead(r.effective).effort).toBe('low')
    expect(summary(r, 'role:lead:effort')).toBe("Lead's reasoning effort is removed, so it runs at the default effort (medium) instead of low. This may spend more.")
    const toFixed = gate((d) => (d.settings.staffing = 'fixed'))
    expect(summary(toFixed, 'settings:staffing')).toBe(
      'Automatic staffing changes from automatic to off (every role runs as configured). Dev and Reviewer would then always run at their configured model and effort, which may spend more.'
    )
    // The root's staffing settings do nothing: a floor or a raised cap on it applies.
    expect(gate((d) => (lead(d).staffing = { mode: 'auto', minTier: 'deep', maxEffort: 'max' })).pending).toEqual([])
  })

  it('item 2: a role the resolver cannot size runs as fixed: a concrete model, and an inherit role read both ways', () => {
    const concrete = staffed(
      (d) => (delete dev(d).tier, (dev(d).model = 'gpt-5-mini'), (dev(d).effort = 'low')),
      (d) => (delete dev(d).effort, (dev(d).staffing = { mode: 'auto', maxEffort: 'low' }))
    )
    expect(concrete.ids.pending).toEqual(['role:dev:effort'])
    expect(dev(concrete.effective)).toMatchObject({ effort: 'low', staffing: { mode: 'auto', maxEffort: 'low' } })
    const inherit = staffed((d) => ((reviewer(d).effort = 'low'), (reviewer(d).staffing = { mode: 'auto', maxEffort: 'low' })), (d) => delete reviewer(d).effort)
    expect(inherit.ids.pending).toEqual(['role:reviewer:effort'])
    expect(summary(inherit, 'role:reviewer:effort')).toBe("Reviewer's reasoning effort is removed, so it runs at the default effort (medium) instead of low. This may spend more.")
    // Read as automatic (the parent's tier is known), a floor on an inherit role still counts.
    expect(gate((d) => (reviewer(d).staffing = { mode: 'auto', minTier: 'everyday' })).ids.pending).toEqual(['role:reviewer:staffing'])
  })

  it('item 3: held rows state the whole move to the role on disk', () => {
    const r = staffed((d) => ((dev(d).effort = 'low'), (dev(d).staffing = { mode: 'auto', maxEffort: 'low' })), (d) => (delete dev(d).effort, (dev(d).staffing = { mode: 'auto', minTier: 'fast' })))
    expect(r.ids.pending).toEqual(['role:dev:staffing'])
    expect(summary(r, 'role:dev:staffing')).toBe(
      "Dev's effort ceiling is removed, so it may be picked up to high effort (up to low before); Dev runs at medium effort when nothing is picked (low before); Dev gets a lowest tier of fast. This may spend more."
    )
    // The effort removal that spends no more under the approved cap applies.
    expect(dev(r.effective)).toMatchObject({ staffing: { mode: 'auto', maxEffort: 'low' } })
    expect(dev(r.effective).effort).toBeUndefined()
    // Two held rows, each judged alone, that together leave a rise unsaid: the first held row says it.
    const two = staffed((d) => (dev(d).effort = 'low'), (d) => ((dev(d).effort = 'high'), (dev(d).staffing = { mode: 'auto', maxEffort: 'medium' })))
    expect(two.ids.pending.sort()).toEqual(['role:dev:effort', 'role:dev:staffing'])
    expect(summary(two, 'role:dev:effort')).toBe("Dev's reasoning effort is raised and may spend more.")
    expect(summary(two, 'role:dev:staffing')).toBe(
      "Dev's effort ceiling is raised from low to medium. This may spend more. With the rest of this change, Dev runs at medium effort when nothing is picked (low before)."
    )
  })

  it('item 4: settles to a fixpoint in one call, so a second call applies nothing and keeps every summary', () => {
    // Pass 1 would hold the staffing row (effort medium still on the approved role) and apply the lowered effort; on that
    // result the staffing change spends no more, so it applies in the same call.
    const r = staffed((d) => ((dev(d).effort = 'medium'), (dev(d).staffing = { mode: 'auto', maxEffort: 'low' })), (d) => ((dev(d).effort = 'low'), delete dev(d).staffing))
    expect(r.pending).toEqual([])
    expect(dev(r.effective).effort).toBe('low')
    expect(dev(r.effective).staffing).toBeUndefined()
    // The same beside a held project switch.
    const beside = staffed(
      (d) => ((d.settings.staffing = 'fixed'), (dev(d).effort = 'medium'), (dev(d).staffing = { mode: 'auto', maxEffort: 'low' })),
      (d) => (delete d.settings.staffing, (dev(d).effort = 'low'), delete dev(d).staffing)
    )
    expect(beside.ids.pending).toEqual(['settings:staffing'])
    expect(dev(beside.effective).staffing).toBeUndefined()
  })

  it('item 5: a rise in what a role runs at when nothing is picked is held', () => {
    for (const maxEffort of ['medium', 'high', 'max'] as const) {
      const r = staffed((d) => ((dev(d).effort = 'low'), (dev(d).staffing = { mode: 'auto', maxEffort })), (d) => delete dev(d).effort)
      expect(r.ids.pending, maxEffort).toEqual(['role:dev:effort'])
      expect(summary(r, 'role:dev:effort')).toBe("Dev's reasoning effort is removed, so it runs at medium effort when nothing is picked (low before). This may spend more.")
    }
    // Removing an effort at or above the default under a cap that keeps it applies.
    expect(staffed((d) => ((dev(d).effort = 'medium'), (dev(d).staffing = { mode: 'auto', maxEffort: 'medium' })), (d) => delete dev(d).effort).pending).toEqual([])
  })
})

describe('gateTeam staffing grid (sampled; the run-time spend comes from resolveStaffing)', () => {
  const TR: Record<string, number> = { fast: 0, everyday: 1, deep: 2, top: 3 }
  const ER: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }
  type Kind = 'tier' | 'inherit' | 'concrete'
  interface W {
    kind: Kind
    tier?: ModelTier
    effort?: Effort
    mode?: 'auto' | 'fixed'
    maxEffort?: Effort
    minTier?: ModelTier
  }
  const docOf = (w: W, project: 'fixed' | undefined): TeamDoc => {
    const r = role('w', { tools: ['Read'] })
    delete r.tier
    if (w.kind === 'tier') r.tier = w.tier
    else r.model = w.kind === 'inherit' ? 'inherit' : 'gpt-5-mini'
    if (w.effort) r.effort = w.effort
    if (w.mode) r.staffing = { mode: w.mode, ...(w.minTier ? { minTier: w.minTier } : {}), ...(w.maxEffort ? { maxEffort: w.maxEffort } : {}) }
    return {
      settings: { brief: '', permissionMode: 'default', ...(project ? { staffing: project } : {}) },
      roles: [role('lead', { reportsTo: null, canSpawn: true, spawnable: ['w'], tier: 'deep' }), r],
      skills: [],
      mcp: []
    }
  }
  const REQS: ({ tier?: ModelTier; effort?: Effort } | undefined)[] = [undefined]
  for (const t of [undefined, ...MODEL_TIERS]) for (const e of [undefined, ...EFFORTS]) if (t || e) REQS.push({ ...(t ? { tier: t } : {}), ...(e ? { effort: e } : {}) })
  /** Highest, lowest and no-pick effort and the lowest and highest tier role w can run at (an unknown tier counts as a constant). */
  const spend = (d: TeamDoc, noParent: boolean) => {
    const r = d.roles.find((x) => x.slug === 'w')!
    const rt = { model: r.tier ? `m-${r.tier}` : r.model!, tier: r.tier, effort: r.effort, staffing: r.staffing }
    const out = { maxE: -1, minE: 9, defE: 0, minT: 9, maxT: -1 }
    REQS.forEach((req, i) => {
      const s = resolveStaffing({ role: rt, project: { staffing: d.settings.staffing }, parentTier: noParent ? undefined : 'deep', requested: req, tierModels: { fast: 'm-fast', everyday: 'm-everyday', deep: 'm-deep', top: 'm-top' }, adapterEfforts: [...EFFORTS] })
      const e = ER[s.effort ?? 'medium']
      const t = s.tier ? TR[s.tier] : 1.5
      out.maxE = Math.max(out.maxE, e)
      out.minE = Math.min(out.minE, e)
      out.minT = Math.min(out.minT, t)
      out.maxT = Math.max(out.maxT, t)
      if (i === 0) out.defE = e
    })
    return out
  }
  const rises = (a: ReturnType<typeof spend>, b: ReturnType<typeof spend>): string[] => (['maxE', 'minE', 'defE', 'minT', 'maxT'] as const).filter((k) => b[k] > a[k])
  const states = (kinds: Kind[]): W[] => {
    const out: W[] = []
    for (const kind of kinds)
      for (const tier of kind === 'tier' ? (['everyday', 'deep'] as ModelTier[]) : [undefined])
        for (const effort of [undefined, 'low', 'medium', 'high', 'max'] as (Effort | undefined)[])
          for (const mode of [undefined, 'auto', 'fixed'] as const)
            for (const maxEffort of mode ? ([undefined, 'low', 'medium', 'max'] as (Effort | undefined)[]) : [undefined])
              for (const minTier of mode ? ([undefined, 'fast', 'deep'] as (ModelTier | undefined)[]) : [undefined]) out.push({ kind, tier, effort, mode, maxEffort, minTier })
    return out
  }

  it.each([
    ['tier roles', ['tier'], false],
    ['inherit and concrete roles, parent tier known', ['inherit', 'concrete'], false],
    ['inherit and concrete roles, parent tier unknown', ['inherit', 'concrete'], true]
  ] as const)('%s: no unheld rise and idempotent, summaries included', (_label, kinds, noParent) => {
    const S = states([...kinds])
    const P = [undefined, 'fixed'] as const
    let seed = 20261110
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const problems: string[] = []
    for (let i = 0; i < 1500; i++) {
      const [wa, pa, wd, pd] = [S[rnd(S.length)], P[rnd(2)], S[rnd(S.length)], P[rnd(2)]]
      const A = docOf(wa, pa)
      const D = docOf(wd, pd)
      const g = gateTeam(A, D)
      const what = `${JSON.stringify({ ...wa, p: pa })} -> ${JSON.stringify({ ...wd, p: pd })}`
      const sa = spend(A, noParent)
      const applied = rises(sa, spend(g.effective, noParent))
      if (applied.length) problems.push(`applied rise ${applied}: ${what}`)
      const onDisk = rises(sa, spend(D, noParent))
      if (onDisk.length && !g.pending.some((c) => c.id.startsWith('role:w:') || c.id === 'settings:staffing')) problems.push(`no held row for ${onDisk}: ${what}`)
      const again = gateTeam(g.effective, D)
      if (again.applied.length || !same(again.effective, g.effective) || !same(again.pending.map((c) => [c.id, c.summary]), g.pending.map((c) => [c.id, c.summary])))
        problems.push(`not idempotent: ${what}`)
    }
    expect(problems.slice(0, 5)).toEqual([])
  })
})
