// Reference org charts for the self-healing bench (scripts/bench-org-heal.mjs). Pure data, no I/O.
//
// Each chart is { id, project, truth, tasks }:
//   project  a Project as the engine reads it (roles with tier, model, effort, tools, prompt, spawn edges).
//   truth    per role slug, what the work really needs. This is the simulator's hidden ground truth and is never shown
//            to the engine: needTier / needEffort (the capability the role's steps need), kind (the shape of its work),
//            tools (the tools its work reaches for), refParent (who spawns it in the reference chart), routine (a fixed
//            multi-call procedure the role repeats; the reference grants a skill that holds it).
//   tasks    the task mix: weighted templates of plan steps ({ id, role, after, paths, stream }). `stream` is the role
//            whose workstream the step belongs to (the lead that should spawn it in the reference chart).
//
// The reference chart is right-sized BY DEFINITION: every role's tier and effort equal its truth. Names are
// field-neutral (lead, builder, researcher, writer, checker, reviewer).

export const KIND_TOOLS = {
  lookup: ['Read', 'Glob', 'Grep'],
  check: ['Read', 'Bash'],
  review: ['Read', 'Grep', 'Glob'],
  analyze: ['Read', 'Grep', 'Glob'],
  write: ['Read', 'Glob', 'Grep', 'Write', 'Edit'],
  build: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']
}

/** The routine a builder repeats when no skill holds it (tool names, in order). */
export const ROUTINE = ['Glob', 'Read', 'Bash', 'Read', 'Edit', 'Bash']
export const ROUTINE_SKILL_ID = 'sk_build_routine'

const lines = (...xs) => xs.join('\n')

const PROMPTS = {
  lead: lines(
    'You lead this team and own the outcome of every request.',
    'Split each request into steps with clear owners and the files each step changes.',
    'Spawn independent steps together and wait only where a step needs another one\'s result.',
    'Send finished work to the reviewer before you call it done.',
    'Report what changed, how it was checked and what is still open.'
  ),
  'build-lead': lines(
    'You lead the build stream and spawn the builders for the steps you are given.',
    'Give each builder one area and the files it may change.',
    'Collect their results, resolve small overlaps and report back to the director.'
  ),
  'content-lead': lines(
    'You lead the content stream: research, analysis and writing.',
    'Spawn the researcher for lookups, the analyst for comparisons and the writer for documents.',
    'Report a short summary with links to what was produced.'
  ),
  'quality-lead': lines(
    'You lead the quality stream and spawn the checker and the reviewer.',
    'Run the checker first and send the reviewer only work that passes its checks.',
    'Report findings by severity.'
  ),
  builder: lines(
    'You build and change the project\'s files for the step you are given.',
    'Read the surrounding code before you change it and keep changes small.',
    'Run the relevant checks after every change and fix what they report.',
    'Never change files outside your step.',
    'Your files: src/.'
  ),
  'builder-a': lines(
    'You build and change the files of area A for the step you are given.',
    'Read the surrounding code before you change it and keep changes small.',
    'Run the relevant checks after every change and fix what they report.',
    'Never change files outside your step.',
    'Your files: src/a/.'
  ),
  'builder-b': lines(
    'You build and change the files of area B for the step you are given.',
    'Read the surrounding code before you change it and keep changes small.',
    'Run the relevant checks after every change and fix what they report.',
    'Never change files outside your step.',
    'Your files: src/b/.'
  ),
  'builder-c': lines(
    'You build and change the files of area C for the step you are given.',
    'Read the surrounding code before you change it and keep changes small.',
    'Run the relevant checks after every change and fix what they report.',
    'Never change files outside your step.',
    'Your files: src/c/.'
  ),
  researcher: lines(
    'You answer focused questions by reading the project and its documents.',
    'Quote the file and line you rely on.',
    'Keep answers short and say plainly when you could not find something.'
  ),
  analyst: lines(
    'You compare options and data the lead gives you.',
    'State the criteria first, then the comparison, then a recommendation.',
    'Mark every assumption you make.'
  ),
  writer: lines(
    'You write and update documents: guides, notes and summaries.',
    'Match the existing tone and structure of the folder you write in.',
    'Prefer short sentences and concrete examples.',
    'Your files: docs/.'
  ),
  checker: lines(
    'You run the project\'s checks for the change you are given and report the result.',
    'Report each failure with the command, the error and the file it points to.',
    'Do not change files.'
  ),
  reviewer: lines(
    'You review finished changes before they are accepted.',
    'Check correctness first, then safety, then clarity.',
    'Give each finding a severity and a concrete fix.',
    'You never change files yourself.'
  ),
  archivist: lines(
    'You keep an index of past decisions and their reasons.',
    'Update the index when a decision is made.',
    'Answer questions about why something was decided.'
  ),
  coordinator: lines(
    'You coordinate the work of your report.',
    'Pass on the brief with the context it needs and collect the result.',
    'Report back what was done.'
  )
}

let posX = 0
const role = (slug, o) => ({
  id: `r_${slug}`,
  slug,
  name: o.name ?? slug,
  description: o.description ?? `${slug} role`,
  responsibilities: [],
  prompt: PROMPTS[slug] ?? PROMPTS[o.promptOf] ?? `You are the ${slug}.`,
  tools: o.tools,
  model: o.tier,
  tier: o.tier,
  effort: o.effort,
  canSpawn: !!o.spawnable?.length,
  spawnable: (o.spawnable ?? []).map((s) => `r_${s}`),
  reportsTo: o.reportsTo === null ? null : `r_${o.reportsTo}`,
  position: { x: (posX += 220), y: o.reportsTo === null ? 0 : 160 },
  color: '#888888',
  ...(o.skills ? { skills: o.skills } : {})
})

const ROOT_TOOLS = ['Read', 'Glob', 'Grep', 'TodoWrite']
const BUILD_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']
const READ_TOOLS = ['Read', 'Glob', 'Grep']

function projectOf(id, name, roles, extra = {}) {
  return {
    id,
    name,
    path: `/bench/${id}`,
    brief: `Benchmark team ${name}.`,
    provider: { id: 'claude', auth: { kind: 'subscription' } },
    permissionMode: 'acceptEdits',
    roles,
    skills: [{ id: ROUTINE_SKILL_ID, name: 'build-routine', description: 'Use before every build step: locate, read, run, edit and re-run in one routine.', source: 'project' }],
    ...extra
  }
}

const truthOf = (needTier, needEffort, kind, refParent, extra = {}) => ({ needTier, needEffort, kind, tools: KIND_TOOLS[kind], refParent, ...extra })

function small() {
  posX = 0
  const roles = [
    role('lead', { tier: 'deep', effort: 'medium', tools: ROOT_TOOLS, reportsTo: null, spawnable: ['builder', 'researcher', 'reviewer'] }),
    role('builder', { tier: 'deep', effort: 'medium', tools: BUILD_TOOLS, reportsTo: 'lead', skills: [ROUTINE_SKILL_ID] }),
    role('researcher', { tier: 'fast', effort: 'low', tools: READ_TOOLS, reportsTo: 'lead' }),
    role('reviewer', { name: 'Reviewer', tier: 'everyday', effort: 'high', tools: READ_TOOLS, reportsTo: 'lead' })
  ]
  return {
    id: 'small',
    project: projectOf('bench-small', 'Small team', roles),
    truth: {
      lead: truthOf('deep', 'medium', 'analyze', null),
      builder: truthOf('deep', 'medium', 'build', 'lead', { routine: true }),
      researcher: truthOf('fast', 'low', 'lookup', 'lead'),
      reviewer: truthOf('everyday', 'high', 'review', 'lead')
    },
    tasks: [
      { id: 'feature', weight: 3, steps: [{ id: 'p1', role: 'researcher' }, { id: 'p2', role: 'builder', after: ['p1'], paths: ['src/a/'] }, { id: 'p3', role: 'reviewer', after: ['p2'] }] },
      { id: 'fix', weight: 2, steps: [{ id: 'p1', role: 'builder', paths: ['src/b/'] }, { id: 'p2', role: 'reviewer', after: ['p1'] }] },
      { id: 'question', weight: 2, steps: [{ id: 'p1', role: 'researcher' }, { id: 'p2', role: 'researcher' }] },
      { id: 'two-areas', weight: 2, steps: [{ id: 'p1', role: 'builder', paths: ['src/a/'] }, { id: 'p2', role: 'builder', paths: ['src/b/'] }, { id: 'p3', role: 'reviewer', after: ['p1', 'p2'] }] }
    ]
  }
}

function medium() {
  posX = 0
  const roles = [
    role('lead', { tier: 'deep', effort: 'medium', tools: ROOT_TOOLS, reportsTo: null, spawnable: ['researcher', 'builder-a', 'builder-b', 'writer', 'checker', 'reviewer'] }),
    role('researcher', { tier: 'fast', effort: 'low', tools: READ_TOOLS, reportsTo: 'lead' }),
    role('builder-a', { tier: 'deep', effort: 'medium', tools: BUILD_TOOLS, reportsTo: 'lead', skills: [ROUTINE_SKILL_ID] }),
    role('builder-b', { tier: 'deep', effort: 'medium', tools: BUILD_TOOLS, reportsTo: 'lead', skills: [ROUTINE_SKILL_ID] }),
    role('writer', { tier: 'everyday', effort: 'medium', tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'], reportsTo: 'lead' }),
    role('checker', { tier: 'everyday', effort: 'medium', tools: ['Read', 'Glob', 'Grep', 'Bash'], reportsTo: 'lead' }),
    role('reviewer', { name: 'Reviewer', tier: 'everyday', effort: 'high', tools: READ_TOOLS, reportsTo: 'lead' })
  ]
  return {
    id: 'medium',
    project: projectOf('bench-medium', 'Medium team', roles),
    truth: {
      lead: truthOf('deep', 'medium', 'analyze', null),
      researcher: truthOf('fast', 'low', 'lookup', 'lead'),
      'builder-a': truthOf('deep', 'medium', 'build', 'lead', { routine: true }),
      'builder-b': truthOf('deep', 'medium', 'build', 'lead', { routine: true }),
      writer: truthOf('everyday', 'medium', 'write', 'lead'),
      checker: truthOf('everyday', 'medium', 'check', 'lead'),
      reviewer: truthOf('everyday', 'high', 'review', 'lead')
    },
    tasks: [
      { id: 'feature', weight: 3, steps: [{ id: 'p1', role: 'researcher' }, { id: 'p2', role: 'builder-a', after: ['p1'], paths: ['src/a/'] }, { id: 'p3', role: 'builder-b', after: ['p1'], paths: ['src/b/'] }, { id: 'p4', role: 'checker', after: ['p2', 'p3'] }, { id: 'p5', role: 'reviewer', after: ['p4'] }, { id: 'p6', role: 'writer', after: ['p5'], paths: ['docs/'] }] },
      { id: 'fix', weight: 2, steps: [{ id: 'p1', role: 'builder-a', paths: ['src/a/'] }, { id: 'p2', role: 'checker', after: ['p1'] }, { id: 'p3', role: 'reviewer', after: ['p2'] }] },
      { id: 'docs', weight: 2, steps: [{ id: 'p1', role: 'researcher' }, { id: 'p2', role: 'writer', after: ['p1'], paths: ['docs/'] }, { id: 'p3', role: 'reviewer', after: ['p2'] }] },
      { id: 'wide', weight: 2, steps: [{ id: 'p1', role: 'researcher' }, { id: 'p2', role: 'researcher' }, { id: 'p3', role: 'researcher' }, { id: 'p4', role: 'builder-a', after: ['p1', 'p2', 'p3'], paths: ['src/a/'] }, { id: 'p5', role: 'builder-b', after: ['p1', 'p2', 'p3'], paths: ['src/b/'] }, { id: 'p6', role: 'checker', after: ['p4', 'p5'] }] }
    ]
  }
}

function large() {
  posX = 0
  const roles = [
    role('director', { promptOf: 'lead', tier: 'deep', effort: 'medium', tools: ROOT_TOOLS, reportsTo: null, spawnable: ['build-lead', 'content-lead', 'quality-lead'] }),
    role('build-lead', { tier: 'everyday', effort: 'medium', tools: READ_TOOLS, reportsTo: 'director', spawnable: ['builder-a', 'builder-b', 'builder-c'] }),
    role('content-lead', { tier: 'everyday', effort: 'medium', tools: READ_TOOLS, reportsTo: 'director', spawnable: ['researcher', 'analyst', 'writer'] }),
    role('quality-lead', { tier: 'everyday', effort: 'medium', tools: READ_TOOLS, reportsTo: 'director', spawnable: ['checker', 'reviewer'] }),
    role('builder-a', { tier: 'deep', effort: 'medium', tools: BUILD_TOOLS, reportsTo: 'build-lead', skills: [ROUTINE_SKILL_ID] }),
    role('builder-b', { tier: 'deep', effort: 'medium', tools: BUILD_TOOLS, reportsTo: 'build-lead', skills: [ROUTINE_SKILL_ID] }),
    role('builder-c', { tier: 'deep', effort: 'medium', tools: BUILD_TOOLS, reportsTo: 'build-lead', skills: [ROUTINE_SKILL_ID] }),
    role('researcher', { tier: 'fast', effort: 'low', tools: READ_TOOLS, reportsTo: 'content-lead' }),
    role('analyst', { tier: 'everyday', effort: 'medium', tools: READ_TOOLS, reportsTo: 'content-lead' }),
    role('writer', { tier: 'everyday', effort: 'medium', tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'], reportsTo: 'content-lead' }),
    role('checker', { tier: 'everyday', effort: 'medium', tools: ['Read', 'Glob', 'Grep', 'Bash'], reportsTo: 'quality-lead' }),
    role('reviewer', { name: 'Reviewer', tier: 'everyday', effort: 'high', tools: READ_TOOLS, reportsTo: 'quality-lead' })
  ]
  return {
    id: 'large',
    project: projectOf('bench-large', 'Large team', roles),
    truth: {
      director: truthOf('deep', 'medium', 'analyze', null),
      'build-lead': truthOf('everyday', 'medium', 'analyze', 'director'),
      'content-lead': truthOf('everyday', 'medium', 'analyze', 'director'),
      'quality-lead': truthOf('everyday', 'medium', 'analyze', 'director'),
      'builder-a': truthOf('deep', 'medium', 'build', 'build-lead', { routine: true }),
      'builder-b': truthOf('deep', 'medium', 'build', 'build-lead', { routine: true }),
      'builder-c': truthOf('deep', 'medium', 'build', 'build-lead', { routine: true }),
      researcher: truthOf('fast', 'low', 'lookup', 'content-lead'),
      analyst: truthOf('everyday', 'medium', 'analyze', 'content-lead'),
      writer: truthOf('everyday', 'medium', 'write', 'content-lead'),
      checker: truthOf('everyday', 'medium', 'check', 'quality-lead'),
      reviewer: truthOf('everyday', 'high', 'review', 'quality-lead')
    },
    tasks: [
      { id: 'feature', weight: 3, steps: [{ id: 'p1', role: 'researcher' }, { id: 'p2', role: 'builder-a', after: ['p1'], paths: ['src/a/'] }, { id: 'p3', role: 'builder-b', after: ['p1'], paths: ['src/b/'] }, { id: 'p4', role: 'builder-c', after: ['p1'], paths: ['src/c/'] }, { id: 'p5', role: 'checker', after: ['p2', 'p3', 'p4'] }, { id: 'p6', role: 'reviewer', after: ['p5'] }, { id: 'p7', role: 'writer', after: ['p6'], paths: ['docs/'] }] },
      { id: 'analysis', weight: 2, steps: [{ id: 'p1', role: 'researcher' }, { id: 'p2', role: 'researcher' }, { id: 'p3', role: 'analyst', after: ['p1', 'p2'] }, { id: 'p4', role: 'writer', after: ['p3'], paths: ['docs/'] }, { id: 'p5', role: 'reviewer', after: ['p4'] }] },
      { id: 'fix', weight: 2, steps: [{ id: 'p1', role: 'builder-b', paths: ['src/b/'] }, { id: 'p2', role: 'checker', after: ['p1'] }, { id: 'p3', role: 'reviewer', after: ['p2'] }] },
      { id: 'wide', weight: 2, steps: [{ id: 'p1', role: 'builder-a', paths: ['src/a/'] }, { id: 'p2', role: 'builder-b', paths: ['src/b/'] }, { id: 'p3', role: 'builder-c', paths: ['src/c/'] }, { id: 'p4', role: 'analyst' }, { id: 'p5', role: 'checker', after: ['p1', 'p2', 'p3'] }] }
    ]
  }
}

/** Fresh copies of the three reference charts (callers may mutate them). */
export function referenceCharts() {
  return { small: small(), medium: medium(), large: large() }
}

export const COMPLEXITIES = ['small', 'medium', 'large']
