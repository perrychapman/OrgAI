import { describe, expect, it } from 'vitest'
import { AGENT_HANDFUL, planToolbar, planWidth, restControls, viewMenuControls, type ToolbarInput } from './canvasToolbar'

const base: ToolbarInput = {
  scene: false,
  conversation: false,
  agentView: false,
  agentCount: 1,
  dockClosed: false,
  earlierToLoad: 0,
  canFold: false,
  frameWidth: 985
}
const input = (patch: Partial<ToolbarInput>): ToolbarInput => ({ ...base, ...patch })

describe('planToolbar: the controls drawn in the row', () => {
  it('1 agent, no plan: scene, zoom, View and the conversation toggle; no find, filter or fold', () => {
    const p = planToolbar(input({ agentCount: 1 }))
    expect(restControls(p)).toEqual(['scene', 'fit', 'view', 'layout-toggle'])
    expect(viewMenuControls(p)).toEqual(['zoom-out', 'zoom-in', 'canvas-style', 'legend'])
    expect(p.hideFinished).toBe(false)
  })

  it('a handful of agents (5) still has no find or filter; the sixth brings them', () => {
    expect(planToolbar(input({ agentCount: AGENT_HANDFUL })).find).toBe('none')
    expect(planToolbar(input({ agentCount: AGENT_HANDFUL })).filter).toBe('none')
    const six = planToolbar(input({ agentCount: AGENT_HANDFUL + 1 }))
    expect(six.find).toBe('inline')
    expect(six.filter).toBe('view')
  })

  it('9 agents with a plan in a 985 px frame (1600 window, dock open): find and Fit inline; filter, zoom steps and Hide finished in the View menu', () => {
    const p = planToolbar(input({ agentCount: 9, canFold: true }))
    expect(restControls(p)).toEqual(['scene', 'find', 'fit', 'view', 'layout-toggle'])
    expect(viewMenuControls(p)).toEqual(['filter', 'zoom-out', 'zoom-in', 'hide-finished', 'canvas-style', 'legend'])
    expect(p.scene).toBe('full')
    expect(p.view).toBe('label')
  })

  it('9 agents in a 688 px frame (1024 window, dock open): the same five controls, the scene by name', () => {
    const p = planToolbar(input({ agentCount: 9, canFold: true, frameWidth: 688 }))
    expect(restControls(p)).toEqual(['scene', 'find', 'fit', 'view', 'layout-toggle'])
    expect(p.scene).toBe('full')
  })

  it('40 agents in a roomy frame (1368 px, dock hidden): the filter and zoom steps join the row; the Conversation button replaces the toggle', () => {
    const p = planToolbar(input({ agentCount: 40, canFold: true, frameWidth: 1368, dockClosed: true }))
    expect(restControls(p)).toEqual(['scene', 'find', 'filter', 'zoom-out', 'zoom-in', 'fit', 'view', 'dock-show'])
    expect(p.layoutToggle).toBe('view')
    expect(viewMenuControls(p)).toEqual(['layout-toggle', 'hide-finished', 'canvas-style', 'legend'])
  })

  it('40 agents with the dock open in a 1368 px frame keeps the toggle in the row and has no duplicate', () => {
    const p = planToolbar(input({ agentCount: 40, canFold: true, frameWidth: 1368 }))
    expect(restControls(p)).toContain('layout-toggle')
    expect(restControls(p)).not.toContain('dock-show')
    expect(viewMenuControls(p)).not.toContain('layout-toggle')
  })

  it('a control is in exactly one place', () => {
    for (const agentCount of [1, 6, 40])
      for (const frameWidth of [260, 360, 480, 560, 688, 800, 985, 1100, 1368, 1700])
        for (const dockClosed of [false, true]) {
          const p = planToolbar(input({ agentCount, frameWidth, dockClosed, canFold: true }))
          const row = restControls(p)
          const menu = viewMenuControls(p)
          for (const id of ['find', 'filter', 'zoom-out', 'zoom-in', 'layout-toggle']) {
            expect(row.includes(id) && menu.includes(id), `${id} at ${frameWidth} (${agentCount} agents, dock closed ${dockClosed})`).toBe(false)
          }
          // Nothing is lost: every control that applies is in the row or the menu.
          expect(row.includes('zoom-in') || menu.includes('zoom-in')).toBe(true)
          expect(row.includes('fit')).toBe(true)
          expect(row.includes('layout-toggle') || menu.includes('layout-toggle')).toBe(true)
          if (agentCount > AGENT_HANDFUL) expect(row.includes('find') || menu.includes('find')).toBe(true)
          if (agentCount > AGENT_HANDFUL) expect(row.includes('filter') || menu.includes('filter')).toBe(true)
        }
  })
})

describe('planToolbar: scenes, conversation and the one-agent view', () => {
  it('a scene has no zoom, find, filter, fold or legend in the row or the menu; the View menu stays for its style', () => {
    const p = planToolbar(input({ scene: true, agentCount: 40, canFold: true }))
    expect(restControls(p)).toEqual(['scene', 'view', 'layout-toggle'])
    expect(viewMenuControls(p)).toEqual(['canvas-style'])
  })

  it('a scene with earlier sessions to load shows that button between the scene switch and View', () => {
    const p = planToolbar(input({ scene: true, earlierToLoad: 3 }))
    expect(restControls(p)).toEqual(['scene', 'load-earlier', 'view', 'layout-toggle'])
  })

  it('the conversation stage keeps only the toggle back to the agents', () => {
    const p = planToolbar(input({ conversation: true, agentCount: 40 }))
    expect(restControls(p)).toEqual(['layout-toggle'])
  })

  it('the one-agent view keeps the conversation controls only', () => {
    const p = planToolbar(input({ agentView: true, agentCount: 40, dockClosed: true }))
    expect(restControls(p)).toEqual(['dock-show', 'layout-toggle'])
  })
})

describe('planToolbar: narrow frames', () => {
  it('first loses the words, then the zoom steps, then the find button, and every one stays reachable', () => {
    const wide = planToolbar(input({ agentCount: 9, canFold: true, dockClosed: true, frameWidth: 968 }))
    expect(wide.dockShow).toBe('label')
    const narrow = planToolbar(input({ agentCount: 9, canFold: true, dockClosed: true, frameWidth: 480 }))
    expect(narrow.dockShow).toBe('icon')
    expect(narrow.view).toBe('icon')
    const tight = planToolbar(input({ agentCount: 9, canFold: true, dockClosed: true, frameWidth: 380 }))
    expect(tight.zoom).toBe('fit')
    expect(viewMenuControls(tight)).toEqual(expect.arrayContaining(['zoom-out', 'zoom-in', 'find', 'filter']))
    expect(restControls(tight)).toEqual(expect.arrayContaining(['fit', 'view', 'dock-show']))
  })

  it('the inline controls always leave the meta row its floor, down to the narrowest plan', () => {
    for (const frameWidth of [360, 420, 480, 560, 640, 688, 760, 800, 900, 985, 1100, 1368]) {
      const p = planToolbar(input({ agentCount: 40, canFold: true, dockClosed: true, frameWidth }))
      const floor = frameWidth >= 800 ? 256 : 150
      if (p.level < 7) expect(planWidth(p) + 24 + floor, `${frameWidth}`).toBeLessThanOrEqual(frameWidth)
    }
  })

  it('an unmeasured frame gets the richest form', () => {
    const p = planToolbar(input({ agentCount: 40, canFold: true, frameWidth: null }))
    expect(p.level).toBe(0)
    expect(p.filter).toBe('inline')
  })

  it('the narrowest plan drops the scene switch (App settings > Canvas still has it)', () => {
    const p = planToolbar(input({ agentCount: 40, canFold: true, dockClosed: true, frameWidth: 300 }))
    expect(p.scene).toBe('none')
    expect(p.view).toBe('icon')
  })
})
