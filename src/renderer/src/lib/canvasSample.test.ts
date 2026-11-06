import { describe, expect, it } from 'vitest'
import { ROLE_COLORS } from '@shared/defaults'
import { SAMPLE_NODE_COUNT, buildSample, type SampleInks } from './canvasSample'

const inks: SampleInks = { edgeMix: 85, edgeInk: '#ffffff', groupEdge: '#66718c', message: '#5d8bd6' }

describe('buildSample', () => {
  it('builds the same six nodes for every layout and node style', () => {
    for (const layout of ['top-down', 'left-right', 'radial'] as const) {
      for (const nodeStyle of ['card', 'compact', 'station', 'hex'] as const) {
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

  it('draws stations with the station box per layout and thick round lines in the lead colour', () => {
    const lr = buildSample({ layout: 'left-right', nodeStyle: 'station', edges: 'curved' }, { ...inks, doneOpacity: 0.7 })
    expect(lr.nodes[0].width).toBe(120)
    expect(lr.nodes[0].height).toBe(64)
    expect(buildSample({ layout: 'top-down', nodeStyle: 'station', edges: 'curved' }, inks).nodes[0].width).toBe(160)
    const reporting = lr.edges.filter((e) => e.id.startsWith('e-') && !e.id.includes('group:'))
    for (const e of reporting) {
      expect(e.style?.strokeWidth).toBe(6)
      expect(e.style?.strokeLinecap).toBe('round')
      expect(e.markerEnd).toBeUndefined()
      expect(e.animated).toBeFalsy()
      expect(e.style?.strokeDasharray).toBeUndefined()
    }
    // Both lines leaving the orchestrator, and the lead's two reports, share their lead's colour.
    const stroke = (id: string): unknown => lr.edges.find((e) => e.id === id)?.style?.stroke
    expect(stroke('e-sample-root-sample-lead')).toBe(stroke('e-sample-root-sample-reviewer'))
    expect(stroke('e-sample-lead-sample-writer')).toBe(stroke('e-sample-lead-sample-tester'))
    expect(stroke('e-sample-root-sample-lead')).not.toBe(stroke('e-sample-lead-sample-writer'))
    expect(lr.edges.find((e) => e.id === 'e-sample-lead-sample-writer')?.style?.opacity).toBe(0.7)
    // The folded group line takes the reviewer's colour and is not dashed.
    const group = lr.edges.find((e) => e.target.startsWith('group:'))!
    expect(group.style?.strokeDasharray).toBeUndefined()
    expect(group.style?.strokeWidth).toBe(6)
    // Message edges keep their dotted look.
    expect(lr.edges.find((e) => e.className === 'msg-edge')?.style?.strokeDasharray).toBe('2 5')
  })

  it('rounds the corners of Right angle subway lines only', () => {
    const right = buildSample({ layout: 'left-right', nodeStyle: 'station', edges: 'orthogonal' }, inks)
    expect(right.edges[0]).toMatchObject({ pathOptions: { borderRadius: 12 } })
    expect(buildSample({ layout: 'left-right', nodeStyle: 'card', edges: 'orthogonal' }, inks).edges[0]).not.toHaveProperty('pathOptions')
  })

  it('lays hex tiles out on a honeycomb with no rings and keeps card edges', () => {
    const g = buildSample({ layout: 'radial', nodeStyle: 'hex', edges: 'straight' }, inks)
    expect(g.rings).toBeUndefined()
    expect(g.nodes[0].width).toBe(120)
    expect(g.nodes[0].height).toBe(104)
    const root = g.nodes.find((n) => n.id === 'sample-root')!
    expect(root.position).toEqual({ x: -60, y: -52 })
    const lead = g.edges.find((e) => e.id === 'e-sample-root-sample-lead')!
    expect(lead.style?.strokeDasharray).toBe('6 4')
    expect(lead.markerEnd).toBeDefined()
  })

  it('places left to right children to the right of their parent', () => {
    const g = buildSample({ layout: 'left-right', nodeStyle: 'card', edges: 'curved' }, inks)
    const root = g.nodes.find((n) => n.id === 'sample-root')!
    const lead = g.nodes.find((n) => n.id === 'sample-lead')!
    expect(lead.position.x).toBeGreaterThan(root.position.x)
  })
})
