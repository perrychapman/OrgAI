/**
 * What the app says about secure storage (cli-standalone.md 5.4, 5.5): the Dashboard notices and the readable form of a
 * slot's "cannot be read here" reason. Pure; no renderer, DOM or React imports. The main-process sentences these map
 * live in src/main/store/vaultTypes.ts (VAULT_MESSAGES) and mention the `orgai` command, which an app-only user may not
 * have; here every one is paired with a way to act in the app (the notice's buttons) or says nothing about a command.
 */
import type { SecretsStatusResult, SecretsSoftDelete } from '../types'

export type SecretNoticeKind = 'removed' | 'vault' | 'legacy-corrupt'

export interface SecretNotice {
  kind: SecretNoticeKind
  tone: 'info' | 'warning'
  title: string
  body: string
  /** Buttons the notice offers, in order. */
  actions: Array<'restore' | 'keep' | 'retry' | 'reset'>
  /** 'removed' only: the soft-deleted keys the buttons act on (key names, never values). */
  keys?: string[]
}

/** The "N saved secrets were removed" sentence (same words as VAULT_MESSAGES.legacyRemovedNotice, a test keeps them equal). */
export function removedSentence(n: number): string {
  return `${n} saved secret${n === 1 ? ' was' : 's were'} removed by an older version of OrgAI.`
}

/** The names of the services behind some keys, for "naming the services where possible". */
export interface KeyNames {
  /** A project's server by id, or undefined when unknown. */
  server?: (projectId: string, serverId: string) => string | undefined
  /** A library entry by id. */
  library?: (entryId: string) => string | undefined
}

/** A service name for a secret key (`connection:litellm:apiKey`, `mcp:<project>:<server>:...`, `mcplib:<entry>:...`), or undefined. */
export function serviceOfKey(key: string, names: KeyNames = {}): string | undefined {
  if (key === 'connection:litellm:apiKey') return 'LiteLLM'
  const parts = key.split(':')
  if (parts[0] === 'mcp' && parts.length >= 3) return names.server?.(parts[1], parts[2])
  if (parts[0] === 'mcplib' && parts.length >= 2) return names.library?.(parts[1])
  return undefined
}

/** Distinct service names for keys, in first-seen order; keys with no known name are counted apart. */
export function servicesOf(keys: string[], names: KeyNames = {}): { named: string[]; unnamed: number } {
  const named: string[] = []
  let unnamed = 0
  for (const k of keys) {
    const n = serviceOfKey(k, names)
    if (n === undefined) unnamed++
    else if (!named.includes(n)) named.push(n)
  }
  return { named, unnamed }
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items.join('')
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** The soft deletes an older OrgAI made (`by: 'legacy'`): the ones the Restore / Keep removed notice is about. */
export function legacySoftDeletes(s: Pick<SecretsStatusResult, 'softDeletes'>): SecretsSoftDelete[] {
  return s.softDeletes.filter((d) => d.by === 'legacy')
}

const VAULT_PROBLEM: Partial<Record<SecretsStatusResult['state'], (reason?: string) => { title: string; body: string }>> = {
  locked: (reason) => ({
    title: 'OrgAI could not unlock its secure storage',
    body: `${reason ? `${reason.replace(/^Secure storage is locked: /, '').replace(/[.\s]+$/, '')}. ` : ''}Saved keys and tokens cannot be read until it opens. Unlock your key store (for example sign in to your computer), then try again.`
  }),
  'missing-key': () => ({
    title: "The key to OrgAI's secure storage is not available",
    body: 'This computer account cannot reach the key that opens secure storage, so saved keys and tokens cannot be read. Sign in to the account that created it, or start over and enter your keys again.'
  }),
  'key-mismatch': () => ({
    title: "OrgAI's secure storage does not open with its key",
    body: 'The key does not match the vault, or it is damaged, so saved keys and tokens cannot be read. Restore the matching key file, or start over and enter your keys again.'
  }),
  corrupt: () => ({
    title: "OrgAI's secure storage is damaged",
    body: "Saved keys and tokens in secure storage cannot be read. Start over to move it aside; OrgAI then uses the older copies it kept, which may be outdated. Enter any key that is missing again."
  })
}

/** What "Start over" gives up, shown in its confirmation (same meaning as VAULT_MESSAGES.resetWarning). */
export const START_OVER_WARNING =
  "Starting over moves secure storage aside. Secrets saved only through the orgai command are lost; the OrgAI app's older copies, which may be outdated, are used instead."

/** The notices for a status, most urgent first. Empty when there is nothing to say. */
export function secretNotices(s: SecretsStatusResult, names: KeyNames = {}): SecretNotice[] {
  const out: SecretNotice[] = []
  const problem = VAULT_PROBLEM[s.state]
  if (problem) {
    const p = problem(s.reason)
    out.push({ kind: 'vault', tone: 'warning', title: p.title, body: p.body, actions: s.state === 'corrupt' ? ['reset'] : ['retry', 'reset'] })
  }
  if (s.legacyFile === 'corrupt') {
    out.push({
      kind: 'legacy-corrupt',
      tone: 'warning',
      title: "OrgAI's older secrets file is damaged",
      body: 'The file secrets.json cannot be read, so the keys and tokens saved in it are not available, and OrgAI will not change it. Keys saved in secure storage still work. Enter any key that is missing again in Connections and Connectors, or start over to move the damaged file aside.',
      actions: ['reset']
    })
  }
  const removed = legacySoftDeletes(s)
  if (removed.length) {
    const { named, unnamed } = servicesOf(removed.map((d) => d.key), names)
    const who = named.length ? ` ${listWords(unnamed ? [...named, `${unnamed} more`] : named)}.` : ''
    out.push({
      kind: 'removed',
      tone: 'info',
      title: removedSentence(removed.length),
      body: `${who ? `Affected:${who} ` : ''}Restore puts them back. Keep removed leaves them gone for good.`.trim(),
      actions: ['restore', 'keep'],
      keys: removed.map((d) => d.key)
    })
  }
  return out
}


/**
 * A slot's "cannot be read here" reason (McpServerInfo.unreadableSecrets, a connection's status detail) in the app's
 * words: the known vault sentences get the way to act in the app (the Dashboard notice), and any leftover mention of an
 * `orgai` command is dropped. Text that mentions no vault problem is returned as it is.
 */
export function appSecretReason(reason: string): string {
  // Command mentions first (a parenthetical that only points at a command goes; a bare command span reads "a terminal command").
  const t = reason
    .trim()
    .replace(/,? or check with `orgai[^`]*`/g, '')
    .replace(/ \([^()]*`orgai[^`]*`[^()]*\)/g, '')
    .replace(/open the OrgAI app once, or unlock secure storage and try again\./, 'unlock secure storage (the Dashboard notice has a Try again button) and try again.')
  // A known sentence may follow a prefix ("The LiteLLM API key cannot be read here: ..."): the prefix stays.
  const at = (re: RegExp): number => t.search(re)
  let i = at(/Secure storage is locked/)
  if (i >= 0) return `${t.replace(/[.\s]+$/, '')}. Open the Dashboard notice and choose Try again.`
  i = at(/The key for this secure storage is not available|The key does not match this secure storage|Secure storage is damaged/)
  if (i >= 0) return `${t.slice(0, i)}OrgAI's secure storage cannot be opened. The Dashboard notice says what to do.`
  i = at(/Saved by the OrgAI app and not yet shared/)
  if (i >= 0) return `${t.slice(0, i)}Saved by OrgAI earlier and being moved into secure storage. Restart OrgAI if this stays.`
  i = at(/This saved secret is damaged/)
  if (i >= 0) return `${t.slice(0, i)}This saved secret is damaged and cannot be read. Enter it again.`
  i = at(/secrets file \(secrets\.json\) is damaged/)
  if (i >= 0) return `${t.slice(0, i)}OrgAI's secrets file (secrets.json) is damaged, so OrgAI does not change it. The Dashboard notice has a Start over button.`
  i = at(/Saved by the OrgAI app: open the app once/)
  if (i >= 0) return `${t.slice(0, i)}Saved by OrgAI earlier. Restart OrgAI and try again.`
  return t.replace(/`orgai[^`]*`/g, 'a terminal command')
}
