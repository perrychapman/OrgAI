// Scenarios of the org chart benchmark (docs/design/org-chart-benchmark.md). Plain data: no I/O. Expectations use RegExp,
// so they live here (not in results.json); a saved results file is re-scored against the scenarios in this file by id.
//
// Family "recommend": the Architect's first org chart (c1-c4 new code projects, c5-c6 existing repositories, e1-e3 engagements).
// Family "retro": the Architect revises a chart that is already set up, given a condensed run record with one planted
// defect (r1-r6). `chart` is written as propose_org_chart drafts, so the runner builds real Role objects with the real
// toRoles; `run` is a compact run record the runner expands into a RunRecord for the real SetupService.retroContext.

const GO = 'Go ahead and propose; use your judgment for anything else.'

// ---------------------------------------------------------------- recommend: new code projects

const c1 = {
  id: 'c1', family: 'recommend', kind: 'code', setupKind: 'new', complexity: 1,
  title: 'One-file script',
  brief: 'A single Python script that renames the photos in a folder by the date in their EXIF data.',
  answers: `One file, Python 3, standard library only (Pillow is fine if it is really needed). It takes a folder path on the command line, prints what it would rename, and only renames when I pass --apply. No tests needed, no CI, no packaging: I will run it on my laptop. ${GO}`,
  expect: {
    roles: { min: 1, max: 3 }, maxDepth: 1, allowTop: false, maxDeepShare: 0.67, wantsReviewer: false, wantsMessaging: 'none',
    cover: [{ name: 'implementation', patterns: [/implement|develop|engineer|script|programmer|coder|\bcode\b/i] }]
  }
}

const c2 = {
  id: 'c2', family: 'recommend', kind: 'code', setupKind: 'new', complexity: 2,
  title: 'Small CLI and library with tests',
  brief: 'A small TypeScript library and command-line tool that converts Markdown tables to CSV and back.',
  answers: `Published to npm as one package with a bin entry, about 500 lines in total. Strict TypeScript, ESM only, vitest for unit tests, a README with examples. No server, no database, no UI. Tests are required and should cover malformed tables. ${GO}`,
  expect: {
    roles: { min: 2, max: 5 }, maxDepth: 1, allowTop: false, maxDeepShare: 0.5, wantsReviewer: false, wantsMessaging: 'none',
    cover: [
      { name: 'implementation', patterns: [/implement|develop|engineer|\bcode\b|library/i] },
      { name: 'testing', patterns: [/\btest|\bqa\b|quality|verif/i] }
    ]
  }
}

const c3 = {
  id: 'c3', family: 'recommend', kind: 'code', setupKind: 'new', complexity: 3,
  title: 'Full-stack web app',
  brief: 'A team task tracker: web UI, REST API, a database and email/password login with admin and member roles.',
  answers: `TypeScript everywhere: React with Vite for the UI, Node with Fastify for the API, PostgreSQL with Prisma. Sessions with short-lived JWTs and refresh tokens; roles are admin and member. Docker Compose for local development, Vitest for unit tests and Playwright for a few end-to-end flows. No cloud deployment yet, no mobile app. ${GO}`,
  expect: {
    roles: { min: 4, max: 8 }, maxDepth: 2, allowTop: false, maxDeepShare: 0.4, wantsReviewer: true, wantsMessaging: 'some',
    cover: [
      { name: 'frontend', patterns: [/front-?end|\bui\b|react|client/i] },
      { name: 'backend', patterns: [/back-?end|\bapi\b|server|fastify/i] },
      { name: 'database', patterns: [/database|schema|postgres|\bsql\b|prisma|migration|data model/i] },
      { name: 'auth', patterns: [/auth|login|session|\bjwt\b|security|permission/i] },
      { name: 'testing', patterns: [/\btest|\bqa\b|quality|verif/i] }
    ]
  }
}

const c4 = {
  id: 'c4', family: 'recommend', kind: 'code', setupKind: 'new', complexity: 4,
  title: 'Multi-service platform with compliance',
  brief: 'A logistics platform: customer web app, driver mobile app, order, dispatch and billing services, infrastructure as code, and an analytics data pipeline. It must meet SOC 2 and GDPR.',
  answers: `Web: React and TypeScript. Mobile: React Native for iOS and Android. Services: Go for dispatch, Node for orders and billing, all behind one API gateway, PostgreSQL per service, Kafka between them. Infrastructure: Terraform on AWS with GitHub Actions. Data pipeline: Kafka to S3 to a warehouse with dbt models and a dashboard. Compliance: audit logging, encryption at rest, data-subject deletion and access reviews must be designed in, and evidence for SOC 2 collected from the pipeline. Large team in the real world; here the agents build the first release. ${GO}`,
  expect: {
    roles: { min: 8, max: 16 }, maxDepth: 3, middleLayer: true, allowTop: true, maxDeepShare: 0.4, wantsReviewer: true, wantsMessaging: 'some',
    cover: [
      { name: 'web', patterns: [/\bweb\b|front-?end|react/i] },
      { name: 'mobile', patterns: [/mobile|\bios\b|android|react native/i] },
      { name: 'services', patterns: [/service|back-?end|dispatch|billing|\bapi\b/i] },
      { name: 'infrastructure', patterns: [/infra|terraform|devops|cloud|deploy|\biac\b|ci\/cd|platform engineer/i] },
      { name: 'data-pipeline', patterns: [/pipeline|\betl\b|analytics|warehouse|\bdbt\b|data engineer/i] },
      { name: 'compliance', patterns: [/complian|security|gdpr|soc ?2|privacy|audit/i] },
      { name: 'testing', patterns: [/\btest|\bqa\b|quality|verif/i] }
    ]
  }
}

// ---------------------------------------------------------------- recommend: existing repositories

const c5 = {
  id: 'c5', family: 'recommend', kind: 'code', setupKind: 'existing', complexity: 2,
  title: 'Small single-purpose service (existing)',
  brief: 'Keep this URL shortener maintainable. Next I want rate limiting and a metrics endpoint.',
  answers: `It runs in production at small scale: one instance, a SQLite file. Priorities in order: add rate limiting, add /metrics, raise test coverage. Do not re-platform anything and keep the dependencies as they are. One developer (me) reviews every change. ${GO}`,
  files: {
    'package.json': '{\n  "name": "shorty",\n  "version": "1.4.0",\n  "type": "module",\n  "scripts": { "start": "node src/index.js", "test": "node --test test/" },\n  "dependencies": { "express": "4.21.0", "better-sqlite3": "11.3.0" }\n}\n',
    'README.md': '# shorty\n\nA tiny URL shortener. POST /shorten {url} returns {code}; GET /:code redirects.\n\nRun: npm start (PORT, DB_FILE env). Tests: npm test.\n',
    'src/index.js': "import express from 'express'\nimport { openStore } from './store.js'\nimport { validUrl } from './validate.js'\n\nconst app = express()\nconst store = openStore(process.env.DB_FILE ?? 'shorty.db')\napp.use(express.json())\napp.post('/shorten', (req, res) => {\n  if (!validUrl(req.body?.url)) return res.status(400).json({ error: 'invalid url' })\n  res.json({ code: store.add(req.body.url) })\n})\napp.get('/:code', (req, res) => {\n  const url = store.get(req.params.code)\n  return url ? res.redirect(url) : res.status(404).end()\n})\napp.listen(process.env.PORT ?? 3000)\n",
    'src/store.js': "import Database from 'better-sqlite3'\nimport { randomBytes } from 'node:crypto'\n\nexport function openStore(file) {\n  const db = new Database(file)\n  db.exec('create table if not exists links (code text primary key, url text not null)')\n  return {\n    add(url) {\n      const code = randomBytes(4).toString('hex')\n      db.prepare('insert into links (code, url) values (?, ?)').run(code, url)\n      return code\n    },\n    get: (code) => db.prepare('select url from links where code = ?').get(code)?.url\n  }\n}\n",
    'src/validate.js': "export function validUrl(u) {\n  try {\n    const p = new URL(u)\n    return p.protocol === 'http:' || p.protocol === 'https:'\n  } catch {\n    return false\n  }\n}\n",
    'test/validate.test.js': "import test from 'node:test'\nimport assert from 'node:assert'\nimport { validUrl } from '../src/validate.js'\n\ntest('accepts https', () => assert.ok(validUrl('https://example.com')))\ntest('rejects junk', () => assert.ok(!validUrl('nope')))\n",
    'Dockerfile': 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci --omit=dev\nCMD ["node", "src/index.js"]\n',
    '.github/workflows/ci.yml': 'name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with: { node-version: 22 }\n      - run: npm ci\n      - run: npm test\n'
  },
  expect: {
    roles: { min: 2, max: 5 }, maxDepth: 1, allowTop: false, maxDeepShare: 0.5, wantsReviewer: true, wantsMessaging: 'none',
    cover: [
      { name: 'implementation', patterns: [/implement|develop|engineer|\bcode\b|service/i] },
      { name: 'testing', patterns: [/\btest|\bqa\b|quality|verif/i] }
    ]
  }
}

const c6 = {
  id: 'c6', family: 'recommend', kind: 'code', setupKind: 'existing', complexity: 3,
  title: 'Monorepo with frontend, backend, infra and docs packages (existing)',
  brief: 'Our order management monorepo. We want agents to take feature work across the web app and the API, keep the Terraform sane, and keep the runbooks current.',
  answers: `Yes, all four areas matter: packages/web (React), packages/api (Node, Postgres), infra (Terraform on AWS) and docs (runbooks and architecture notes). Features usually touch web and api together; infra changes are rare but risky and need a careful reviewer; docs must be updated with every change that affects operations. CI is GitHub Actions. ${GO}`,
  files: {
    'package.json': '{\n  "name": "orders-monorepo",\n  "private": true,\n  "workspaces": ["packages/*"],\n  "scripts": { "test": "npm test --workspaces", "lint": "eslint ." }\n}\n',
    'README.md': '# Orders monorepo\n\n- packages/web: React storefront admin\n- packages/api: REST API (Node, Postgres)\n- infra: Terraform (AWS: ECS, RDS)\n- docs: runbooks and architecture\n',
    'packages/web/package.json': '{\n  "name": "@orders/web",\n  "scripts": { "dev": "vite", "test": "vitest run" },\n  "dependencies": { "react": "19.0.0", "react-dom": "19.0.0" }\n}\n',
    'packages/web/src/App.tsx': "import { useEffect, useState } from 'react'\n\nexport function App() {\n  const [orders, setOrders] = useState<{ id: string; total: number }[]>([])\n  useEffect(() => { fetch('/api/orders').then((r) => r.json()).then(setOrders) }, [])\n  return <ul>{orders.map((o) => <li key={o.id}>{o.id}: {o.total}</li>)}</ul>\n}\n",
    'packages/api/package.json': '{\n  "name": "@orders/api",\n  "scripts": { "start": "node dist/server.js", "test": "vitest run" },\n  "dependencies": { "fastify": "5.0.0", "pg": "8.13.0" }\n}\n',
    'packages/api/src/server.ts': "import Fastify from 'fastify'\nimport { listOrders } from './db'\n\nconst app = Fastify()\napp.get('/api/orders', async () => listOrders())\napp.listen({ port: 3000 })\n",
    'packages/api/src/db.ts': "import pg from 'pg'\n\nconst pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })\n\nexport async function listOrders() {\n  const { rows } = await pool.query('select id, total from orders order by created_at desc limit 100')\n  return rows\n}\n",
    'infra/main.tf': 'terraform {\n  required_version = ">= 1.8"\n}\n\nresource "aws_db_instance" "orders" {\n  engine         = "postgres"\n  instance_class = var.db_class\n  allocated_storage = 50\n}\n',
    'infra/variables.tf': 'variable "db_class" {\n  type    = string\n  default = "db.t4g.medium"\n}\n',
    'docs/runbook.md': '# Runbook\n\n## Database failover\n1. Check RDS events.\n2. Promote the replica.\n3. Update DATABASE_URL in the ECS task definition.\n',
    '.github/workflows/ci.yml': 'name: ci\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test\n  terraform:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: terraform -chdir=infra fmt -check\n'
  },
  expect: {
    roles: { min: 5, max: 10 }, maxDepth: 2, allowTop: false, maxDeepShare: 0.4, wantsReviewer: true, wantsMessaging: 'some',
    cover: [
      { name: 'frontend', patterns: [/front-?end|\bweb\b|react|\bui\b/i] },
      { name: 'backend', patterns: [/back-?end|\bapi\b|server|postgres/i] },
      { name: 'infrastructure', patterns: [/infra|terraform|devops|cloud|\baws\b/i] },
      { name: 'docs', patterns: [/\bdocs?\b|documentation|runbook|technical writ/i] },
      { name: 'testing', patterns: [/\btest|\bqa\b|quality|verif/i] }
    ]
  }
}

// ---------------------------------------------------------------- recommend: engagements

const e1 = {
  id: 'e1', family: 'recommend', kind: 'engagement', setupKind: 'new', complexity: 1,
  title: 'One short deliverable',
  brief: 'A two-page briefing memo for a regional food bank on whether to move from paper intake forms to a tablet-based system.',
  answers: `Client: Riverside Regional Food Bank, a nonprofit. Field: nonprofit operations. Phase: assessment. One deliverable: a two-page memo in Word format with a clear recommendation and the main risks. No coding, no data analysis beyond what I paste in. The platforms involved are only Word and email. ${GO}`,
  expect: {
    roles: { min: 1, max: 3 }, maxDepth: 1, allowTop: false, maxDeepShare: 0.67, wantsReviewer: false, wantsMessaging: 'none',
    cover: [{ name: 'writing', patterns: [/writ|draft|author|memo|brief/i] }],
    forbid: [{ name: 'developer', patterns: [/developer|programmer|software engineer|coder/i] }]
  }
}

const e2 = {
  id: 'e2', family: 'recommend', kind: 'engagement', setupKind: 'new', complexity: 3,
  title: 'Multi-workstream assessment, no coding',
  brief: 'Assess outpatient scheduling at a mid-size hospital: workflow, no-show rates, staffing, patient experience and regulatory compliance. Deliver an assessment report and an executive deck.',
  answers: `Client: Lakeshore Health System. Field: healthcare operations. Phase: assessment. Platforms: their scheduling system (Epic Cadence exports as CSV), a patient survey tool (CSV exports) and staffing spreadsheets. Deliverables: a 30-page assessment report in Word and a 12-slide executive deck. Coding is out of scope; spreadsheet analysis is in scope. Findings must be checked against HIPAA privacy rules before anything is shared. ${GO}`,
  expect: {
    roles: { min: 4, max: 8 }, maxDepth: 2, allowTop: false, maxDeepShare: 0.4, wantsReviewer: true, wantsMessaging: 'any',
    cover: [
      { name: 'workflow-expertise', patterns: [/workflow|operations|process|clinical|healthcare|domain|specialist/i] },
      { name: 'data-analysis', patterns: [/analy|data|statist|spreadsheet/i] },
      { name: 'compliance', patterns: [/complian|regulat|hipaa|privacy|legal/i] },
      { name: 'writing', patterns: [/writ|report|draft|deck|slides|presentation/i] }
    ],
    forbid: [{ name: 'developer', patterns: [/developer|programmer|software engineer|coder/i] }]
  }
}

const e3 = {
  id: 'e3', family: 'recommend', kind: 'engagement', setupKind: 'new', complexity: 4,
  title: 'Several platforms with coding in scope',
  brief: 'Migrate a retailer\'s order history across its Shopify storefront, NetSuite ERP and Salesforce CRM, with integration scripts and reconciliation reports.',
  answers: `Client: Northwind Outfitters. Field: retail systems integration. Phase: build then run. Platforms: Shopify (orders, customers), NetSuite (sales orders, invoices), Salesforce (accounts, opportunities). Deliverables: working integration scripts in Python, a field mapping document, reconciliation reports that show every mismatched record, and a cutover runbook. Coding is in scope. Read-only exports of each system are in the reference folder. ${GO}`,
  expect: {
    roles: { min: 6, max: 12 }, maxDepth: 2, allowTop: false, maxDeepShare: 0.4, wantsReviewer: true, wantsMessaging: 'some',
    cover: [
      { name: 'storefront', patterns: [/shopify|storefront|e-?commerce/i] },
      { name: 'erp', patterns: [/netsuite|\berp\b/i] },
      { name: 'crm', patterns: [/salesforce|\bcrm\b/i] },
      { name: 'integration-code', patterns: [/develop|engineer|script|integration|\bcode\b/i] },
      { name: 'reconciliation', patterns: [/reconcil|validation|data quality|\bdata\b/i] },
      { name: 'documentation', patterns: [/document|runbook|writ|report/i] }
    ]
  }
}

export const RECOMMEND_SCENARIOS = [c1, c2, c3, c4, c5, c6, e1, e2, e3]

// ---------------------------------------------------------------- retro: charts

const READ = ['Read', 'Glob', 'Grep']
const WRITE = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']

const draft = (name, description, prompt, tools, model, reportsTo, spawnable = [], extra = {}) => ({
  name, description, responsibilities: extra.responsibilities ?? [], prompt, tools, model,
  canSpawn: spawnable.length > 0, spawnable, reportsTo
})

/** 3 roles: a small Python CLI. */
function chart3() {
  return [
    draft('Orchestrator', 'Plans the work and hands it out.',
      'You are the orchestrator. Read the architecture document first. Do a contained piece of work yourself; hand out work that splits into independent pieces or needs a specialist, and start independent pieces together. Give each report a brief that names its files. Check the result against the task before you report.',
      ['Read', 'Glob', 'Grep', 'TodoWrite'], 'deep', null, ['Implementer', 'Tester'], { responsibilities: ['Plan and sequence work', 'Check results against the task'] }),
    draft('Implementer', 'Writes and changes the CLI code.',
      'You are the implementer. Follow the architecture document. Stay within the files named in your brief and report every file you touched. Run the code you changed with Bash before you report back, and keep functions small and covered by the tester\'s cases.',
      WRITE, 'everyday', 'Orchestrator', [], { responsibilities: ['Implement features in csvkit/', 'Fix defects'] }),
    draft('Tester', 'Writes and runs tests for the CLI.',
      'You are the tester. Follow the architecture document. Write unittest tests under tests/ for the behavior in your brief, run the suite and report which tests fail and why. Stay within the files named in your brief and report every file you touched.',
      ['Read', 'Glob', 'Grep', 'Edit', 'Write'], 'everyday', 'Orchestrator', [], { responsibilities: ['Write unit tests', 'Run the suite and report failures'] })
  ]
}

/** 6 roles: a TypeScript service plus a small web client. `researcherTier` plants the over-provisioning defect of r4. */
function chart6({ researcherTier = 'fast' } = {}) {
  return [
    draft('Orchestrator', 'Plans the work and hands it out.',
      'You are the orchestrator. Read the architecture document first. Do a contained piece of work yourself; hand out work that splits into independent pieces or needs a specialist, and start independent pieces together. Give each report a brief that names its files, and have the reviewer look at anything that changes behavior.',
      ['Read', 'Glob', 'Grep', 'TodoWrite'], 'deep', null, ['Backend Implementer', 'Frontend Implementer', 'Tester', 'Reviewer', 'Researcher'], { responsibilities: ['Plan and sequence work', 'Check results against the task'] }),
    draft('Backend Implementer', 'Implements API handlers and server code under src/.',
      'You are the backend implementer. Follow the architecture document. Work on API handlers under src/ as your brief says, stay within the files named in your brief and report every file you touched. Run the tests you affect before you report back.',
      WRITE, 'everyday', 'Orchestrator', [], { responsibilities: ['Implement and change API handlers', 'Keep the server code consistent'] }),
    draft('Frontend Implementer', 'Implements the web client under web/.',
      'You are the frontend implementer. Follow the architecture document. Work on the web client under web/ as your brief says, stay within the files named in your brief and report every file you touched.',
      WRITE, 'everyday', 'Orchestrator', [], { responsibilities: ['Implement and change UI components'] }),
    draft('Tester', 'Writes and runs tests.',
      'You are the tester. Follow the architecture document. Write and run tests for the behavior in your brief with Bash, stay within the files named in your brief and report which tests fail and why.',
      WRITE, 'everyday', 'Orchestrator', [], { responsibilities: ['Write tests', 'Run the suite and report failures'] }),
    draft('Reviewer', 'Reviews changes for correctness and conventions; read-only.',
      'You are the reviewer. Follow the architecture document. Read the changes named in your brief, check them against the conventions and the task, and report concrete problems with file and line. You never edit files.',
      READ, 'everyday', 'Orchestrator', [], { responsibilities: ['Review diffs', 'Report concrete problems'] }),
    draft('Researcher', 'Looks things up: usages, versions, documentation; read-only.',
      'You are the researcher. Answer the question in your brief from the code and from documentation, quote the file or page you used and keep the answer short. You never edit files.',
      ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'], researcherTier, 'Orchestrator', [], { responsibilities: ['Find usages and versions', 'Summarize documentation'] })
  ]
}

/** 11 roles with two leads: client work (web, mobile, UI tests) and platform work (API, pipeline, infra). `webPrompt` plants r3's defect. */
function chart11({ webPrompt } = {}) {
  const msg = ['SendMessage', 'ListAgents']
  return [
    draft('Orchestrator', 'Plans the work and hands it out to the two leads.',
      'You are the orchestrator. Read the architecture document first. Do a contained piece of work yourself; hand out work that splits into independent pieces to the Client Lead and the Platform Lead, and start independent pieces together. Ask the reviewer to look at anything that changes behavior.',
      ['Read', 'Glob', 'Grep', 'TodoWrite'], 'deep', null, ['Client Lead', 'Platform Lead', 'Reviewer', 'Researcher'], { responsibilities: ['Plan and sequence work', 'Check results against the task'] }),
    draft('Client Lead', 'Leads web, mobile and UI test work.',
      'You are the client lead. Follow the architecture document. Split client work between the web implementer, the mobile implementer and the UI tester, give each a brief that names its files, and check their reports before you answer the orchestrator.',
      ['Read', 'Glob', 'Grep', ...msg], 'deep', 'Orchestrator', ['Web Implementer', 'Mobile Implementer', 'UI Tester'], { responsibilities: ['Split client work', 'Check client reports'] }),
    draft('Web Implementer', 'Implements the React web app under apps/web/.',
      webPrompt ?? 'You are the web implementer. Follow the architecture document. Work on the React app under apps/web/ as your brief says, stay within the files named in your brief and report every file you touched. Message the API implementer when you need an endpoint changed.',
      [...WRITE, ...msg], 'everyday', 'Client Lead', [], { responsibilities: ['Implement web UI'] }),
    draft('Mobile Implementer', 'Implements the React Native app under apps/mobile/.',
      'You are the mobile implementer. Follow the architecture document. Work on the app under apps/mobile/ as your brief says, stay within the files named in your brief and report every file you touched.',
      WRITE, 'everyday', 'Client Lead', [], { responsibilities: ['Implement mobile UI'] }),
    draft('UI Tester', 'Writes and runs end-to-end UI tests.',
      'You are the UI tester. Follow the architecture document. Write and run Playwright tests under tests/e2e/ for the flows in your brief, stay within the files named in your brief and report which tests fail and why.',
      WRITE, 'everyday', 'Client Lead', [], { responsibilities: ['Write e2e tests', 'Report failures'] }),
    draft('Platform Lead', 'Leads API, data pipeline and infrastructure work.',
      'You are the platform lead. Follow the architecture document. Split platform work between the API implementer, the data pipeline implementer and the infrastructure engineer, give each a brief that names its files, and check their reports before you answer the orchestrator.',
      ['Read', 'Glob', 'Grep', ...msg], 'deep', 'Orchestrator', ['API Implementer', 'Data Pipeline Implementer', 'Infra Engineer'], { responsibilities: ['Split platform work', 'Check platform reports'] }),
    draft('API Implementer', 'Implements the REST API under services/api/.',
      'You are the API implementer. Follow the architecture document. Work on the API under services/api/ as your brief says, stay within the files named in your brief and report every file you touched. Answer the web implementer\'s questions about endpoints.',
      [...WRITE, ...msg], 'everyday', 'Platform Lead', [], { responsibilities: ['Implement API endpoints'] }),
    draft('Data Pipeline Implementer', 'Implements the ETL jobs under services/pipeline/.',
      'You are the data pipeline implementer. Follow the architecture document. Work on the jobs under services/pipeline/ as your brief says, stay within the files named in your brief and report every file you touched.',
      WRITE, 'everyday', 'Platform Lead', [], { responsibilities: ['Implement ETL jobs'] }),
    draft('Infra Engineer', 'Maintains the Terraform under infra/.',
      'You are the infrastructure engineer. Follow the architecture document. Work on the Terraform under infra/ as your brief says, run terraform fmt and validate before you report, stay within the files named in your brief and report every file you touched.',
      WRITE, 'everyday', 'Platform Lead', [], { responsibilities: ['Maintain Terraform'] }),
    draft('Reviewer', 'Reviews changes for correctness and conventions; read-only.',
      'You are the reviewer. Follow the architecture document. Read the changes named in your brief, check them against the conventions and the task, and report concrete problems with file and line. You never edit files.',
      READ, 'everyday', 'Orchestrator', [], { responsibilities: ['Review diffs'] }),
    draft('Researcher', 'Looks things up; read-only.',
      'You are the researcher. Answer the question in your brief from the code and from documentation, quote the file or page you used and keep the answer short. You never edit files.',
      ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'], 'fast', 'Orchestrator', [], { responsibilities: ['Find usages and versions'] })
  ]
}


const FILES11 = {
  'package.json': '{\n  "name": "fleet",\n  "private": true,\n  "workspaces": ["apps/*", "services/*"]\n}\n',
  'README.md': '# fleet\n\nWeb and mobile apps, an API, an ETL pipeline and the Terraform that runs them.\n',
  'apps/web/src/App.tsx': "export function App() {\n  return <h1>Fleet</h1>\n}\n",
  'apps/mobile/App.tsx': "export default function App() {\n  return null\n}\n",
  'services/api/src/server.ts': "import Fastify from 'fastify'\n\nconst app = Fastify()\napp.get('/vehicles', async () => [])\napp.listen({ port: 3000 })\n",
  'services/pipeline/etl.py': "def run():\n    print('extract, transform, load')\n\n\nif __name__ == '__main__':\n    run()\n",
  'infra/main.tf': 'terraform {\n  required_version = ">= 1.8"\n}\n',
  'tests/e2e/smoke.spec.ts': "import { test, expect } from '@playwright/test'\n\ntest('loads', async ({ page }) => {\n  await page.goto('/')\n  await expect(page.locator('h1')).toHaveText('Fleet')\n})\n"
}

// Retro fixtures: the folder shows the state AFTER the run, so it agrees with the run record (the Architect has Read, Glob
// and Grep and checks). `git: true` on a scenario makes the prepared folder a git repository with one commit (load.mjs).

const archDoc = (title, summary, modules) =>
  `# ${title}\n\n${summary}\n\n## Modules\n\n${modules.map(([p, d]) => `- ${p}: ${d}`).join('\n')}\n\n## Conventions\n\n- Keep functions small; add a test for every behavior change.\n`

const ARCH6 = archDoc('Inventory architecture', 'A Fastify API over a SQLite file with a small React admin client; tests run with vitest.',
  [['src/server.ts', 'Fastify routes'], ['src/db.ts', 'SQLite queries'], ['web/App.tsx', 'React admin client'], ['tests/', 'vitest tests']])
const ARCH3 = archDoc('csvkit architecture', 'A pure-Python CLI (argparse) with the logic in csvkit/ops.py and unittest tests under tests/.',
  [['csvkit/cli.py', 'argparse entry point'], ['csvkit/ops.py', 'CSV operations'], ['tests/', 'unittest tests (python -m unittest discover -s tests)']])
const ARCH11 = archDoc('Fleet architecture', 'A monorepo: React web app and React Native app, a Fastify API, a Python ETL pipeline and Terraform; Playwright e2e tests.',
  [['apps/web', 'React web app'], ['apps/mobile', 'React Native app'], ['services/api', 'Fastify API'], ['services/pipeline', 'Python ETL'], ['infra', 'Terraform'], ['tests/e2e', 'Playwright tests']])


const MIGRATION_INIT = 'create table stock (\n  sku text primary key,\n  qty integer not null default 0\n);\n'

// Fixture files are written with String.raw so the code in them needs no escaping (no backticks or dollar-brace inside).
const raw = (strings) => strings.raw[0].replace(/^\n/, '')

// ---- csvkit (r2): a pure-Python CLI with unittest tests; node is not needed, python 3 is.
const R2_FILES = {
  'README.md': raw`
# csvkit

A small command-line tool for sorting, filtering and joining CSV files.

Usage:

    python -m csvkit sort FILE --by COLUMN
    python -m csvkit filter FILE --where COLUMN=VALUE

Tests: python -m unittest discover -s tests
`,
  '.orgai/ARCHITECTURE.md': ARCH3,
  'pyproject.toml': raw`
[project]
name = "csvkit"
version = "0.1.0"
`,
  'csvkit/__main__.py': raw`
from csvkit.cli import main

main()
`,
  'csvkit/cli.py': raw`
import argparse
from csvkit import ops


def main():
    p = argparse.ArgumentParser(prog='csvkit')
    sub = p.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('sort')
    s.add_argument('file')
    s.add_argument('--by', required=True)
    f = sub.add_parser('filter')
    f.add_argument('file')
    f.add_argument('--where', required=True, help='COLUMN=VALUE')
    args = p.parse_args()
    if args.cmd == 'sort':
        ops.sort_file(args.file, args.by)
    elif args.cmd == 'filter':
        column, _, value = args.where.partition('=')
        ops.filter_file(args.file, column, value)
`,
  'csvkit/ops.py': raw`
import csv
import sys


def sort_file(path, column):
    with open(path, newline='') as f:
        rows = list(csv.DictReader(f))
    rows.sort(key=lambda r: r[column])
    w = csv.DictWriter(sys.stdout, fieldnames=rows[0].keys())
    w.writeheader()
    w.writerows(rows)


def filter_file(path, column, value):
    with open(path, newline='') as f:
        reader = csv.DictReader(f)
        rows = [r for r in reader if r[column] == value]
        fieldnames = reader.fieldnames
    w = csv.DictWriter(sys.stdout, fieldnames=fieldnames)
    w.writeheader()
    w.writerows(rows)
`,
  'tests/test_ops.py': raw`
import contextlib
import csv
import io
import os
import tempfile
import unittest

from csvkit import ops


def run_sort(text, column):
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, 'in.csv')
        with open(path, 'w', newline='') as f:
            f.write(text)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            ops.sort_file(path, column)
    return list(csv.DictReader(io.StringIO(out.getvalue())))


class SortTests(unittest.TestCase):
    def test_sorts_rows_by_the_column(self):
        rows = run_sort('name,city\nbob,rome\nann,oslo\n', 'name')
        self.assertEqual([r['name'] for r in rows], ['ann', 'bob'])

    def test_keeps_every_column(self):
        rows = run_sort('name,city\nbob,rome\nann,oslo\n', 'city')
        self.assertEqual(rows[0], {'name': 'ann', 'city': 'oslo'})


if __name__ == '__main__':
    unittest.main()
`,
  'tests/test_filter.py': raw`
import contextlib
import csv
import io
import os
import subprocess
import sys
import tempfile
import unittest

from csvkit import ops

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEXT = 'name,city\nann,oslo\nbob,rome\ncy,oslo\n'


class FilterTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, 'in.csv')
        with open(self.path, 'w', newline='') as f:
            f.write(TEXT)

    def test_keeps_only_matching_rows(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            ops.filter_file(self.path, 'city', 'oslo')
        rows = list(csv.DictReader(io.StringIO(out.getvalue())))
        self.assertEqual([r['name'] for r in rows], ['ann', 'cy'])

    def test_no_match_prints_the_header_only(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            ops.filter_file(self.path, 'city', 'paris')
        self.assertEqual(out.getvalue().splitlines(), ['name,city'])

    def test_where_option_on_the_command_line(self):
        done = subprocess.run(
            [sys.executable, '-m', 'csvkit', 'filter', self.path, '--where', 'city=oslo'],
            cwd=ROOT, capture_output=True, text=True, check=True)
        rows = list(csv.DictReader(io.StringIO(done.stdout)))
        self.assertEqual([r['name'] for r in rows], ['ann', 'cy'])


if __name__ == '__main__':
    unittest.main()
`
}

// ---- inventory (r1, r5): a dependency-free Node service so node:test can run the fixture's tests; node:sqlite needs Node 22.13+.
const INV_PKG = '{\n  "name": "inventory",\n  "type": "module",\n  "engines": { "node": ">=22.13" },\n  "scripts": { "start": "node src/server.js", "test": "node --test" }\n}\n'
const INV_README = '# inventory\n\nStock levels API (src/) and a small web client (web/). Needs Node 22.13 or newer.\n\nRun: npm start (PORT, INVENTORY_DB env). Tests: npm test (node:test).\n'
const ARCH_INV = archDoc('Inventory architecture', 'A dependency-free Node service: an http API over a SQLite file (node:sqlite, migrations applied in order from migrations/) and a small web client of plain ES modules; tests run with node:test.',
  [['src/server.js', 'http routes'], ['src/db.js', 'SQLite queries and the migration runner'], ['migrations/', 'ordered SQL migrations'], ['web/app.js', 'web client: fetch and render'], ['tests/', 'node:test tests']])

const INV_OPEN = raw`
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'

const MIGRATIONS = new URL('../migrations/', import.meta.url)

// Applies the migrations that the file has not seen yet, in file name order (pragma user_version counts them).
export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file)
  const names = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()
  const applied = db.prepare('pragma user_version').get().user_version
  names.slice(applied).forEach((name, i) => {
    db.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'))
    db.exec('pragma user_version = ' + (applied + i + 1))
  })
`
const INV_DB_R1 = INV_OPEN + raw`
  return {
    raw: db,
    stock: (sku) => db.prepare('select sku, qty, reorder_level as reorderLevel from stock where sku = ?').get(sku)
  }
}
`
const INV_DB_R5 = INV_OPEN + raw`
  return {
    raw: db,
    stock: (sku) => db.prepare('select sku, qty from stock where sku = ?').get(sku),
    lowStock: () => db.prepare('select sku, qty, reorder_level as reorderLevel from stock where qty < reorder_level order by sku').all()
  }
}
`
const INV_SERVER = (extraRoute, comment) => raw`
import { createServer as createHttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { openDb } from './db.js'

export function createServer(db) {
  return createHttpServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost')
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
` + extraRoute + raw`
    const match = req.method === 'GET' ? pathname.match(/^\/stock\/([^/]+)$/) : null
    if (match) {
` + comment + raw`
      const row = db.stock(decodeURIComponent(match[1]))
      return row ? send(200, row) : send(404, { error: 'unknown sku' })
    }
    send(404, { error: 'not found' })
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer(openDb(process.env.INVENTORY_DB ?? 'inventory.db')).listen(Number(process.env.PORT ?? 3000))
}
`
const INV_ESC = raw`
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
`
const INV_HELPER = raw`
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createServer } from '../src/server.js'

// Serves a fresh in-memory database (migrations applied, extra rows [sku, qty, reorder_level] inserted) on a free port.
async function withServer(rows, fn) {
  const db = openDb()
  const add = db.raw.prepare('insert into stock (sku, qty, reorder_level) values (?, ?, ?)')
  for (const r of rows) add.run(...r)
  const server = createServer(db)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await fn('http://127.0.0.1:' + server.address().port, db)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

const getJson = async (url) => {
  const res = await fetch(url)
  return { status: res.status, body: await res.json() }
}
`

const R1_FILES = {
  'package.json': INV_PKG,
  'README.md': INV_README,
  '.orgai/ARCHITECTURE.md': ARCH_INV,
  'migrations/001_init.sql': MIGRATION_INIT,
  'migrations/002_index_qty.sql': 'create index stock_qty on stock (qty);\n',
  'migrations/003_seed.sql': "insert into stock (sku, qty) values ('A-1', 10), ('B-2', 4);\n",
  'migrations/004_reorder_level.sql': 'alter table stock add column reorder_level integer not null default 0;\n',
  'migrations/005_backfill.sql': 'update stock set reorder_level = 5 where reorder_level = 0;\n',
  'migrations/006_index.sql': 'create index stock_reorder on stock (reorder_level);\n',
  'src/db.js': INV_DB_R1,
  'src/server.js': INV_SERVER('', '      // responds with { sku, qty, reorderLevel }\n'),
  'web/app.js': INV_ESC + raw`
export function renderStock(row) {
  return '<table><tbody><tr><td>' + esc(row.sku) + '</td><td>' + esc(row.qty) + '</td><td>Reorder level: ' + esc(row.reorderLevel) + '</td></tr></tbody></table>'
}

export async function loadStock(sku, base = '', fetchFn = fetch) {
  const res = await fetchFn(base + '/stock/' + encodeURIComponent(sku))
  if (!res.ok) throw new Error('GET /stock/' + sku + ' failed: ' + res.status)
  return renderStock(await res.json())
}
`,
  'tests/api.test.js': INV_HELPER + raw`

import { loadStock } from '../web/app.js'

test('the migrations add reorder_level and backfill the seeded rows', () => {
  const db = openDb()
  assert.deepEqual({ ...db.stock('A-1') }, { sku: 'A-1', qty: 10, reorderLevel: 5 })
  assert.deepEqual({ ...db.stock('B-2') }, { sku: 'B-2', qty: 4, reorderLevel: 5 })
})

test('GET /stock/:sku returns the reorder level; a row added after the migrations defaults to 0', () =>
  withServer([['C-3', 7, 0]], async (base) => {
    assert.deepEqual(await getJson(base + '/stock/A-1'), { status: 200, body: { sku: 'A-1', qty: 10, reorderLevel: 5 } })
    assert.deepEqual((await getJson(base + '/stock/C-3')).body, { sku: 'C-3', qty: 7, reorderLevel: 0 })
  }))

test('GET /stock/:sku answers 404 for an unknown SKU', () =>
  withServer([], async (base) => {
    assert.equal((await getJson(base + '/stock/nope')).status, 404)
  }))

test('the client shows the quantity and reorder level it loads from the API', () =>
  withServer([], async (base) => {
    const html = await loadStock('A-1', base)
    assert.match(html, /<td>10<\/td>/)
    assert.match(html, /Reorder level: 5/)
  }))
`
}

const R5_FILES = {
  'package.json': INV_PKG,
  'README.md': INV_README,
  '.orgai/ARCHITECTURE.md': ARCH_INV,
  'migrations/001_init.sql': 'create table stock (\n  sku text primary key,\n  qty integer not null default 0,\n  reorder_level integer not null default 0\n);\n',
  'src/db.js': INV_DB_R5,
  'src/server.js': INV_SERVER("    if (req.method === 'GET' && pathname === '/stock/low') return send(200, db.lowStock())\n", ''),
  'web/app.js': INV_ESC + raw`
export function renderLowStock(rows) {
  const body = rows.map((r) => '<tr><td>' + esc(r.sku) + '</td><td>' + esc(r.qty) + '</td><td>' + esc(r.reorderLevel) + '</td></tr>').join('')
  return '<table><thead><tr><th>SKU</th><th>Qty</th><th>Reorder level</th></tr></thead><tbody>' + body + '</tbody></table>'
}

export async function loadLowStock(base = '', fetchFn = fetch) {
  const res = await fetchFn(base + '/stock/low')
  if (!res.ok) throw new Error('GET /stock/low failed: ' + res.status)
  return renderLowStock(await res.json())
}
`,
  'tests/api.test.js': INV_HELPER + raw`

import { loadLowStock, renderLowStock } from '../web/app.js'

const ROWS = [['A-1', 2, 5], ['B-2', 9, 5], ['C-3', 5, 5], ['D-4', 0, 3]]

test('GET /stock/low lists only SKUs under their reorder level, in SKU order', () =>
  withServer(ROWS, async (base) => {
    const { status, body } = await getJson(base + '/stock/low')
    assert.equal(status, 200)
    assert.deepEqual(body, [{ sku: 'A-1', qty: 2, reorderLevel: 5 }, { sku: 'D-4', qty: 0, reorderLevel: 3 }])
  }))

test('GET /stock/:sku still works next to /stock/low and answers 404 for an unknown SKU', () =>
  withServer(ROWS, async (base) => {
    assert.deepEqual(await getJson(base + '/stock/B-2'), { status: 200, body: { sku: 'B-2', qty: 9 } })
    assert.equal((await getJson(base + '/stock/nope')).status, 404)
  }))

test('the client renders one table row per low-stock SKU returned by the API', () =>
  withServer(ROWS, async (base) => {
    const html = await loadLowStock(base)
    assert.equal(html.match(/<tr>/g).length, 3) // header row plus A-1 and D-4
    assert.match(html, /<td>A-1<\/td><td>2<\/td><td>5<\/td>/)
    assert.match(html, /<td>D-4<\/td><td>0<\/td><td>3<\/td>/)
    assert.doesNotMatch(html, /B-2|C-3/)
  }))

test('the client escapes SKU text and renders an empty body when nothing is low', () => {
  assert.match(renderLowStock([{ sku: '<b>', qty: 1, reorderLevel: 2 }]), /&lt;b&gt;/)
  assert.match(renderLowStock([]), /<tbody><\/tbody>/)
})
`
}

// ---- inventory on fastify (r4): needs fastify, vitest and better-sqlite3, which are not installed here, so its tests are not executed by the self-check.
const R4_FILES = {
  'package.json': '{\n  "name": "inventory",\n  "scripts": { "test": "vitest run", "dev": "tsx src/server.ts" },\n  "dependencies": { "fastify": "5.2.1", "better-sqlite3": "11.3.0", "react": "19.0.0", "react-dom": "19.0.0" },\n  "devDependencies": { "vitest": "2.1.8", "tsx": "4.19.2" }\n}\n',
  'README.md': '# inventory\n\nStock levels API (src/) and a small React admin client (web/).\n',
  '.orgai/ARCHITECTURE.md': ARCH6,
  'src/server.ts': raw`
import Fastify from 'fastify'
import { stock } from './db'

export const app = Fastify()
app.get('/stock/:sku', async (req, reply) => {
  const row = stock((req.params as { sku: string }).sku)
  return row ?? reply.code(404).send({ error: 'unknown sku' })
})
// fastify 5: listen takes an options object
if (process.env.VITEST === undefined) app.listen({ port: 3000, host: '127.0.0.1' })
`,
  'src/db.ts': raw`
import Database from 'better-sqlite3'

const db = new Database('inventory.db')
db.exec('create table if not exists stock (sku text primary key, qty integer not null default 0)')

export function stock(sku: string) {
  return db.prepare('select sku, qty from stock where sku = ?').get(sku)
}
`,
  'web/App.tsx': "import { useState } from 'react'\n\nexport function App() {\n  const [sku, setSku] = useState('')\n  return <input value={sku} onChange={(e) => setSku(e.target.value)} placeholder=\"SKU\" />\n}\n",
  'tests/api.test.ts': raw`
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/db', () => ({ stock: (sku: string) => (sku === 'A-1' ? { sku: 'A-1', qty: 10 } : undefined) }))

import { app } from '../src/server'

describe('GET /stock/:sku', () => {
  it('returns the row of a known SKU', async () => {
    const res = await app.inject({ method: 'GET', url: '/stock/A-1' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ sku: 'A-1', qty: 10 })
  })

  it('answers 404 for an unknown SKU', async () => {
    const res = await app.inject({ method: 'GET', url: '/stock/nope' })
    expect(res.statusCode).toBe(404)
  })
})
`
}

// ---- fleet on fastify (r3): static; fastify and Playwright are not installed here.
const R3_FILES = {
  ...FILES11,
  '.orgai/ARCHITECTURE.md': ARCH11,
  'apps/web/src/App.tsx': "import { Dashboard } from './Dashboard'\n\nexport function App() {\n  return <Dashboard />\n}\n",
  'apps/web/src/Dashboard.tsx': "import { useEffect, useState } from 'react'\n\nexport function Dashboard() {\n  const [status, setStatus] = useState<{ vehicleId: string; state: string }[]>([])\n  useEffect(() => { fetch('/vehicles/status').then((r) => r.json()).then(setStatus) }, [])\n  return (\n    <div>\n      <h1>Fleet</h1>\n      <ul>{status.map((v) => <li key={v.vehicleId}>{v.vehicleId}: {v.state}</li>)}</ul>\n    </div>\n  )\n}\n",
  'services/api/src/server.ts': "import Fastify from 'fastify'\n\nconst app = Fastify()\napp.get('/vehicles', async () => [])\n// Resolved merge: the API implementer's version of this endpoint was kept.\napp.get('/vehicles/status', async () => [{ vehicleId: 'v1', state: 'idle' }])\napp.listen({ port: 3000 })\n"
}

// ---- fleet on node:http (r6): the API is dependency-free so its node:test tests can run.
const ARCH11_NODE = archDoc('Fleet architecture', 'A monorepo: React web app and React Native app, a dependency-free Node http API tested with node:test, a Python ETL pipeline and Terraform; Playwright e2e tests.',
  [['apps/web', 'React web app'], ['apps/mobile', 'React Native app'], ['services/api', 'Node http API (node:test)'], ['services/pipeline', 'Python ETL'], ['infra', 'Terraform'], ['tests/e2e', 'Playwright tests']])
const { 'services/api/src/server.ts': _fastifyApi, ...FLEET_BASE } = FILES11
const R6_FILES = {
  ...FLEET_BASE,
  '.orgai/ARCHITECTURE.md': ARCH11_NODE,
  'services/api/package.json': '{\n  "name": "@fleet/api",\n  "type": "module",\n  "scripts": { "start": "node src/server.js", "test": "node --test" }\n}\n',
  'services/api/src/server.js': raw`
import { createServer as createHttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'

export const VEHICLES = Array.from({ length: 50 }, (_, i) => ({ id: 'v' + i }))
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

export function createServer(vehicles = VEHICLES) {
  return createHttpServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'GET' || url.pathname !== '/vehicles') return send(404, { error: 'not found' })
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : DEFAULT_LIMIT
    const start = url.searchParams.has('cursor') ? Number(url.searchParams.get('cursor')) : 0
    if (!Number.isInteger(limit) || limit < 1) return send(400, { error: 'limit must be a positive integer' })
    if (!Number.isInteger(start) || start < 0 || start > vehicles.length) return send(400, { error: 'invalid cursor' })
    const items = vehicles.slice(start, start + Math.min(limit, MAX_LIMIT))
    const end = start + items.length
    send(200, { items, nextCursor: end < vehicles.length ? String(end) : null })
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) createServer().listen(Number(process.env.PORT ?? 3000))
`,
  'services/api/src/server.test.js': raw`
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, VEHICLES } from './server.js'

async function withServer(vehicles, fn) {
  const server = createServer(vehicles)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await fn(async (query) => {
      const res = await fetch('http://127.0.0.1:' + server.address().port + '/vehicles' + query)
      return { status: res.status, body: await res.json() }
    })
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

test('the first page holds 20 vehicles and points at the next one', () =>
  withServer(VEHICLES, async (get) => {
    const { status, body } = await get('')
    assert.equal(status, 200)
    assert.equal(body.items.length, 20)
    assert.equal(body.items[0].id, 'v0')
    assert.equal(body.nextCursor, '20')
  }))

test('following nextCursor visits every vehicle once and ends with a null cursor', () =>
  withServer(VEHICLES, async (get) => {
    const ids = []
    let cursor = null
    do {
      const { body } = await get('?limit=20' + (cursor ? '&cursor=' + cursor : ''))
      ids.push(...body.items.map((v) => v.id))
      cursor = body.nextCursor
    } while (cursor)
    assert.deepEqual(ids, VEHICLES.map((v) => v.id))
  }))

test('limit sets the page size', () =>
  withServer(VEHICLES, async (get) => {
    const { body } = await get('?limit=3&cursor=10')
    assert.deepEqual(body.items.map((v) => v.id), ['v10', 'v11', 'v12'])
    assert.equal(body.nextCursor, '13')
  }))

test('a limit above the maximum is capped at 100', () =>
  withServer(Array.from({ length: 150 }, (_, i) => ({ id: 'x' + i })), async (get) => {
    const { body } = await get('?limit=500')
    assert.equal(body.items.length, 100)
    assert.equal(body.nextCursor, '100')
  }))

test('a bad cursor or limit is a 400', () =>
  withServer(VEHICLES, async (get) => {
    assert.equal((await get('?cursor=abc')).status, 400)
    assert.equal((await get('?cursor=-1')).status, 400)
    assert.equal((await get('?limit=0')).status, 400)
  }))
`
}

/**
 * Paths a retro record names as written or changed (tokens with a known extension in the agents' results, logs and final
 * report). The self-check and the runner tests require each to exist in the prepared folder.
 */
export function recordPaths(scenario) {
  const text = [...(scenario.run?.agents ?? []).map((a) => a.result ?? ''), ...(scenario.run?.logs ?? []).map((l) => l.message), scenario.run?.finalReport ?? ''].join('\n')
  const found = text.match(/[A-Za-z0-9_./-]+\.(?:tsx|ts|py|sql|md|json|js|tf|yml)\b/g) ?? []
  return [...new Set(found)]
}

// ---------------------------------------------------------------- retro: scenarios

const agent = (slug, o = {}) => ({ slug, state: 'done', inputTokens: 40000, outputTokens: 6000, costUsd: 0.4, ...o })

const r1 = {
  id: 'r1', family: 'retro', kind: 'code', setupKind: 'existing', complexity: 3,
  title: 'Missing specialty: the root did database work nobody owns (6 roles)',
  brief: 'Inventory service: a stock API in src/ and a small web client in web/.',
  architectureSummary: 'A dependency-free Node service: an http API over a SQLite file (node:sqlite, migrations applied in order from migrations/) and a small web client of plain ES modules; tests run with node:test.',
  chart: chart6(), files: R1_FILES, git: true, exec: { runner: 'node', cwd: '.', tests: 4 },
  run: {
    task: 'Add a reorder-level column to stock and expose it in the API and the admin client.', status: 'done', minutes: 22, costUsd: 4.7,
    agents: [
      agent('orchestrator', { costUsd: 1.9, result: 'I wrote the three SQL migration files and the schema change myself (migrations/004 to 006) because none of my reports owns the database; the backend implementer\'s brief covers handlers only. Then the backend and frontend implementers finished their parts.' }),
      agent('backend-implementer', { costUsd: 0.9, result: 'Added reorderLevel to the stock query in src/db.js and noted the response shape in src/server.js; had to adapt to the migration the orchestrator wrote.', worktree: { status: 'merged', files: 2 } }),
      agent('frontend-implementer', { costUsd: 0.6, result: 'Added the reorder level to the table in web/app.js.', worktree: { status: 'merged', files: 1 } }),
      agent('tester', { costUsd: 0.7, result: 'Added 4 tests in tests/api.test.js for the new field (migrations, the endpoint with a real server, a 404, the client); all 4 pass.' }),
      agent('reviewer', { costUsd: 0.4, result: 'Looks fine. Note: the migrations have no rollback and nobody was assigned to check them.' })
    ],
    logs: [{ level: 'warn', message: 'The orchestrator edited files itself (migrations/004_reorder_level.sql, migrations/005_backfill.sql, migrations/006_index.sql) instead of delegating.' }],
    finalReport: 'Done. The reorder level is stored, served by the API and shown in the client. I also wrote the migrations myself since no role owns the database.'
  },
  expect: {
    mustChange: [{ newRole: 'a database / migrations specialist', cover: [/database|migration|schema|\bsql\b/i] }],
    mayChange: ['orchestrator', 'backend-implementer'],
    mustNotChange: ['frontend-implementer', 'tester', 'reviewer', 'researcher'],
    mustNotRemove: [], maxRolesListed: 2, allowSpendRaise: false
  }
}

const r2 = {
  id: 'r2', family: 'retro', kind: 'code', setupKind: 'existing', complexity: 2,
  title: 'A role lacked a tool it needed (3 roles)',
  brief: 'csvkit: a small Python command-line tool for sorting, filtering and joining CSV files.',
  architectureSummary: 'A pure-Python CLI (argparse) with the logic in csvkit/ops.py and unittest tests under tests/.',
  chart: chart3(), files: R2_FILES, git: true, exec: { runner: 'python', cwd: '.', tests: 5 },
  run: {
    task: 'Add a filter subcommand with a --where COLUMN=VALUE option and test it.', status: 'done', minutes: 12, costUsd: 1.9,
    agents: [
      agent('orchestrator', { costUsd: 0.7, result: 'Implementer added the subcommand; the tester wrote tests but could not run them, so I ran the suite myself: all 5 tests pass.' }),
      agent('implementer', { costUsd: 0.6, result: 'Added filter to csvkit/cli.py and csvkit/ops.py.', worktree: { status: 'merged', files: 2 } }),
      agent('tester', { costUsd: 0.6, state: 'done', result: 'Wrote tests/test_filter.py (3 tests). I could not run them: every Bash call was denied because my role has no Bash tool, so the tests are unverified by me.' })
    ],
    logs: [{ level: 'warn', message: 'Tester: Bash was denied (tool not in the role): "python -m unittest discover -s tests"' }, { level: 'warn', message: 'Tester: Bash was denied (tool not in the role): "python -m unittest tests.test_filter"' }],
    deniedToolResults: 7,
    finalReport: 'Filter subcommand added and tested (the orchestrator ran the suite after the tester could not; 5 tests pass).'
  },
  expect: {
    mustChange: [{ slug: 'tester', fields: ['tools'], toolsAdded: ['Bash'] }],
    mayChange: [], mustNotChange: ['orchestrator', 'implementer'],
    mustNotRemove: [], maxRolesListed: 1, allowSpendRaise: false
  }
}

const r3 = {
  id: 'r3', family: 'retro', kind: 'code', setupKind: 'existing', complexity: 4,
  title: 'A prompt misled a role into editing outside its brief (11 roles, middle layer)',
  brief: 'Fleet: web and mobile apps, an API, an ETL pipeline and Terraform.',
  architectureSummary: 'A monorepo: React web app and React Native app, a Fastify API, a Python ETL pipeline and Terraform; Playwright e2e tests.',
  chart: chart11({
    webPrompt: 'You are the web implementer. Follow the architecture document. Make the web app work end to end: if you find a bug or a missing endpoint anywhere in the repository while you work, fix it yourself right away in whatever file it lives, so nobody has to wait. Report back when the feature works.'
  }),
  files: R3_FILES, git: true,
  run: {
    task: 'Show the vehicle status on the web dashboard.', status: 'done', minutes: 31, costUsd: 9.8,
    agents: [
      agent('orchestrator', { costUsd: 2.1, result: 'Handed the dashboard work to the client lead and the status endpoint to the platform lead. Two branches conflicted at the end and I resolved them by hand.' }),
      agent('client-lead', { costUsd: 1.4, result: 'Web implementer finished; its branch touched services/api/src/server.ts as well.' }),
      agent('web-implementer', { costUsd: 1.7, result: 'Dashboard works. I also added the /vehicles/status endpoint myself in services/api/src/server.ts because it was missing.', worktree: { status: 'conflict', files: 4 } }),
      agent('platform-lead', { costUsd: 1.2, result: 'API implementer added /vehicles/status as briefed.' }),
      agent('api-implementer', { costUsd: 1.3, result: 'Added /vehicles/status in services/api/src/server.ts. My branch conflicts with the web implementer\'s edit of the same function.', worktree: { status: 'conflict', files: 2 } }),
      agent('reviewer', { costUsd: 0.5, result: 'Two implementations of the same endpoint existed; kept the API implementer\'s.' })
    ],
    logs: [
      { level: 'warn', message: 'Merge conflict in services/api/src/server.ts between the Web Implementer and the API Implementer branches.' },
      { level: 'warn', message: 'Web Implementer changed files outside its brief: services/api/src/server.ts.' }
    ],
    finalReport: 'Dashboard shows the status. A merge conflict in the API server file was resolved by keeping the API implementer\'s version.'
  },
  expect: {
    mustChange: [{
      slug: 'web-implementer', fields: ['prompt'],
      promptMatches: [/\b(stay|remain|keep|limit|restrict|confine)\w*\b[^.]{0,80}\b(brief|assigned|files|scope|apps\/web)/i, /\bonly (edit|change|touch|modify|write)\b/i, /outside (your|its) brief/i],
      promptNotMatches: [/anywhere in the repository/i, /whatever file it lives/i]
    }],
    mayChange: ['client-lead'],
    mustNotChange: ['orchestrator', 'mobile-implementer', 'ui-tester', 'platform-lead', 'api-implementer', 'data-pipeline-implementer', 'infra-engineer', 'reviewer', 'researcher'],
    mustNotRemove: [], maxRolesListed: 2, allowSpendRaise: false
  }
}

const r4 = {
  id: 'r4', family: 'retro', kind: 'code', setupKind: 'existing', complexity: 3,
  title: 'An over-provisioned role: deep tier doing mechanical lookups (6 roles)',
  brief: 'Inventory service: a stock API in src/ and a small React admin client in web/.',
  architectureSummary: 'A Fastify API over a SQLite file with a small React admin client; tests run with vitest.',
  chart: chart6({ researcherTier: 'deep' }), files: R4_FILES, git: true,
  run: {
    task: 'Upgrade fastify to the latest 5.x and fix what breaks.', status: 'done', minutes: 18, costUsd: 8.9,
    agents: [
      agent('orchestrator', { costUsd: 1.5, result: 'Asked the researcher for the changelog and every call site, then had the backend implementer apply the upgrade.' }),
      agent('researcher', { costUsd: 4.8, inputTokens: 310000, outputTokens: 22000, result: 'Listed every call site of app.get and app.listen with file and line, and summarized the 5.x changelog entries about the listen signature. (Mechanical grep and changelog lookup; 41 tool calls.)' }),
      agent('backend-implementer', { costUsd: 1.2, result: 'Raised fastify in package.json and applied the upgrade in src/server.ts (listen takes an options object); the 2 tests in tests/api.test.ts pass.', worktree: { status: 'merged', files: 2 } }),
      agent('tester', { costUsd: 0.7, result: 'Ran the suite: the 2 tests in tests/api.test.ts pass.' }),
      agent('reviewer', { costUsd: 0.7, result: 'Read package.json and src/server.ts: the version and the listen call match fastify 5. No problems.' })
    ],
    logs: [{ level: 'info', message: 'Researcher (model opus, tier deep) used 332k tokens on lookups: grep for call sites and reading a changelog.' }],
    finalReport: 'fastify upgraded; all tests pass.'
  },
  expect: {
    mustChange: [{ slug: 'researcher', fields: ['tier'], tierChange: 'down' }],
    mayChange: [], mustNotChange: ['orchestrator', 'backend-implementer', 'frontend-implementer', 'tester', 'reviewer'],
    mustNotRemove: [], maxRolesListed: 1, allowSpendRaise: false
  }
}

const r5 = {
  id: 'r5', family: 'retro', kind: 'code', setupKind: 'existing', complexity: 3,
  title: 'A healthy run: nothing should change (6 roles)',
  brief: 'Inventory service: a stock API in src/ and a small web client in web/.',
  architectureSummary: 'A dependency-free Node service: an http API over a SQLite file (node:sqlite, migrations applied in order from migrations/) and a small web client of plain ES modules; tests run with node:test.',
  chart: chart6(), files: R5_FILES, git: true, exec: { runner: 'node', cwd: '.', tests: 4 },
  run: {
    task: 'Add a /stock/low endpoint listing SKUs under their reorder level, with a table in the web client.', status: 'done', minutes: 20, costUsd: 3.6,
    agents: [
      agent('orchestrator', { costUsd: 1.1, result: 'Split API and client work, had the tester and reviewer check both, merged cleanly.' }),
      agent('backend-implementer', { costUsd: 0.8, result: 'Added /stock/low in src/server.js and the query in src/db.js.', worktree: { status: 'merged', files: 2 } }),
      agent('frontend-implementer', { costUsd: 0.6, result: 'Added the low-stock table (renderLowStock, loadLowStock) in web/app.js.', worktree: { status: 'merged', files: 1 } }),
      agent('tester', { costUsd: 0.5, result: 'Added 4 tests in tests/api.test.js: /stock/low against a real server with a SKU exactly at its level, /stock/:sku next to it, the client table loading from the live endpoint, and escaping. Ran the suite: all 4 pass.' }),
      agent('reviewer', { costUsd: 0.4, result: 'Read src/server.js, src/db.js, web/app.js and tests/api.test.js. The query uses a strict qty < reorder_level and the tests include a SKU exactly at its level. No problems found.' }),
      agent('researcher', { costUsd: 0.2, result: 'Confirmed from the node:sqlite documentation that prepare().all() returns the rows the query relies on.' })
    ],
    logs: [],
    finalReport: 'The low-stock endpoint and client table are in and tested (4 tests pass); no conflicts, no denied tools, every role was used as intended.'
  },
  expect: { mustChange: [], expectNoChange: true, mayChange: [], mustNotChange: [], mustNotRemove: [], maxRolesListed: 0, allowSpendRaise: false }
}

const r6 = {
  id: 'r6', family: 'retro', kind: 'code', setupKind: 'existing', complexity: 4,
  title: 'Roles unused in this run must not be removed (11 roles)',
  brief: 'Fleet: web and mobile apps, an API, an ETL pipeline and Terraform.',
  architectureSummary: 'A monorepo: React web app and React Native app, a dependency-free Node http API tested with node:test, a Python ETL pipeline and Terraform; Playwright e2e tests.',
  chart: chart11(), files: R6_FILES, git: true, exec: { runner: 'node', cwd: 'services/api', tests: 5 },
  run: {
    task: 'Add pagination to GET /vehicles in the API.', status: 'done', minutes: 11, costUsd: 3.1,
    agents: [
      agent('orchestrator', { costUsd: 0.9, result: 'A backend-only change: handed it to the platform lead, then asked the reviewer to check.' }),
      agent('platform-lead', { costUsd: 0.7, result: 'API implementer did it.' }),
      agent('api-implementer', { costUsd: 0.9, result: 'Added limit and cursor to services/api/src/server.js with 5 tests in services/api/src/server.test.js; all 5 pass.', worktree: { status: 'merged', files: 2 } }),
      agent('reviewer', { costUsd: 0.6, result: 'Read services/api/src/server.js and its tests. The tests cover the first page, walking to the last page, the page size, the limit cap and a bad cursor or limit. No problems found.' })
    ],
    logs: [],
    finalReport: 'GET /vehicles now paginates; 5 tests pass. The web, mobile, pipeline and infra roles were not needed for this task.'
  },
  expect: {
    mustChange: [], mayChange: ['orchestrator', 'platform-lead', 'api-implementer', 'reviewer'],
    mustNotChange: ['client-lead', 'web-implementer', 'mobile-implementer', 'ui-tester', 'data-pipeline-implementer', 'infra-engineer', 'researcher'],
    mustNotRemove: ['client-lead', 'web-implementer', 'mobile-implementer', 'ui-tester', 'data-pipeline-implementer', 'infra-engineer', 'researcher'],
    maxRolesListed: 1, allowSpendRaise: false
  }
}

export const RETRO_SCENARIOS = [r1, r2, r3, r4, r5, r6]
export const SCENARIOS = [...RECOMMEND_SCENARIOS, ...RETRO_SCENARIOS]

export function scenarioById(id) {
  return SCENARIOS.find((s) => s.id === id)
}

/** Scenarios of a family: 'recommend', 'retro' or 'all'. */
export function scenariosOf(family = 'all') {
  return family === 'recommend' ? RECOMMEND_SCENARIOS : family === 'retro' ? RETRO_SCENARIOS : SCENARIOS
}
