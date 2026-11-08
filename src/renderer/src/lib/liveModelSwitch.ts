import type { ConnectionId, ProviderModel } from '@shared/types'
import { connectionLabel } from './connectionLabel'

/** Show the concrete selection, even when the catalog no longer contains it. */
export function liveModelLabel(model: string, connection: ConnectionId): string {
  return `${model} via ${connectionLabel(connection)}`
}

/** The picker stores concrete ids; do not collapse identical ids across connections. */
export function liveModelOptions(models: readonly ProviderModel[], connection: ConnectionId): { value: string; label: string }[] {
  const seen = new Set<string>()
  return models.filter((model) => model.connection === connection && !seen.has(model.id) && !!seen.add(model.id))
    .map((model) => ({ value: model.id, label: model.label && model.label !== model.id ? `${model.label} (${model.id})` : model.id }))
}
