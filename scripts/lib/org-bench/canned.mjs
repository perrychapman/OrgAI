// Hand-written charts and revisions for the benchmark's own tests and self-check: a good and a bad chart per case, so the
// scorer and the real validation can be exercised without a model. Pure data builders, no I/O.
import { RETRO_SCENARIOS } from './scenarios.mjs'

const READ = ['Read', 'Glob', 'Grep']
const WRITE = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']
const MSG = ['SendMessage', 'ListAgents']

const DOC = 'Follow the architecture document in .orgai/ARCHITECTURE.md so your work matches the agreed conventions and commands. Keep your report short, lead with the outcome and list anything still open.'
const WRITER = 'Stay within the files named in your brief, run what you changed before you report back, and report every file you touched and anything you could not verify.'
const READER = 'You never edit files; report concrete problems with the file and line, and say what you could not check.'
const LEAD = 'Split the work between your reports, give each a brief that names its files, start independent pieces together and check their reports before you answer.'
const ROOT = 'Do a contained piece of work yourself; hand out work that splits into independent pieces or needs a specialist, and start independent pieces together. Give each report a brief that names its files, then check the results against the task.'

const role = (name, description, prompt, tools, model, reportsTo, spawnable = [], extra = {}) => ({
  name, description, responsibilities: extra.responsibilities ?? [`${name} work`], prompt, tools, model, canSpawn: spawnable.length > 0, spawnable, reportsTo
})

/** A small, sensible chart for the one-file script (c1): a root and one writer. */
export function goodC1() {
  return [
    role('Orchestrator', 'Plans the work and checks the result.', `You are the orchestrator for a one-file Python script. ${DOC} ${ROOT}`, READ, 'deep', null, ['Developer']),
    role('Developer', 'Writes and runs the script.', `You are the developer of the photo renaming script. Read the EXIF handling carefully, keep the script in one file and print what it would rename before it changes anything. ${DOC} ${WRITER}`, WRITE, 'everyday', 'Orchestrator')
  ]
}

/** Everything wrong at once, for c1: too many roles, deep and top everywhere, a vendor id, unknown names, every tool, messaging, no prompt. */
export function badC1() {
  const ALL = [...WRITE, 'WebSearch', 'WebFetch', 'TodoWrite', 'NotebookEdit', ...MSG]
  return [
    role('Chief Orchestrator', 'Runs everything.', 'Delegate everything to your team and never do any work yourself.', ALL, 'claude-opus-4', null, ['Ghost', 'Architect']),
    role('Architect', 'Designs.', 'Design it.', ALL, 'top', 'Chief Orchestrator', ['Frontend Lead']),
    role('Frontend Lead', 'Leads.', 'Lead it.', ALL, 'deep', 'Architect', []),
    role('Code Reviewer', 'Reviews.', 'Review it.', [...WRITE, ...MSG], 'deep', 'Chief Orchestrator', []),
    role('Researcher', 'Researches.', 'Research it.', ALL, 'deep', 'Missing Manager', []),
    role('QA Lead', 'Tests.', 'Test it.', ALL, 'deep', 'Chief Orchestrator', [])
  ]
}

/** A good chart for the multi-service platform (c4): two leads with their own reports, a read-only reviewer, a tester. */
export function goodC4() {
  const doc = DOC
  return [
    role('Orchestrator', 'Plans the release and hands out work to the leads.', `You are the orchestrator of a multi-service logistics platform. ${doc} ${ROOT}`, READ, 'deep', null, ['Product Lead', 'Platform Lead', 'Compliance Reviewer', 'QA Engineer']),
    role('Product Lead', 'Leads the customer web app and the driver mobile app.', `You are the product lead for the web and mobile clients. ${doc} ${LEAD}`, [...READ, ...MSG], 'deep', 'Orchestrator', ['Web Implementer', 'Mobile Implementer']),
    role('Web Implementer', 'Implements the React web app.', `You are the web implementer for the React customer app. ${doc} Message the services implementer when you need an endpoint changed. ${WRITER}`, [...WRITE, ...MSG], 'everyday', 'Product Lead'),
    role('Mobile Implementer', 'Implements the React Native driver app.', `You are the mobile implementer for the React Native driver app on iOS and Android. ${doc} ${WRITER}`, WRITE, 'everyday', 'Product Lead'),
    role('Platform Lead', 'Leads the services, infrastructure and data pipeline.', `You are the platform lead for the services, the infrastructure and the analytics pipeline. ${doc} ${LEAD}`, [...READ, ...MSG], 'deep', 'Orchestrator', ['Services Implementer', 'Infra Engineer', 'Data Pipeline Engineer']),
    role('Services Implementer', 'Implements the order, dispatch and billing services behind the API gateway.', `You are the services implementer for the dispatch, order and billing services. ${doc} Answer the web implementer's questions about endpoints. ${WRITER}`, [...WRITE, ...MSG], 'everyday', 'Platform Lead'),
    role('Infra Engineer', 'Maintains the Terraform and the CI pipelines.', `You are the infrastructure engineer for the Terraform and the GitHub Actions deployment. ${doc} Run terraform fmt and validate before you report. ${WRITER}`, WRITE, 'everyday', 'Platform Lead'),
    role('Data Pipeline Engineer', 'Builds the Kafka to warehouse analytics pipeline and dbt models.', `You are the data pipeline engineer for the analytics pipeline from Kafka to the warehouse. ${doc} ${WRITER}`, WRITE, 'everyday', 'Platform Lead'),
    role('Compliance Reviewer', 'Reviews changes for SOC 2 and GDPR concerns; read-only.', `You are the compliance reviewer for SOC 2 and GDPR. Check audit logging, encryption, data deletion and access controls in the changes named in your brief. ${doc} ${READER}`, READ, 'everyday', 'Orchestrator'),
    role('QA Engineer', 'Writes and runs tests across the services and clients.', `You are the QA engineer. Write and run tests for the behavior in your brief with Bash and report which tests fail and why. ${doc} ${WRITER}`, WRITE, 'everyday', 'Orchestrator')
  ]
}

const slugify = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** What the harness stores for a chart (a role view as score.mjs's roleView makes it), from drafts. Slugs from names, tiers from model. */
export function viewsFromDrafts(drafts) {
  const slugOfName = new Map(drafts.map((d) => [d.name.toLowerCase(), slugify(d.name)]))
  return drafts.map((d) => ({
    slug: slugify(d.name), name: d.name, tier: ['top', 'deep', 'everyday', 'fast'].includes(d.model) ? d.model : 'inherit', model: d.model,
    tools: [...d.tools], description: d.description, responsibilities: [...d.responsibilities], prompt: d.prompt, canSpawn: d.canSpawn,
    spawnable: d.spawnable.map((n) => slugOfName.get(n.toLowerCase()) ?? n), reportsTo: d.reportsTo ? (slugOfName.get(d.reportsTo.toLowerCase()) ?? d.reportsTo) : null
  }))
}

/** A recommend session record around a chart (what runSession leaves, scoreless). */
export function recommendSession(scenarioId, drafts, extra = {}) {
  return { family: 'recommend', scenarioId, repeat: 1, model: 'test-model', status: 'ok', chart: { title: 't', rationale: 'r', drafts, roles: viewsFromDrafts(drafts) }, reviseRounds: 0, toolErrors: 0, askUserCalls: 0, questionTurns: 1, turns: 6, durationMs: 40000, costUsd: 0.5, ...extra }
}

/** A retro session record: the scenario's chart before, `edit(views)` after (a function that returns the revised views). */
export function retroSession(scenarioId, edit, extra = {}) {
  const scenario = RETRO_SCENARIOS.find((s) => s.id === scenarioId)
  const before = viewsFromDrafts(scenario.chart)
  const after = edit ? edit(structuredClone(before)) : null
  const listed = after ? after.filter((a) => { const b = before.find((x) => x.slug === a.slug); return !b || JSON.stringify(b) !== JSON.stringify(a) }).length : 0
  return {
    family: 'retro', scenarioId, repeat: 1, model: 'test-model', status: 'ok',
    revision: after ? { ending: 'propose', args: { title: 't', rationale: 'r', roles: [], remove: [] }, listed, before, after } : { ending: 'noChange', summary: 'nothing to change', listed: 0, before, after: null },
    reviseRounds: 0, toolErrors: 0, turns: 4, durationMs: 25000, costUsd: 0.3, ...extra
  }
}

export const withTools = (views, slug, tools) => views.map((v) => (v.slug === slug ? { ...v, tools } : v))
