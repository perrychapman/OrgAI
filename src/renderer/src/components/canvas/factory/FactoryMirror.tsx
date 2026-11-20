// The Factory Floor's DOM mirror (docs/design/factory-floor.md sections 7.1 and 7.6): one native button per worker in
// reading order. It is the accessible layer over the 3D view and, made visible, the floor plan.
// Slice 1 simplification: no layout positions exist yet (layout.ts is slice 2), so the buttons flow as tiles (the
// booth on the gantry band, then the others in creation order); arrow-key navigation and the single Tab stop come
// with slice 2's navigation module.
import type { KeyboardEvent, ReactElement, Ref } from 'react'
import { Activity, Check, CircleAlert, OctagonX, Pause, Square, type LucideIcon } from 'lucide-react'
import { Icon } from '../../ui/Icon'
import type { FactoryAgentInput, Lamp, StationKind } from '../../../lib/factory/types'

export interface MirrorEntry {
  id: string
  name: string
  kind: StationKind
  state: FactoryAgentInput['state']
  lamp: Lamp
  word: FactoryAgentInput['statusWord']
}

const RUNNING_STATES = new Set(['starting', 'thinking', 'tool', 'delegating'])

/** The current session's root: no parent, earliest start, then smallest id (spec section 3.2 step 1). */
export function floorRoot(agents: readonly FactoryAgentInput[]): FactoryAgentInput | null {
  let root: FactoryAgentInput | null = null
  for (const a of agents) {
    if (a.session !== 'current' || a.parentId !== null) continue
    if (!root || a.startedAt < root.startedAt || (a.startedAt === root.startedAt && a.id < root.id)) root = a
  }
  return root
}

/** Slice 1 lamp rule (slice 3's model.ts owns it later): failed, then needs you, then running, else off. */
function lampOf(a: FactoryAgentInput, needsYou: ReadonlySet<string>): Lamp {
  if (a.state === 'role') return 'off'
  if (a.state === 'error') return 'failed'
  if (a.state === 'waiting' || needsYou.has(a.id)) return 'needs-you'
  return RUNNING_STATES.has(a.state) ? 'running' : 'off'
}

/** Current-session workers in reading order: booth first, then by (startedAt, id). */
export function mirrorEntries(agents: readonly FactoryAgentInput[], needsYouIds: readonly string[] = []): MirrorEntry[] {
  const current = agents.filter((a) => a.session === 'current')
  const root = floorRoot(current)
  const leads = new Set(current.map((a) => a.parentId).filter((p): p is string => !!p))
  const needsYou = new Set(needsYouIds)
  const rest = current.filter((a) => a !== root).sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return (root ? [root, ...rest] : rest).map((a) => {
    const lamp = lampOf(a, needsYou)
    const word = lamp === 'needs-you' && a.statusWord !== 'Role' ? 'Needs you' : a.statusWord
    return { id: a.id, name: a.name, kind: a === root ? 'booth' : leads.has(a.id) ? 'lead' : 'bench', state: a.state, lamp, word }
  })
}

const WORD_ICON: Partial<Record<MirrorEntry['word'], LucideIcon>> = {
  Running: Activity,
  'Needs you': CircleAlert,
  Failed: OctagonX,
  Idle: Pause,
  Paused: Pause,
  Finished: Check,
  Stopped: Square
}

function accessibleName(e: MirrorEntry, mode: 'live' | 'team'): string {
  if (mode === 'team') return `${e.name}, role`
  return e.kind === 'booth' ? `${e.name}, control booth, ${e.word}` : `${e.name}, ${e.word}`
}

export interface FactoryMirrorProps {
  mode: 'live' | 'team'
  entries: readonly MirrorEntry[]
  renderer: 'webgl2' | 'floor-plan'
  selectedId?: string
  onSelect(id: string): void
  onRemove?(id: string): void
  mirrorRef?: Ref<HTMLDivElement>
}

export function FactoryMirror({ mode, entries, renderer, selectedId, onSelect, onRemove, mirrorRef }: FactoryMirrorProps): ReactElement {
  const n = entries.length
  const label = mode === 'team' ? `Factory floor, ${n} ${n === 1 ? 'role' : 'roles'}` : `Factory floor, ${n} ${n === 1 ? 'worker' : 'workers'}`
  const booth = entries.find((e) => e.kind === 'booth')
  const floor = entries.filter((e) => e.kind !== 'booth')

  const onKeyDown = (id: string) => (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (mode === 'team' && onRemove && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault()
      onRemove(id)
    }
  }

  const tile = (e: MirrorEntry): ReactElement => {
    const glyph = mode === 'live' ? WORD_ICON[e.word] : undefined
    return (
      <button
        key={e.id}
        type="button"
        className="factory-worker"
        data-testid="factory-worker"
        data-factory-worker-id={e.id}
        data-state={e.state}
        data-lamp={e.lamp}
        data-kind={e.kind}
        aria-label={accessibleName(e, mode)}
        aria-current={selectedId === e.id ? 'true' : undefined}
        onClick={() => onSelect(e.id)}
        onKeyDown={onKeyDown(e.id)}
      >
        <span className="factory-worker-name">{e.name}</span>
        {e.kind === 'booth' && <span className="factory-worker-kind">Control booth</span>}
        {mode === 'live' && (
          <span className="factory-worker-status">
            {glyph && <Icon icon={glyph} size="xs" />}
            {e.word}
          </span>
        )}
      </button>
    )
  }

  return (
    <div
      ref={mirrorRef}
      className="factory-mirror"
      data-renderer={renderer}
      role="group"
      aria-label={label}
      data-testid="factory-floor"
    >
      {booth && <div className="factory-gantry">{tile(booth)}</div>}
      {floor.length > 0 && <div className="factory-tiles">{floor.map(tile)}</div>}
    </div>
  )
}
