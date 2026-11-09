import { describe, expect, it } from 'vitest'
import { appSecretReason, removedSentence } from '../../shared/view/secretNotices'
import { DPAPI_ADDTYPE_REASON, DPAPI_CLM_REASON } from './custodians/dpapi'
import { cliWording } from './custodians'
import { KEY_FILE_HINT } from './custodians/common'
import { keyFileExistsReason, keyFileNotConfigured } from './custodians/keyFile'
import { NO_SESSION_BUS_REASON, SECRET_TOOL_MISSING_REASON } from './custodians/secretService'
import { LEGACY_CORRUPT_MESSAGE, VAULT_RECOVERY_MESSAGE, keyFileSchemeConflict, noCustodianMessage } from './secrets'
import { VAULT_MESSAGES } from './vaultTypes'

// The app's words (src/shared/view/secretNotices.ts) must follow the main-process sentences they stand in for.
describe('secret notice wording', () => {
  it('the removed sentence is the one the CLI and doctor print', () => {
    for (const n of [1, 2, 7]) expect(removedSentence(n)).toBe(VAULT_MESSAGES.legacyRemovedNotice(n))
  })

  it('no desktop vault sentence names a terminal command, and the app text passes them through', () => {
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
    for (const s of sentences) {
      expect(s, s).not.toMatch(/`|orgai|Terminal/)
      expect(appSecretReason(s), s).not.toMatch(/`|orgai (secrets|command)/)
      if (!s.includes('Secure storage is locked')) expect(appSecretReason(s)).toBe(s)
    }
    expect(appSecretReason(VAULT_MESSAGES.locked('The keychain is locked.'))).toContain('Try again')
    expect(appSecretReason('Something else went wrong.')).toBe('Something else went wrong.')
  })

  it('desktop custodian reasons, locked in the app, name no orgai command; the CLI keeps its own', () => {
    const reasons = [
      `The macOS keychain tool failed (exit 1); ${KEY_FILE_HINT}.`,
      DPAPI_ADDTYPE_REASON,
      DPAPI_CLM_REASON,
      SECRET_TOOL_MISSING_REASON,
      NO_SESSION_BUS_REASON,
      keyFileNotConfigured('desktop'),
      keyFileExistsReason('/k/app.key'),
      noCustodianMessage('desktop'),
      keyFileSchemeConflict('keychain', 'desktop')
    ]
    for (const r of reasons) {
      const text = appSecretReason(VAULT_MESSAGES.locked(r))
      expect(text, r).not.toMatch(/orgai (secrets|command)|`/)
      expect(text).toContain('Try again')
    }
    expect(cliWording(`x ${KEY_FILE_HINT}.`)).toContain('ORGAI_CLI_VAULT_KEY_FILE to a key file (see `orgai secrets init --key-file`)')
    expect(cliWording(keyFileExistsReason('/k/app.key'))).toContain('`orgai secrets init --key-file "/k/app.key" --import`')
  })
})
