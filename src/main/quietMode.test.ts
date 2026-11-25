import { describe, expect, it } from 'vitest'
import { parseQuiet } from './quietMode'

describe('parseQuiet', () => {
  it('turns on for the exact value 1 only', () => {
    expect(parseQuiet('1')).toBe(true)
    for (const v of [undefined, '', '0', 'true', ' 1', '1 ', '11', 'yes']) expect(parseQuiet(v)).toBe(false)
  })
})
