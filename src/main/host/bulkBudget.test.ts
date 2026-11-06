import { describe, expect, it } from 'vitest'
import { RPC_BULK_MEMORY_BUDGET_BYTES } from '../../shared/types'
import { BulkBudget } from './bulkBudget'

describe('BulkBudget', () => {
  it('defaults to RPC_BULK_MEMORY_BUDGET_BYTES', () => {
    expect(new BulkBudget().totalBytes).toBe(RPC_BULK_MEMORY_BUDGET_BYTES)
  })

  it('reserves, grows and releases (idempotent)', () => {
    const b = new BulkBudget(100)
    const r = b.reserve(40)
    expect(r?.bytes).toBe(40)
    expect(b.used).toBe(40)
    expect(r?.grow(70)).toBe(true)
    expect(b.used).toBe(70)
    expect(r?.grow(50)).toBe(true) // never shrinks
    expect(b.used).toBe(70)
    r?.release()
    r?.release()
    expect(b.used).toBe(0)
    expect(r?.bytes).toBe(0)
    expect(r?.grow(10)).toBe(false)
  })

  it('refuses what it cannot cover', () => {
    const b = new BulkBudget(100)
    const a = b.reserve(60)
    expect(b.reserve(50)).toBeNull()
    const c = b.reserve(40)
    expect(c).not.toBeNull()
    expect(a?.grow(61)).toBe(false)
    expect(b.used).toBe(100)
    c?.release()
    expect(a?.grow(100)).toBe(true)
    expect(b.available).toBe(0)
  })
})
