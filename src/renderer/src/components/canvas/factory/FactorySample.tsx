// The settings sample and thumbnail of the Factory Floor (docs/design/factory-floor.md section 6.6): never a second
// WebGL context. Until the rendered PNGs exist (slice 6) it is the floor plan of a fixed five-agent sample team,
// inert: one image to assistive technology, no buttons.
import type { ReactElement } from 'react'
import { Activity, Check, CircleAlert, Pause, type LucideIcon } from 'lucide-react'
import { Icon } from '../../ui/Icon'
import '../../../styles/factory.css'

interface SampleWorker {
  id: string
  name: string
  word: 'Running' | 'Needs you' | 'Idle' | 'Finished'
  lamp: 'running' | 'needs-you' | 'off'
  booth?: boolean
}

/** Section 3.3's five-agent example: the root, leads A and B, one report under each. */
const SAMPLE: readonly SampleWorker[] = [
  { id: 'root', name: 'Orchestrator', word: 'Running', lamp: 'running', booth: true },
  { id: 'a', name: 'Architect', word: 'Running', lamp: 'running' },
  { id: 'b', name: 'Reviewer', word: 'Idle', lamp: 'off' },
  { id: 'a1', name: 'Developer', word: 'Needs you', lamp: 'needs-you' },
  { id: 'b1', name: 'Tester', word: 'Finished', lamp: 'off' }
]

const ICON: Record<SampleWorker['word'], LucideIcon> = { Running: Activity, 'Needs you': CircleAlert, Idle: Pause, Finished: Check }

function SampleTile({ w }: { w: SampleWorker }): ReactElement {
  return (
    <div className="factory-worker" data-lamp={w.lamp} data-kind={w.booth ? 'booth' : 'bench'}>
      <span className="factory-worker-name">{w.name}</span>
      {w.booth && <span className="factory-worker-kind">Control booth</span>}
      <span className="factory-worker-status">
        <Icon icon={ICON[w.word]} size="xs" />
        {w.word}
      </span>
    </div>
  )
}

export function FactorySample(): ReactElement {
  const [root, ...rest] = SAMPLE
  return (
    <div className="factory-sample" role="img" aria-label="Static sample factory floor" data-testid="factory-sample">
      <div className="factory-mirror" data-renderer="floor-plan" aria-hidden="true">
        <div className="factory-gantry">
          <SampleTile w={root} />
        </div>
        <div className="factory-tiles">
          {rest.map((w) => (
            <SampleTile key={w.id} w={w} />
          ))}
        </div>
      </div>
    </div>
  )
}
