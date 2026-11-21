import type { ReactElement } from 'react'

/** The terms of docs/design/usage-app.md 12.2, verbatim. Info buttons elsewhere on the page use these as their titles. */
export const USAGE_DEFINITIONS: readonly { term: string; text: string }[] = [
  {
    term: 'Estimated cost',
    text: 'What the provider reported, or what OrgAI computed from model prices. It is an estimate, not an invoice. A "+" means at least this much, because some models have no known price. "unknown" means tokens were used but no price is known.'
  },
  {
    term: 'Cache hit',
    text: 'The share of input tokens the provider read from its prompt cache instead of processing again. Higher is cheaper. "Not reported" means the connection does not say.'
  },
  { term: 'Cost per run', text: 'The median estimated cost of a run in this view. The mean is in the tooltip.' },
  { term: 'Tokens per turn', text: 'Tokens used divided by the number of turns agents took.' },
  { term: 'Retries', text: 'Times a failed request was sent again. Counted per 100 turns.' },
  { term: 'No result', text: 'Tokens spent by agents that finished without giving a report back. The root agent is never counted here.' },
  { term: 'Nudges', text: 'Times OrgAI asked an agent to keep going after it stopped before the work was done.' },
  { term: 'Wall time', text: 'The clock time a run was open, from start to end, including time waiting on you.' },
  { term: 'Waiting on you', text: 'Time a run was paused on a decision or answer.' },
  { term: 'Idle', text: 'Time a run was open with nothing running and nothing waiting on you.' },
  { term: 'Limit hold', text: 'Time a run was paused because the plan or account limit was reached.' },
  { term: 'Team vs Ask', text: 'Team runs use the whole org chart; Ask runs use one assistant. Costs are compared per run.' },
  { term: 'Truncated', text: 'The newest 2,000 runs are loaded. Older ones in this period are left out.' },
  { term: 'Legacy', text: 'Recorded before usage tracking; figures are approximate.' }
]

/** Footer disclosure "What these terms mean" (usage-definitions). */
export default function UsageDefinitions(): ReactElement {
  return (
    <details className="usage-definitions" data-testid="usage-definitions">
      <summary>What these terms mean</summary>
      <dl className="usage-definitions-list">
        {USAGE_DEFINITIONS.map((d) => (
          <div key={d.term}>
            <dt>{d.term}</dt>
            <dd>{d.text}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}
