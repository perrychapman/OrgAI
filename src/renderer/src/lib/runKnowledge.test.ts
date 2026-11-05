import { describe, expect, it } from 'vitest'
import { addRecalled, cleanRecalledEvent, givenText, knowledgeUsageRows, popStep, pushStep, RECALLED_EVENTS_MAX, recalledRows, resultsStatus } from './runKnowledge'
import { humanizeToolResult, humanizeToolUse } from './transcriptRows'

const ev = (nodeIds: string[], at: number) => ({ nodeIds, at })

describe('cleanRecalledEvent', () => {
  it('keeps node-shaped ids once and drops the rest', () => {
    expect(cleanRecalledEvent({ nodeIds: ['kn_a', 'kn_a', 'ke_x', '<b>', 3, 'kn_<script>'], at: 5 })).toEqual({ nodeIds: ['kn_a'], at: 5 })
    expect(cleanRecalledEvent({ nodeIds: [], at: 1 })).toBeNull()
    expect(cleanRecalledEvent({ nodeIds: 'kn_a', at: 1 })).toBeNull()
    expect(cleanRecalledEvent({ nodeIds: ['kn_a'], at: NaN })?.at).toBe(0)
  })
})

describe('recalledRows', () => {
  const live = new Set(['kn_a', 'kn_b', 'kn_c'])
  it('counts an item once per event and orders newest first', () => {
    const rows = recalledRows([ev(['kn_a', 'kn_b'], 1), ev(['kn_a', 'kn_a'].slice(0, 1), 2), ev(['kn_c'], 3)], live)
    expect(rows.map((r) => [r.id, r.count])).toEqual([['kn_c', 1], ['kn_a', 2], ['kn_b', 1]])
  })
  it('keeps the event order of ids that arrived together', () => {
    expect(recalledRows([ev(['kn_b', 'kn_a', 'kn_c'], 1)], live).map((r) => r.id)).toEqual(['kn_b', 'kn_a', 'kn_c'])
  })
  it('drops ids that are not in the graph and caps the list', () => {
    expect(recalledRows([ev(['kn_gone', 'kn_a'], 1)], live).map((r) => r.id)).toEqual(['kn_a'])
    const many = Array.from({ length: 300 }, (_, i) => `kn_${i}`)
    expect(recalledRows([ev(many, 1)], new Set(many))).toHaveLength(200)
    expect(recalledRows([ev(many, 1)], new Set(many), 5)).toHaveLength(5)
  })
  it('does not depend on the order events arrived in', () => {
    const a = recalledRows([ev(['kn_a'], 5), ev(['kn_b'], 1)], live)
    const b = recalledRows([ev(['kn_b'], 1), ev(['kn_a'], 5)], live)
    expect(a).toEqual(b)
  })
})

describe('addRecalled', () => {
  it('keeps the newest events past the cap', () => {
    let list = undefined as ReturnType<typeof addRecalled> | undefined
    for (let i = 0; i < RECALLED_EVENTS_MAX + 3; i++) list = addRecalled(list, ev(['kn_a'], i))
    expect(list).toHaveLength(RECALLED_EVENTS_MAX)
    expect(list?.[0].at).toBe(3)
  })
})

describe('wording', () => {
  it('says how often an item was given', () => {
    expect(givenText(1)).toBe('Given once')
    expect(givenText(3)).toBe('Given 3 times')
  })
  it('words the search status', () => {
    expect(resultsStatus(3, 'Acme')).toBe('3 items found.')
    expect(resultsStatus(1, 'Acme')).toBe('1 item found.')
    expect(resultsStatus(0, ' Acme ')).toBe('Nothing recorded matches Acme.')
  })
  it('words the usage rows without saving claims', () => {
    const rows = knowledgeUsageRows({ recalls: 3, autoContexts: 1, itemsServed: 12, charsServed: 4210 })
    expect(rows.map((r) => [r.id, r.label, r.text])).toEqual([
      ['recalls', 'Looked up by agents', '3 times'],
      ['auto', 'Added automatically', '1 time'],
      ['items', 'Items given to agents', '12'],
      ['chars', 'Text given to agents', '4,210 characters']
    ])
    expect(JSON.stringify(rows)).not.toMatch(/saved/i)
    expect(knowledgeUsageRows({ recalls: -1, autoContexts: NaN, itemsServed: 0, charsServed: 1 })[3].text).toBe('1 character')
  })
})

describe('back stack', () => {
  it('pushes the item we leave and pops it back, capped at 20', () => {
    expect(pushStep([], null)).toEqual([])
    expect(pushStep(['kn_a'], 'kn_b')).toEqual(['kn_a', 'kn_b'])
    let stack: string[] = []
    for (let i = 0; i < 25; i++) stack = pushStep(stack, `kn_${i}`)
    expect(stack).toHaveLength(20)
    expect(popStep(['kn_a', 'kn_b'], 'kn_c')).toEqual({ openId: 'kn_b', stack: ['kn_a'], left: 'kn_c' })
    expect(popStep([], 'kn_a')).toEqual({ openId: null, stack: [], left: 'kn_a' })
  })
})

describe('refusal rows', () => {
  it('words a refused recall as a look-up and a failure without the tool name', () => {
    expect(humanizeToolUse('mcp__orgai__knowledge_recall', { query: 'Acme billing' }).label).toBe('Looked up Acme billing')
    const r = humanizeToolResult('knowledge_recall', 'REFUSED: knowledge_recall needs a query.', false)
    expect(r?.label).toBe('Failed: knowledge_recall needs a query.')
    expect(r?.failed).toBe(true)
  })
})
