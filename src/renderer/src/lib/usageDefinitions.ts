/**
 * The definitions the Usage page carries (docs/design/usage-app.md 12.2; dashboard-usage-redesign usage.md: the closed
 * Definitions section is retired, each definition sits on the label it defines). Only terms that have a label on the
 * page are kept: the KPI tiles (Estimated cost, Wall time), the four Efficiency measures (their text lives with the
 * measure), and the reasons in Runs worth a look (Cache hit, Retries, Nudges, Idle, No result, Not priced). The
 * truncation banner and the legacy note say their own meaning in full, so they carry no second definition.
 */
export const USAGE_DEFINITIONS: readonly { term: string; text: string }[] = [
  {
    term: 'Estimated cost',
    text: 'What the provider reported, or what OrgAI computed from model prices. It is an estimate, not an invoice. A "+" means at least this much, because some runs are not priced. "Not priced" means tokens were used but no price is known.'
  },
  {
    term: 'Cache hit',
    text: 'The share of input tokens the provider read from its prompt cache instead of processing again. Higher is cheaper. "Not reported" means the connection does not say.'
  },
  { term: 'Cost per run', text: 'The median estimated cost of a run in this view: half of the runs cost less. Runs that are not priced are left out.' },
  { term: 'Retries', text: 'Times a failed request was sent again. Counted per 100 turns.' },
  { term: 'No result', text: 'Tokens spent by agents that finished without giving a report back. The root agent is never counted here.' },
  { term: 'Nudges', text: 'Times OrgAI asked an agent to keep going after it stopped before the work was done.' },
  { term: 'Wall time', text: 'The clock time a run was open, from start to end, including time waiting on you.' },
  { term: 'Idle', text: 'Time a run was open with nothing running and nothing waiting on you.' },
  { term: 'Not priced', text: 'Tokens were used but OrgAI knows no price for the model, so the cost cannot be shown. It is never counted as $0.' }
]

export type UsageTerm = (typeof USAGE_DEFINITIONS)[number]['term']

/**
 * The definition of a term, for the tooltip on the label it defines (dashboard-usage-redesign usage.md: the closed
 * Definitions section is retired; each definition moves to its label). Empty for an unknown term.
 */
export function definitionOf(term: string): string {
  return USAGE_DEFINITIONS.find((d) => d.term === term)?.text ?? ''
}

/** The defined word inside a "Runs worth a look" reason, and the term whose definition it carries. */
const REASON_TERMS: Record<string, { match: string; term: string }[]> = {
  'no-result': [{ match: 'no result', term: 'No result' }],
  retries: [{ match: 'Retried', term: 'Retries' }],
  nudges: [{ match: 'Auto-continued', term: 'Nudges' }],
  idle: [{ match: 'Idle', term: 'Idle' }],
  cache: [{ match: 'Cache hit', term: 'Cache hit' }],
  cost: [{ match: 'Not priced', term: 'Not priced' }]
}

export interface ReasonParts {
  before: string
  term: string
  after: string
  definition: string
}

/**
 * A reason's text split around the word that carries a definition ("Retried" in "Retried 3 times"); null when the text
 * has no defined word (for example "The run failed"), so the reason renders as plain text.
 */
export function reasonParts(key: string, text: string): ReasonParts | null {
  for (const c of REASON_TERMS[key] ?? []) {
    const at = text.indexOf(c.match)
    const definition = definitionOf(c.term)
    if (at >= 0 && definition) return { before: text.slice(0, at), term: c.match, after: text.slice(at + c.match.length), definition }
  }
  return null
}
