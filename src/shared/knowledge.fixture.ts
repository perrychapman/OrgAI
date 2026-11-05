import type { KnowledgeEdge, KnowledgeFact, KnowledgeGraph, KnowledgeNode, KnowledgeSource } from './types'

/**
 * A fictional client engagement as a knowledge graph, for tests and measurements of the pure layer (knowledgeIndex,
 * knowledgeLinks). All names are invented (except Stripe, a real product name that the Stripe traps need).
 * The scenario: Quill & Rowe, a consultancy, moves the invoicing of Halden Freight from a legacy system to Stripe.
 *
 * It is written WITH traps on purpose, because a fixture that flatters the feature measures nothing: a person
 * "William Okafor" with the alias Bill and prose about "the bill run"; a team called Finance and lower-case "finance"
 * in prose; a system Atlas and "an atlas of processes"; Stripe as both organisation and system; a person with the
 * alias Mark and the verb "mark"; the client organisation named everywhere (the hub); "Core" inside "Billing Core";
 * a retired decision, a retired risk and retired facts; a catch-all context note linked to a dozen unrelated entities.
 *
 * Ground truth is the author's intent. In summaries and facts, `{Surface}`, `{Surface|Entity}` and
 * `{Surface|Entity|relation}` mark a place where the text really refers to an entity (the braces are removed from the
 * stored text; `Entity` is an entity name, or `Name#kind` when the name is not unique, and may be left out when it
 * equals Surface; `relation` is the relation word the author would record for that reference, if there is one). A name
 * that appears WITHOUT braces is not a reference (a trap). A fixture written by the same people who wrote the matcher
 * is a weak test: precision measured here does not predict precision on real data.
 */

interface Spec {
  kind: string
  name: string
  aliases?: string[]
  summary?: string
  facts?: string[]
  /** Retired facts (kept for history, never indexed). */
  deadFacts?: string[]
  /** Context note ids. A trailing '*' marks an incidental link (the entity is not what the note is about). */
  notes?: string[]
  retired?: boolean
  by?: 'user'
  run?: string
}

const SPECS: Spec[] = [
  // ---- organisations ----
  { kind: 'organisation', name: 'Halden Freight', aliases: ['Halden'], run: 'run_1', notes: ['note_kickoff', 'note_weekly*'],
    summary: 'Regional freight and haulage company, the client. About 1,400 staff across four depots.',
    facts: ['Fiscal year ends on 31 March', 'Invoices about 310,000 documents a year', 'The board approved the billing programme at {Steering committee 3|Steering committee 3#meeting}'],
    deadFacts: ['Invoices about 280,000 documents a year'] },
  { kind: 'organisation', name: 'Finance', run: 'run_1', notes: ['note_kickoff', 'note_weekly*'],
    summary: "{Halden|Halden Freight}'s finance team, owner of invoicing and collections. Led by {Lena Koster}.",
    facts: ['Closes the month on working day 5', 'Wants read access to {Atlas} during cut-over'] },
  { kind: 'organisation', name: 'Operations', run: 'run_1', notes: ['note_kickoff'],
    summary: "{Halden|Halden Freight}'s depot operations team. Raises most disputed invoices. Led by {Felix Brandt}.",
    facts: ['Works from four depots'] },
  { kind: 'organisation', name: 'Stripe', run: 'run_2',
    summary: 'Payment processor and billing vendor chosen for the new billing. Account manager is {Omar Faris}.',
    facts: ['Contract signed on 20 January'] },
  { kind: 'organisation', name: 'Ledgerline Software', run: 'run_2',
    summary: 'Vendor of the legacy billing system {Ledgerline}. Support contact is {Jonas Lindqvist}.',
    facts: ['Announced a price rise of 12 percent'] },
  { kind: 'organisation', name: 'Brightwell Audit LLP', aliases: ['Brightwell'], run: 'run_4', notes: ['note_audit'],
    summary: 'External auditor for {Halden|Halden Freight}. Lead auditor is {Sofia Marchetti}.',
    facts: ['Audit fieldwork starts in April'] },
  { kind: 'organisation', name: 'Quill & Rowe', aliases: ['Quill and Rowe'], by: 'user',
    summary: 'The consultancy running this engagement.' },
  { kind: 'organisation', name: 'Atlas Freight', aliases: ['Atlas'], run: 'run_4',
    summary: 'A competing haulier. {Halden|Halden Freight} benchmarks its prices against it.' },
  { kind: 'organisation', name: 'Core Logistics', aliases: ['Core'], run: 'run_4',
    summary: 'Subcontractor that runs two of the depots. Unrelated to the ERP.' },

  // ---- systems ----
  { kind: 'system', name: 'Ledgerline', run: 'run_2', notes: ['note_walkthrough', 'note_weekly*'],
    summary: 'Legacy billing and invoicing system, in production since 2014. Owned by {Finance}, supported by {Ledgerline Software}.',
    facts: [
      'The bill run takes about six hours and blocks the portal',
      'Invoices leave it through {Legacy Export}',
      'Vendor support ends on 30 June'
    ],
    deadFacts: ['Vendor support ends on 30 September'] },
  { kind: 'system', name: 'Stripe', run: 'run_2', notes: ['note_weekly*'],
    summary: 'Stripe Billing, the target platform for invoicing and payments. Reached through {Billing Core}.',
    facts: ['Calculates VAT per line item', 'Test mode account is live'] },
  { kind: 'system', name: 'Billing Core', run: 'run_2', notes: ['note_weekly*'],
    summary: 'New billing service that wraps Stripe and posts journals to {Core}. Built by the {Halden|Halden Freight} IT team under {Tomas Weiss}.',
    facts: ['First build deployed to the test environment'] },
  { kind: 'system', name: 'Core', run: 'run_2',
    summary: "{Halden|Halden Freight}'s ERP core ledger. Owned by {Finance}.",
    facts: ['Month-end close runs from here'] },
  { kind: 'system', name: 'Atlas', run: 'run_2', notes: ['note_weekly*'],
    summary: 'Data warehouse used for revenue reporting. Loads from {Legacy Export} every night.',
    facts: ['{Finance} reads revenue figures from it'] },
  { kind: 'system', name: 'Legacy Export', run: 'run_2', notes: ['note_walkthrough'],
    summary: 'Fixed-width file export from {Ledgerline}, read by {Atlas} and by auditors. The format is undocumented.',
    facts: ['Written to the {SFTP Gateway} at 07:00'] },
  { kind: 'system', name: 'Customer Portal', run: 'run_2',
    summary: 'Web portal where customers view and pay invoices. Reads invoices from {Ledgerline}.',
    facts: ['About 9,000 customer logins a month'] },
  { kind: 'system', name: 'Dispatch Hub', run: 'run_2',
    summary: 'Route planning tool that raises one invoice line per delivery leg. Owned by {Operations}.' },
  { kind: 'system', name: 'SFTP Gateway', run: 'run_2',
    summary: 'File transfer endpoint that receives the nightly export. Owned by the IT team.' },

  // ---- people ----
  { kind: 'person', name: 'Priya Raman', aliases: ['Priya'], run: 'run_1', notes: ['note_kickoff', 'note_steerco3', 'note_weekly*'],
    summary: 'CFO of {Halden Freight} and programme sponsor.',
    facts: ['Approves every cut-over decision', 'Prefers a one-page weekly summary'] },
  { kind: 'person', name: 'Tomas Weiss', aliases: ['Tomas'], run: 'run_1', notes: ['note_steerco3'],
    summary: 'IT director at {Halden Freight}, owner of {Billing Core}.' },
  { kind: 'person', name: 'William Okafor', aliases: ['Bill'], run: 'run_1', notes: ['note_walkthrough'],
    summary: 'Accounts receivable lead in {Finance}. Runs the nightly invoice batch by hand when it fails.',
    facts: ['Knows the quirks of {Legacy Export} better than anyone'] },
  { kind: 'person', name: 'Mark Ellis', aliases: ['Mark'], run: 'run_1',
    summary: 'Data migration lead at {Quill & Rowe}.' },
  { kind: 'person', name: 'Ines Duarte', aliases: ['Ines'], by: 'user', notes: ['note_steerco3'],
    summary: 'Engagement lead at {Quill & Rowe}.' },
  { kind: 'person', name: 'Hannah Pruitt', aliases: ['Hannah'], run: 'run_1',
    summary: 'Analyst at {Quill & Rowe}; keeps the context notes.' },
  { kind: 'person', name: 'Lena Koster', aliases: ['Lena'], run: 'run_1', notes: ['note_kickoff', 'note_walkthrough'],
    summary: 'Finance manager at {Halden Freight}; leads {Finance}.',
    facts: ['Available Tuesday to Thursday'] },
  { kind: 'person', name: 'Felix Brandt', run: 'run_1', notes: ['note_kickoff'],
    summary: 'Operations manager at {Halden Freight}; leads {Operations}.' },
  { kind: 'person', name: 'Omar Faris', run: 'run_2',
    summary: 'Account manager at {Stripe|Stripe#organisation}.' },
  { kind: 'person', name: 'Sofia Marchetti', run: 'run_4', notes: ['note_audit'],
    summary: 'Lead auditor at {Brightwell Audit LLP}.' },
  { kind: 'person', name: 'Jonas Lindqvist', run: 'run_2',
    summary: 'Support engineer at {Ledgerline Software}.' },
  { kind: 'person', name: 'Dana Whitcombe', run: 'run_4',
    summary: "{Halden|Halden Freight}'s legal counsel; reviews contract terms and data retention." },
  { kind: 'person', name: 'Noor Haddad', run: 'run_3',
    summary: 'Customer support lead; handles disputed invoices from the {Customer Portal}.' },

  // ---- documents ----
  { kind: 'document', name: 'Statement of Work', aliases: ['SoW'], run: 'run_4',
    summary: 'Contract scope signed on 2 September: billing migration plus reporting. Signed by {Priya Raman}.',
    facts: ['Core scope covers invoicing only'] },
  { kind: 'document', name: 'Migration Plan v2', run: 'run_4',
    summary: 'Phased plan by region, drafted by {Ines Duarte}. Implements {Phased cut-over by region}.' },
  { kind: 'document', name: 'Invoice Format Spec', run: 'run_4',
    summary: 'Field-level description of {Legacy Export}, reverse engineered by {Hannah Pruitt}. Incomplete.' },
  { kind: 'document', name: 'Audit Findings 2025', run: 'run_4', notes: ['note_audit'],
    summary: "Last year's audit report by {Brightwell Audit LLP}; flagged gaps in tax codes." },
  { kind: 'document', name: 'Tax Treatment Memo', run: 'run_4',
    summary: 'Legal memo on VAT for freight surcharges, written by {Dana Whitcombe}.' },
  { kind: 'document', name: 'Data Retention Policy', run: 'run_4',
    summary: "{Halden|Halden Freight}'s policy: invoices are kept for seven years." },
  { kind: 'document', name: 'Pricing Schedule', run: 'run_4',
    summary: 'Customer rate cards, loaded into {Stripe|Stripe#system} as products.' },
  { kind: 'document', name: 'Finance interview notes', run: 'run_1', notes: ['note_walkthrough'],
    summary: 'Notes from interviews with finance staff. Mapped an atlas of processes across the depots.',
    facts: ['{Lena|Lena Koster} says credit notes need two approvers'] },
  { kind: 'document', name: 'Risk review', run: 'run_3',
    summary: 'Minutes and the current risk list from the weekly risk meeting.' },

  // ---- decisions ----
  { kind: 'decision', name: 'Migrate billing to Stripe', run: 'run_3', notes: ['note_steerco3'],
    summary: 'Move all invoicing to {Stripe|Stripe#system} and retire {Ledgerline}.',
    facts: ['Decided on 12 January', 'Alternative considered: extend the {Ledgerline|Ledgerline} contract'] },
  { kind: 'decision', name: 'Keep Ledgerline read-only until audit', run: 'run_3',
    summary: '{Ledgerline} stays available read-only until {Audit sign-off 30 April}. Agreed with {Sofia Marchetti}.' },
  { kind: 'decision', name: 'Phased cut-over by region', run: 'run_3', notes: ['note_steerco3'],
    summary: 'Cut over region by region, northern depots first, instead of one weekend. Proposed by {Ines Duarte}.' },
  { kind: 'decision', name: 'Use net-30 default terms', run: 'run_3',
    summary: 'Default payment terms become net 30. Raised by {Lena Koster}; applies to every invoice in {Stripe|Stripe#system}.' },
  { kind: 'decision', name: 'Move reporting to Atlas', run: 'run_3',
    summary: 'Revenue reporting reads from {Atlas} after cut-over instead of {Ledgerline}.' },
  { kind: 'decision', name: 'Defer customer portal changes', run: 'run_3',
    summary: 'No changes to the {Customer Portal} before cut-over. Decided with {Tomas Weiss}.' },
  { kind: 'decision', name: 'Keep per-leg pricing', retired: true, run: 'run_3',
    summary: 'Retired: replaced by flat route pricing in the {Pricing Schedule}.' },

  // ---- risks ----
  { kind: 'risk', name: 'Legacy export format undocumented', run: 'run_3', notes: ['note_weekly*'],
    summary: 'No spec exists for {Legacy Export}; reverse engineering is incomplete. Could break the {Atlas|Atlas|affects} load.' },
  { kind: 'risk', name: 'Duplicate invoices on cut-over', run: 'run_3', notes: ['note_weekly*'],
    summary: 'Invoices could be issued from both {Ledgerline|Ledgerline|affects} and {Billing Core|Billing Core|affects} during the overlap.',
    facts: ['Bill run overran twice in September, leaving duplicates'] },
  { kind: 'risk', name: 'Tax calculation mismatch', run: 'run_3',
    summary: '{Stripe|Stripe#system|affects} calculates VAT per line, {Ledgerline} per invoice. Differences show on freight surcharges.' },
  { kind: 'risk', name: 'Key person dependency', run: 'run_3',
    summary: 'Only {Bill|William Okafor} knows the manual re-run procedure for {Ledgerline|Ledgerline|affects}.' },
  { kind: 'risk', name: 'Customer portal downtime', run: 'run_3',
    summary: 'The {Customer Portal|Customer Portal|affects} may be unavailable during {Cut-over weekend 14 March}.' },
  { kind: 'risk', name: 'Audit scope creep', run: 'run_4',
    summary: '{Brightwell Audit LLP} may widen the review to include {Core|Core|affects}.' },
  { kind: 'risk', name: 'Vendor price rise', retired: true, run: 'run_2',
    summary: '{Ledgerline Software} announced a price rise; no longer relevant after the migration decision.' },

  // ---- requirements ----
  { kind: 'requirement', name: 'VAT per line', run: 'run_4',
    summary: 'Invoices must show VAT per line. Source: {Tax Treatment Memo}.' },
  { kind: 'requirement', name: 'Multi-currency invoices', run: 'run_4',
    summary: 'Support EUR and GBP invoices; requested by {Priya Raman}.' },
  { kind: 'requirement', name: 'Audit trail for 7 years', run: 'run_4',
    summary: 'All invoice changes are retained for seven years, per the {Data Retention Policy}.' },

  // ---- deadlines ----
  { kind: 'deadline', name: 'Cut-over weekend 14 March', run: 'run_3',
    summary: 'Planned switch from {Ledgerline} to {Stripe|Stripe#system}. Approved by {Priya Raman}.',
    facts: ['{Bill|William Okafor} confirmed that collections can pause that weekend', '{Mark|Mark Ellis} agreed to run the first reconciliation'] },
  { kind: 'deadline', name: 'Audit sign-off 30 April', run: 'run_4', notes: ['note_audit'],
    summary: '{Brightwell Audit LLP} signs off the opening balances.' },

  // ---- meetings ----
  { kind: 'meeting', name: 'Steering committee 3', run: 'run_3', notes: ['note_steerco3'],
    summary: 'Approved {Migrate billing to Stripe}. Attended by {Priya Raman}, {Tomas Weiss} and {Ines Duarte}.' },
  { kind: 'document', name: 'Kickoff workshop', run: 'run_1', notes: ['note_kickoff'],
    summary: 'Slides and minutes from the workshop.' },
  { kind: 'document', name: 'Steering committee 3', run: 'run_3', summary: 'Slide pack and decisions log for the third steering meeting.' },
  { kind: 'meeting', name: 'Kickoff workshop', run: 'run_1', notes: ['note_kickoff'],
    summary: 'Introduced the team to {Halden Freight} staff.',
    facts: ['finance staff asked about credit notes'] },
  { kind: 'meeting', name: 'Risk review', run: 'run_3',
    summary: 'Weekly review of the risk list, chaired by {Ines Duarte}.',
    facts: ['The finance review was moved to Thursday'] },

  // ---- open questions ----
  { kind: 'open-question', name: 'Who approves credit notes?', run: 'run_1', notes: ['note_walkthrough'],
    summary: '{Finance} says two approvers, {Operations} says one. Ask {Lena Koster}.',
    facts: ['Raised in the {Finance interview notes}'] },
  { kind: 'open-question', name: 'Does Core retain invoice numbers?', run: 'run_3',
    summary: 'Unclear whether {Core} keeps the {Ledgerline} invoice numbers after migration.' },
  { kind: 'open-question', name: 'Is the audit window fixed?', run: 'run_4', notes: ['note_audit'],
    summary: '{Sofia Marchetti} has not confirmed the window.' },
  { kind: 'open-question', name: 'Which tax codes apply to freight surcharges?', run: 'run_4',
    summary: 'Needed to settle the {Tax calculation mismatch}. {Dana Whitcombe} is checking.' },

  // ---- deliverables ----
  { kind: 'deliverable', name: 'Cut-over runbook', run: 'run_3',
    summary: 'Step-by-step runbook for the {Cut-over weekend 14 March}. Written by {Hannah Pruitt}.' },
  { kind: 'deliverable', name: 'Reconciliation report', run: 'run_3',
    summary: 'Compares {Ledgerline} and {Stripe|Stripe#system} totals after cut-over; reads from {Atlas}.' },
  { kind: 'deliverable', name: 'Training deck', run: 'run_3',
    summary: 'Training for users in {Finance} and {Operations}.',
    facts: ['Mark invoices as disputed in the portal before cut-over', 'Users should mark disputed invoices in the {Customer Portal}'] }
]

/** [from, relation, to, note?, retired?]. Entities by name, or `Name#kind` when the name is not unique. */
type EdgeSpec = [string, string, string, string?, boolean?]

const S = 'Stripe#system'
const SO = 'Stripe#organisation'
const MR = 'Risk review#meeting'
const SC = 'Steering committee 3#meeting'
const KW = 'Kickoff workshop#meeting'

const EDGES: EdgeSpec[] = [
  // people and teams (the client organisation is the hub)
  ['Priya Raman', 'works-at', 'Halden Freight'], ['Tomas Weiss', 'works-at', 'Halden Freight'], ['Lena Koster', 'works-at', 'Halden Freight'],
  ['Felix Brandt', 'works-at', 'Halden Freight'], ['Dana Whitcombe', 'works-at', 'Halden Freight'], ['Noor Haddad', 'works-at', 'Halden Freight'],
  ['William Okafor', 'works-at', 'Halden Freight'], ['Lena Koster', 'works-at', 'Finance'], ['William Okafor', 'works-at', 'Finance'],
  ['Felix Brandt', 'works-at', 'Operations'], ['Noor Haddad', 'works-at', 'Operations'],
  ['Ines Duarte', 'works-at', 'Quill & Rowe'], ['Hannah Pruitt', 'works-at', 'Quill & Rowe'], ['Mark Ellis', 'works-at', 'Quill & Rowe'],
  ['Omar Faris', 'works-at', SO], ['Jonas Lindqvist', 'works-at', 'Ledgerline Software'], ['Sofia Marchetti', 'works-at', 'Brightwell Audit LLP'],
  ['Lena Koster', 'reports-to', 'Priya Raman'], ['Tomas Weiss', 'reports-to', 'Priya Raman'], ['Felix Brandt', 'reports-to', 'Priya Raman'],
  ['William Okafor', 'reports-to', 'Lena Koster'], ['Hannah Pruitt', 'reports-to', 'Ines Duarte'], ['Mark Ellis', 'reports-to', 'Ines Duarte'],
  ['Halden Freight', 'client-of', 'Quill & Rowe'], ['Atlas Freight', 'competes-with', 'Halden Freight'],
  // ownership and vendors
  ['Finance', 'owns', 'Ledgerline'], ['Finance', 'owns', 'Core'], ['Operations', 'owns', 'Dispatch Hub'], ['Tomas Weiss', 'owns', 'Billing Core'],
  ['Ledgerline Software', 'vendor-of', 'Ledgerline'], [SO, 'vendor-of', S],
  // system dependencies
  ['Billing Core', 'depends-on', S], ['Billing Core', 'depends-on', 'Core'], ['Customer Portal', 'depends-on', 'Ledgerline'],
  ['Atlas', 'depends-on', 'Legacy Export'], ['Legacy Export', 'depends-on', 'Ledgerline'], ['SFTP Gateway', 'depends-on', 'Legacy Export'],
  ['Dispatch Hub', 'depends-on', 'Ledgerline'],
  // risks affect systems
  ['Legacy export format undocumented', 'affects', 'Atlas'], ['Legacy export format undocumented', 'affects', 'Legacy Export'],
  ['Duplicate invoices on cut-over', 'affects', 'Ledgerline'], ['Duplicate invoices on cut-over', 'affects', 'Billing Core'],
  ['Tax calculation mismatch', 'affects', S], ['Tax calculation mismatch', 'affects', 'Billing Core'],
  ['Customer portal downtime', 'affects', 'Customer Portal'], ['Audit scope creep', 'affects', 'Core'],
  ['Key person dependency', 'affects', 'Ledgerline'], ['Vendor price rise', 'affects', 'Ledgerline'],
  // who raised what
  ['Key person dependency', 'raised-by', 'Ines Duarte'], ['Tax calculation mismatch', 'raised-by', 'Hannah Pruitt'],
  ['Legacy export format undocumented', 'raised-by', 'Hannah Pruitt'], ['Duplicate invoices on cut-over', 'raised-by', 'Mark Ellis'],
  ['Customer portal downtime', 'raised-by', 'Noor Haddad'], ['Audit scope creep', 'raised-by', 'Ines Duarte'],
  ['Who approves credit notes?', 'raised-by', 'Hannah Pruitt'], ['Does Core retain invoice numbers?', 'raised-by', 'Mark Ellis'],
  // decisions
  ['Migrate billing to Stripe', 'decided-by', 'Priya Raman'], ['Phased cut-over by region', 'decided-by', 'Priya Raman'],
  ['Keep Ledgerline read-only until audit', 'decided-by', 'Priya Raman'], ['Use net-30 default terms', 'decided-by', 'Priya Raman'],
  ['Move reporting to Atlas', 'decided-by', 'Priya Raman'], ['Defer customer portal changes', 'decided-by', 'Tomas Weiss'],
  ['Migrate billing to Stripe', 'decided-in', SC], ['Phased cut-over by region', 'decided-in', SC],
  ['Migrate billing to Stripe', 'replaces', 'Ledgerline'], ['Move reporting to Atlas', 'affects', 'Atlas'],
  // evidence and mitigation
  ['Audit Findings 2025', 'evidence-for', 'Tax calculation mismatch'], ['Tax Treatment Memo', 'evidence-for', 'Tax calculation mismatch'],
  ['Tax Treatment Memo', 'evidence-for', 'VAT per line'], ['Data Retention Policy', 'evidence-for', 'Audit trail for 7 years'],
  ['Invoice Format Spec', 'evidence-for', 'Legacy export format undocumented'], ['Migration Plan v2', 'evidence-for', 'Phased cut-over by region'],
  ['Statement of Work', 'evidence-for', 'Migrate billing to Stripe'], ['Finance interview notes', 'evidence-for', 'Who approves credit notes?'],
  ['Cut-over runbook', 'mitigates', 'Duplicate invoices on cut-over'], ['Reconciliation report', 'mitigates', 'Duplicate invoices on cut-over'],
  ['Training deck', 'mitigates', 'Key person dependency'], ['Phased cut-over by region', 'mitigates', 'Customer portal downtime'],
  ['Keep Ledgerline read-only until audit', 'mitigates', 'Audit scope creep'],
  ['Keep Ledgerline read-only until audit', 'mitigates', 'Duplicate invoices on cut-over', 'Retracted by the agent', true],
  // questions and answers
  ['Lena Koster', 'can-answer', 'Who approves credit notes?'], ['Tomas Weiss', 'can-answer', 'Does Core retain invoice numbers?'],
  ['Sofia Marchetti', 'can-answer', 'Is the audit window fixed?'], ['Dana Whitcombe', 'can-answer', 'Which tax codes apply to freight surcharges?'],
  ['Which tax codes apply to freight surcharges?', 'blocks', 'Tax calculation mismatch'], ['Is the audit window fixed?', 'blocks', 'Audit sign-off 30 April'],
  // deliverables, owners, requirements
  ['Cut-over runbook', 'supports', 'Cut-over weekend 14 March'], ['Reconciliation report', 'supports', 'Audit sign-off 30 April'],
  ['Hannah Pruitt', 'owns', 'Cut-over runbook'], ['Mark Ellis', 'owns', 'Reconciliation report'], ['Ines Duarte', 'owns', 'Training deck'],
  ['VAT per line', 'constrains', 'Billing Core'], ['Multi-currency invoices', 'constrains', 'Billing Core'], ['Audit trail for 7 years', 'constrains', 'Billing Core'],
  ['Multi-currency invoices', 'requested-by', 'Priya Raman'],
  // meetings
  ['Priya Raman', 'attended', SC], ['Tomas Weiss', 'attended', SC], ['Ines Duarte', 'attended', SC],
  ['Ines Duarte', 'chairs', MR], ['Hannah Pruitt', 'attended', KW], ['Lena Koster', 'attended', KW],
  ['Felix Brandt', 'attended', KW]
]

export interface KnowledgeFixtureTruth {
  /** Author-intended references: `fromId>toId` -> the relation word the author would record, or null. */
  mentions: Map<string, string | null>
  /** `noteId>nodeId` for the incidental note links (the entity is not what the note is about). */
  incidentalNotes: Set<string>
  /** Entity key (`Name` or `Name#kind`) -> id. */
  ids: Record<string, string>
}

const BASE = Date.UTC(2026, 9, 5, 9, 0, 0)
const REF = /\{([^{}]+)\}/g

function sourceFor(spec: Spec, at: number): KnowledgeSource {
  if (spec.by === 'user') return { by: 'user', at }
  const run = spec.run ?? 'run_1'
  return { by: 'agent', runId: run, agentId: `agent_${run}`, role: 'Analyst', at }
}

function build(): { graph: KnowledgeGraph; truth: KnowledgeFixtureTruth } {
  const ids: Record<string, string> = {}
  const nameCount = new Map<string, number>()
  for (const s of SPECS) nameCount.set(s.name, (nameCount.get(s.name) ?? 0) + 1)
  const keyOf = (s: Spec): string => (nameCount.get(s.name)! > 1 ? `${s.name}#${s.kind}` : s.name)
  SPECS.forEach((s, i) => {
    const key = keyOf(s)
    if (ids[key]) throw new Error(`fixture: duplicate key ${key}`)
    ids[key] = `kn_${(i + 1).toString(16).padStart(4, '0')}`
  })
  const resolve = (ref: string): string => {
    const id = ids[ref]
    if (!id) throw new Error(`fixture: unknown entity "${ref}"`)
    return id
  }
  const mentions = new Map<string, string | null>()
  const incidentalNotes = new Set<string>()

  const strip = (text: string, ownerId: string): string =>
    text.replace(REF, (_m, inner: string) => {
      const [surface, entity, relation] = inner.split('|')
      const target = resolve(entity && entity.length > 0 ? entity : surface)
      mentions.set(`${ownerId}>${target}`, relation ? relation : (mentions.get(`${ownerId}>${target}`) ?? null))
      return surface
    })

  const nodes: KnowledgeNode[] = SPECS.map((s, i) => {
    const id = ids[keyOf(s)]
    const at = BASE + i * 3_600_000
    const src = sourceFor(s, at)
    const mk = (text: string, k: number, retired?: boolean): KnowledgeFact => ({
      id: `kf_${(i + 1).toString(16).padStart(3, '0')}${k.toString(16)}`,
      text: strip(text, id),
      source: { ...src, at: at + (k + 1) * 60_000 },
      ...(retired ? { retired: true } : {})
    })
    const facts = [...(s.facts ?? []).map((t, k) => mk(t, k)), ...(s.deadFacts ?? []).map((t, k) => mk(t, 8 + k, true))]
    const noteIds = (s.notes ?? []).map((n) => {
      if (n.endsWith('*')) {
        incidentalNotes.add(`${n.slice(0, -1)}>${id}`)
        return n.slice(0, -1)
      }
      return n
    })
    const node: KnowledgeNode = {
      id,
      kind: s.kind,
      name: s.name,
      facts,
      source: src,
      createdAt: at,
      updatedAt: at + 600_000 + i * 1000
    }
    if (s.aliases) node.aliases = s.aliases
    if (s.summary) node.summary = strip(s.summary, id)
    if (noteIds.length > 0) node.noteIds = noteIds
    if (s.retired) node.retired = true
    return node
  })

  const edges: KnowledgeEdge[] = EDGES.map(([from, relation, to, note, retired], i) => {
    const at = BASE + 86_400_000 + i * 60_000
    const edge: KnowledgeEdge = { id: `ke_${(i + 1).toString(16).padStart(4, '0')}`, from: resolve(from), to: resolve(to), relation, source: { by: 'agent', runId: 'run_3', agentId: 'agent_run_3', role: 'Analyst', at }, createdAt: at }
    if (note) edge.note = note
    if (retired) edge.retired = true
    return edge
  })
  return { graph: { version: 1, nodes, edges, updatedAt: BASE + 2 * 86_400_000 }, truth: { mentions, incidentalNotes, ids } }
}

const BUILT = build()

/** The fixture graph. Treat as read-only; use knowledgeFixture() for a copy a test may change. */
export const KNOWLEDGE_FIXTURE: KnowledgeGraph = BUILT.graph
export const KNOWLEDGE_FIXTURE_TRUTH: KnowledgeFixtureTruth = BUILT.truth

/** A deep copy, so a test can edit nodes without touching the shared fixture. */
export function knowledgeFixture(): KnowledgeGraph {
  return structuredClone(KNOWLEDGE_FIXTURE)
}

/** The id of a fixture entity by name (`Name`, or `Name#kind` for the duplicated names Stripe and Risk review). */
export function fixtureId(key: string): string {
  const id = KNOWLEDGE_FIXTURE_TRUTH.ids[key]
  if (!id) throw new Error(`fixture: unknown entity "${key}"`)
  return id
}

export interface KnowledgeFixtureQuestion {
  question: string
  /** What an agent would type into engagement_knowledge search today. */
  keyword: string
  /** Entities a good answer must surface (names; Stripe means both when it says "Stripe"). */
  expectedNames: string[]
}

export const KNOWLEDGE_FIXTURE_QUESTIONS: KnowledgeFixtureQuestion[] = [
  { question: 'Who has to approve the cut-over, and what could go wrong with the weekend?', keyword: 'cut-over', expectedNames: ['Priya Raman', 'Cut-over weekend 14 March', 'Duplicate invoices on cut-over'] },
  { question: 'What do we know about the tax calculation problem?', keyword: 'tax', expectedNames: ['Tax calculation mismatch', 'Tax Treatment Memo', 'Which tax codes apply to freight surcharges?'] },
  { question: 'Why did we choose Stripe, and who decided?', keyword: 'Stripe', expectedNames: ['Migrate billing to Stripe', 'Priya Raman', 'Steering committee 3'] },
  { question: 'What depends on the legacy export, and what do we not know about it?', keyword: 'legacy export', expectedNames: ['Legacy Export', 'Legacy export format undocumented', 'Invoice Format Spec', 'Atlas'] },
  { question: 'Who in finance can answer our question about credit notes?', keyword: 'credit notes', expectedNames: ['Who approves credit notes?', 'Lena Koster', 'Finance interview notes'] }
]
