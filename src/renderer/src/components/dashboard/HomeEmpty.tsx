import type { ReactElement } from 'react'
import { CircleCheck, Hourglass } from 'lucide-react'
import { EmptyState } from '../ui/EmptyState'

/**
 * The quiet state of Home's two work columns (Empty board: "Nothing is waiting on you" and its twin). Drawn through the
 * EmptyState primitive in a glass panel so the columns keep their places; not a `dash-section`, so the rules that say an empty
 * section is not in the DOM (and the Customise lists) are unaffected.
 */
export function HomeEmpty({ kind }: { kind: 'now' | 'needs' }): ReactElement {
  return kind === 'now' ? (
    <div className="home-empty glass" data-testid="home-empty-now" data-kind="now">
      <EmptyState compact icon={Hourglass} title="Nothing is running" description="Give your team a task above. Runs show up here while they work." />
    </div>
  ) : (
    <div className="home-empty glass" data-testid="home-empty-needs" data-kind="needs">
      <EmptyState compact icon={CircleCheck} title="Nothing is waiting on you" description="Questions and permission requests from your teams show up here." />
    </div>
  )
}
