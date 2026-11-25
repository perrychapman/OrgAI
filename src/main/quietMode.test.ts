import { describe, expect, it } from 'vitest'
import { parseQuiet } from './quietMode'

describe('parseQuiet', () => {
  it('turns on for the exact value 1 with a non-empty ORGAI_DATA_DIR only', () => {
    expect(parseQuiet('1', '/tmp/data')).toBe(true)
    expect(parseQuiet('1')).toBe(false)
    expect(parseQuiet('1', '')).toBe(false)
    for (const v of [undefined, '', '0', 'true', ' 1', '1 ', '11', 'yes']) expect(parseQuiet(v, '/tmp/data')).toBe(false)
  })
})
