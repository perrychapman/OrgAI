import { describe, expect, it } from 'vitest'
import { appSecretReason, removedSentence } from '../../shared/view/secretNotices'
import { LEGACY_CORRUPT_MESSAGE, VAULT_RECOVERY_MESSAGE } from './secrets'
import { VAULT_MESSAGES } from './vaultTypes'

// The app's words (src/shared/view/secretNotices.ts) must follow the main-process sentences they stand in for.
describe('secret notice wording', () => {
  it('the removed sentence is the one the CLI and doctor print', () => {
    for (const n of [1, 2, 7]) expect(removedSentence(n)).toBe(VAULT_MESSAGES.legacyRemovedNotice(n))
  })

  it('maps every main-process vault sentence so no app text names a terminal command', () => {
    const sentences = [
      VAULT_MESSAGES.pendingLegacy,
      VAULT_MESSAGES.locked('The keychain is locked.'),
      VAULT_MESSAGES.missingKey,
      VAULT_MESSAGES.keyMismatch,
      VAULT_MESSAGES.corrupt,
      VAULT_MESSAGES.unreadableEntry,
      VAULT_MESSAGES.clearRefusedCorrupt,
      VAULT_MESSAGES.clearRefusedLegacyOnly
    ]
    sentences.push(
      VAULT_MESSAGES.notDurable,
      LEGACY_CORRUPT_MESSAGE,
      VAULT_RECOVERY_MESSAGE,
      VAULT_MESSAGES.moveRefused('TOKEN', 'GitHub', 'Secure storage is locked: x'),
      VAULT_MESSAGES.moveRefused('TOKEN', 'GitHub', VAULT_MESSAGES.pendingLegacy)
    )
    for (const s of sentences) expect(appSecretReason(s), s).not.toMatch(/`|orgai (secrets|command)/)
    expect(appSecretReason(VAULT_MESSAGES.locked('The keychain is locked.'))).toContain('Try again')
    expect(appSecretReason('Something else went wrong.')).toBe('Something else went wrong.')
  })
})
