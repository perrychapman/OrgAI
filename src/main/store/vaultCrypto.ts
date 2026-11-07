/**
 * The secret vault's cryptography (docs/design/cli-standalone.md 5.2): AES-256-GCM per entry with a fresh 96-bit IV per
 * write and AAD `orgai.vault/1\0<vaultId>\0<key>`, the `check` record, and sha256 hex of secrets.json value strings.
 * node:crypto only; Electron-free; relative imports only. Never logs and never puts a value or the data key in an error.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  VAULT_CHECK_PLAINTEXT,
  VAULT_DEK_BYTES,
  VAULT_ID_BYTES,
  VAULT_IV_BYTES,
  VAULT_TAG_BYTES,
  vaultCheckAad,
  vaultEntryAad,
  type VaultCipherText
} from './vaultTypes'

/** Thrown when a ciphertext does not authenticate (wrong key, damaged entry, wrong AAD). Carries no data. */
export class VaultDecryptError extends Error {
  constructor() {
    super('A vault record did not authenticate.')
    this.name = 'VaultDecryptError'
  }
}

/** sha256 hex of a string's UTF-8 bytes (the legacy baseline B and H of 5.5). */
export function sha256Hex(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

/** A new vault id: VAULT_ID_BYTES random bytes, hex. */
export function newVaultId(): string {
  return randomBytes(VAULT_ID_BYTES).toString('hex')
}

/** True for a data key of the right length. */
export function isDek(dek: unknown): dek is Buffer {
  return Buffer.isBuffer(dek) && dek.length === VAULT_DEK_BYTES
}

function seal(dek: Buffer, aad: string, plain: string): VaultCipherText {
  const iv = randomBytes(VAULT_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', dek, iv, { authTagLength: VAULT_TAG_BYTES })
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
}

function open(dek: Buffer, aad: string, c: VaultCipherText): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(c.iv, 'base64'), { authTagLength: VAULT_TAG_BYTES })
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(Buffer.from(c.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(c.ct, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new VaultDecryptError()
  }
}

/** Encrypt one secret for `key` of vault `vaultId`. */
export function encryptEntry(dek: Buffer, vaultId: string, key: string, plain: string): VaultCipherText {
  return seal(dek, vaultEntryAad(vaultId, key), plain)
}

/** Decrypt one secret; throws VaultDecryptError when it does not authenticate. */
export function decryptEntry(dek: Buffer, vaultId: string, key: string, c: VaultCipherText): string {
  return open(dek, vaultEntryAad(vaultId, key), c)
}

/** The `check` record of a new vault. */
export function makeCheck(dek: Buffer, vaultId: string): VaultCipherText {
  return seal(dek, vaultCheckAad(vaultId), VAULT_CHECK_PLAINTEXT)
}

/** True when `dek` opens this vault's check record (5.2): false means key-mismatch (wrong key or damaged record). */
export function checkMatches(dek: Buffer, vaultId: string, check: VaultCipherText): boolean {
  if (!isDek(dek)) return false
  try {
    const plain = Buffer.from(open(dek, vaultCheckAad(vaultId), check), 'utf8')
    const want = Buffer.from(VAULT_CHECK_PLAINTEXT, 'utf8')
    return plain.length === want.length && timingSafeEqual(plain, want)
  } catch {
    return false
  }
}

/** Overwrite a data key in memory once it is no longer used. */
export function zeroize(dek: Buffer | undefined): void {
  try {
    dek?.fill(0)
  } catch {
    // a frozen or detached buffer: nothing to do
  }
}
