import { describe, expect, it } from 'vitest'
import { StreamingSecretRedactor } from './streamRedactor'

describe('StreamingSecretRedactor', () => {
  it('holds a secret split across chunks and emits only its replacement', () => {
    const redactor = new StreamingSecretRedactor('***')
    const secret = 'synthetic-secret-value-123456'
    const first = redactor.push(`before ${secret.slice(0, 12)}`, [secret])
    const second = redactor.push(`${secret.slice(12)} after`, [secret])

    expect(first).toBe('before ')
    expect(`${first}${second}`).toBe('before *** after')
    expect(`${first}${second}`).not.toContain(secret.slice(0, 12))
    expect(`${first}${second}`).not.toContain(secret.slice(12))
  })

  it('keeps ordinary multiline text and bounds an incomplete trailing secret prefix', () => {
    const redactor = new StreamingSecretRedactor('***')
    const secret = 'synthetic-secret-value-123456'
    const first = redactor.push(`line one\nline two\n${secret.slice(0, 8)}`, [secret])
    const last = redactor.push('', [secret], true)

    expect(first).toBe('line one\nline two\n')
    expect(last).toBe('***')
  })

  it('remembers secrets that were present in earlier updates', () => {
    const redactor = new StreamingSecretRedactor('***')
    const secret = 'synthetic-secret-value-123456'

    expect(redactor.push(secret.slice(0, 10), [secret])).toBe('')
    expect(redactor.push(secret.slice(10), [], true)).toBe('***')
  })

  it('redacts the union of self-overlapping occurrences across chunks', () => {
    const redactor = new StreamingSecretRedactor('***')
    const secret = 'abca'
    const first = redactor.push(secret, [secret])
    const second = redactor.push(secret.slice(1), [secret], true)

    expect(`${first}${second}`).toBe('***')
    expect(`${first}${second}`).not.toContain('bca')
  })

  it('redacts overlapping occurrences from two different secrets', () => {
    const redactor = new StreamingSecretRedactor('***')
    const firstSecret = 'abcde'
    const secondSecret = 'defgh'
    const first = redactor.push(firstSecret, [firstSecret, secondSecret])
    const second = redactor.push('fgh', [], true)

    expect(`${first}${second}`).toBe('***')
    expect(`${first}${second}`).not.toContain('defgh')
  })
})
