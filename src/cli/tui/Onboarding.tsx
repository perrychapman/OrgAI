/**
 * Folder onboarding (W4-T5): shown when the folder is not a project. Option [2] uses projects:create plus setup:start
 * (ahead of Wave 5 `orgai init`). Stub until W4-T5 lands.
 */
import { Text } from 'ink'
import type { ProjectPathCheck } from '../../shared/types'
import type { AgentImportSource } from './types'

export type OnboardingChoice =
  | { kind: 'quick'; allowEdits: boolean }
  | { kind: 'architect' }
  | { kind: 'default' }
  | { kind: 'import'; sources: AgentImportSource[] }

export function Onboarding(props: {
  folder: string
  check?: ProjectPathCheck
  onChoose(choice: OnboardingChoice): void
  onCancel(): void
}) {
  void props
  return <Text>Onboarding (not implemented, Wave 4)</Text>
}
