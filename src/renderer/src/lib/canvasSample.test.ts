import { describe, expect, it } from 'vitest'
import { ROLE_COLORS } from '@shared/defaults'
import { SAMPLE_NODE_COUNT, buildSample, type SampleInks } from './canvasSample'

const inks: SampleInks = { edgeMix: 85, edgeInk: '#ffffff', groupEdge: '#66718c', message: '#5d8bd6' }

describe('buildSample', () => {
  it('builds the same six nodes for every layout and node style', () => {
    for (const layout of ['top-down', 'left-right', 'radial'] as const) {
      for (const nodeStyle of ['card', 'compact'] as const) {
        const g = buildSample({ layout, nodeStyle, edges: 'curved' }, inks)
        expect(g.nodes).toHaveLength(SAMPLE_NODE_COUNT)
        expect(g.nodes.filter((n) => n.type === 'agent')).toHaveLength(5)
        expect(g.nodes.filter((n) => n.type === 'done-group')).toHaveLength(1)
        for (const n of g.nodes) {
          expect(Number.isFinite(n.position.x) && Number.isFinite(n.position.y)).toBe(true)
        }
      }
    }
  })

  it('uses the first five role colours and one of each state', () => {
    const g = buildSample({ layout: 'top-down', nodeStyle: 'card', edges: 'curved' }, inks)
    const agents = g.nodes.filter((n) => n.type === 'agent')
    expect(agents.map((n) => (n.data as { color: string }).color)).toEqual(ROLE_COLORS.slice(0, 5))
    const states = agents.map((n) => (n.data as { agent: { state: string } }).agent.state)
    expect(states).toEqual(expect.arrayContaining(['delegating', 'tool', 'waiting', 'done', 'error']))
  })

  it('sizes nodes by style', () => {
    const card = buildSample({ layout: 'top-down', nodeStyle: 'card', edges: 'curved' }, inks)
    const compact = buildSample({ layout: 'top-down', nodeStyle: 'compact', edges: 'curved' }, inks)
    expect(card.nodes[0].width).toBe(240)
    expect(compact.nodes[0].width).toBe(160)
    expect(compact.nodes[0].height).toBe(40)
  })

  it('has exactly one message edge from the waiting reviewer to the orchestrator, dotted and different from a working line', () => {
    const g = buildSample({ layout: 'top-down', nodeStyle: 'card', edges: 'straight' }, inks)
    const msgs = g.edges.filter((e) => e.className === 'msg-edge')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].source).toBe('sample-reviewer')
    expect(msgs[0].target).toBe('sample-root')
    const working = g.edges.find((e) => e.id === 'e-sample-root-sample-lead')
    expect(working?.style?.strokeDasharray).toBe('6 4')
    expect(msgs[0].style?.strokeDasharray).not.toBe(working?.style?.strokeDasharray)
  })

  it('follows the line style, and radial uses the radial edge type', () => {
    const curved = buildSample({ layout: 'top-down', nodeStyle: 'card', edges: 'curved' }, inks)
    const right = buildSample({ layout: 'top-down', nodeStyle: 'card', edges: 'orthogonal' }, inks)
    expect(curved.edges[0].type).toBe('default')
    expect(right.edges[0].type).toBe('smoothstep')
    const radial = buildSample({ layout: 'radial', nodeStyle: 'card', edges: 'orthogonal' }, inks)
    expect(radial.edges.every((e) => e.type === 'radial')).toBe(true)
  })

  it('places left to right children to the right of their parent', () => {
    const g = buildSample({ layout: 'left-right', nodeStyle: 'card', edges: 'curved' }, inks)
    const root = g.nodes.find((n) => n.id === 'sample-root')!
    const lead = g.nodes.find((n) => n.id === 'sample-lead')!
    expect(lead.position.x).toBeGreaterThan(root.position.x)
  })
})
