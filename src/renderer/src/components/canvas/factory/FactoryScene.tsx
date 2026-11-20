import type { ReactElement, Ref } from 'react'
import type { AgentMessage, RunPlan, RunStatus } from '@shared/types'
import type { FactoryAgentInput } from '../../../lib/factory/types'

export interface FactorySceneHandle {
  zoomIn(): void
  zoomOut(): void
  fit(): void
  /** Focuses the worker's button and pans it into view; false when the id is not on the floor. */
  focusWorker(id: string): boolean
}

export interface FactorySceneProps {
  mode: 'live' | 'team'
  agents: readonly FactoryAgentInput[]
  messages: readonly AgentMessage[]
  plan?: RunPlan | null
  runStatus?: RunStatus
  /** Agent ids named by open decisions (permission, question, rules, merge review); proposals count as the root. */
  needsYouIds?: readonly string[]
  runId?: string
  /** Team mode: memory key. */
  projectId?: string
  selectedId?: string
  onSelect(id: string): void
  onRemove?(id: string): void
  onOpenPlan?(): void
  /** Fallback banners' "Use Graph". */
  onUseGraph(): void
  controlRef?: Ref<FactorySceneHandle>
}

/** Slice 1 stub: the real scene lands in the same file. */
export function FactoryScene(props: FactorySceneProps): ReactElement {
  return <div data-testid="factory-scene" className="factory-scene" data-mode={props.mode} />
}
