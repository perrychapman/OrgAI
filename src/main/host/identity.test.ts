import { describe, expect, it } from 'vitest'
import { HOST_INSTANCE_ID_RE, currentHostInstanceId, newHostInstanceId, setHostInstanceId } from './identity'

describe('host instance id', () => {
  it('is 12 lowercase hex chars and fresh each time', () => {
    const a = newHostInstanceId()
    expect(a).toMatch(/^[0-9a-f]{12}$/)
    expect(HOST_INSTANCE_ID_RE.test(a)).toBe(true)
    expect(newHostInstanceId()).not.toBe(a)
  })

  it('currentHostInstanceId is stable across calls', () => {
    const a = currentHostInstanceId()
    expect(a).toMatch(/^[0-9a-f]{12}$/)
    expect(currentHostInstanceId()).toBe(a)
  })

  it('setHostInstanceId pins a valid id and refuses others', () => {
    setHostInstanceId('0123456789ab')
    expect(currentHostInstanceId()).toBe('0123456789ab')
    for (const bad of ['', '0123456789AB', '0123456789a', '0123456789abc', 'g123456789ab', ' 123456789ab', 42 as unknown as string]) {
      expect(() => setHostInstanceId(bad)).toThrow()
    }
    expect(currentHostInstanceId()).toBe('0123456789ab')
  })
})
