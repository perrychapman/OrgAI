import { describe, expect, it } from 'vitest'
import { buildingLayout, EMPTY_BUILDING_MEMORY, rememberTeam, type BuildingAgent } from './building'
import {
  cameraArea, clampScroll, defaultView, fitsAt, fitView, fitZoom, mapOffset, panBy, pinScroll, revealScroll, stepZoom, toScreen, toWorld, zoomLabel, zoomName, ZOOMS, type View
} from './camera'

describe('zoomName', () => {
  it('speaks the readout as a percentage', () => {
    expect(ZOOMS.map(zoomName)).toEqual(['Zoom 50%', 'Zoom 100%', 'Zoom 200%', 'Zoom 300%', 'Zoom 400%'])
  })
})

function team(departments: number, perDepartment: number): BuildingAgent[] {
  const agents: BuildingAgent[] = [{ id: 'lead', departmentId: 'central', departmentName: 'Orchestrators', central: true }]
  for (let d = 0; d < departments; d++) for (let i = 0; i < perDepartment; i++) agents.push({ id: `d${d}-${i}`, departmentId: `dep${d}`, departmentName: `Department ${d}`, central: false })
  return agents
}
function areaOf(agents: BuildingAgent[]) {
  const building = buildingLayout(agents, rememberTeam(EMPTY_BUILDING_MEMORY, agents), 'live')
  return { building, area: cameraArea(building.bounds, building.frontDoor !== null) }
}

describe('office camera maths', () => {
  it('steps the zoom set and clamps at both ends', () => {
    expect(ZOOMS).toEqual([0.5, 1, 2, 3, 4])
    expect(stepZoom(2, 1)).toBe(3)
    expect(stepZoom(2, -1)).toBe(1)
    expect(stepZoom(1, -1)).toBe(0.5)
    expect(stepZoom(0.5, -1)).toBe(0.5)
    expect(stepZoom(4, 1)).toBe(4)
    expect(stepZoom(1.4, 1)).toBe(2)
  })

  it('labels the readout', () => {
    expect(ZOOMS.map(zoomLabel)).toEqual(['½×', '1×', '2×', '3×', '4×'])
  })

  it('fits to the largest zoom that shows the whole area, never below 0.5', () => {
    expect(fitZoom({ width: 58, height: 33 }, { width: 985, height: 619 })).toBe(1)
    expect(fitZoom({ width: 58, height: 33 }, { width: 1600, height: 1000 })).toBe(1)
    expect(fitZoom({ width: 20, height: 10 }, { width: 985, height: 619 })).toBe(3)
    expect(fitZoom({ width: 160, height: 35 }, { width: 700, height: 400 })).toBe(0.5)
    expect(fitZoom({ width: 500, height: 500 }, { width: 100, height: 100 })).toBe(0.5)
    expect(fitsAt({ width: 58, height: 33 }, { width: 985, height: 619 }, 1)).toBe(true)
    expect(fitsAt({ width: 58, height: 33 }, { width: 985, height: 619 }, 2)).toBe(false)
  })

  it('uses 2x centred when the building fits at 2x, else 2x on the lobby, 1x on a short stage', () => {
    const small = areaOf(team(0, 0))
    const lobby = small.building.rooms[0]
    const fits = defaultView(small.area, lobby, { width: 985, height: 619 })
    expect(fits.zoom).toBe(2)
    expect(fits.focus).toEqual({ x: (small.area.x + small.area.width / 2) * 16, y: (small.area.y + small.area.height / 2) * 16 })
    const big = areaOf(team(4, 8))
    const bigLobby = big.building.rooms[0]
    const wide = defaultView(big.area, bigLobby, { width: 985, height: 619 })
    expect(wide.zoom).toBe(2)
    expect(wide.focus).toEqual({ x: (bigLobby.x + bigLobby.width / 2) * 16, y: (bigLobby.y + bigLobby.height / 2) * 16 })
    expect(defaultView(big.area, bigLobby, { width: 985, height: 300 }).zoom).toBe(1)
  })

  it('fits the 33-role building at 1x on a 985 x 619 stage', () => {
    const { area } = areaOf(team(4, 8))
    expect(fitView(area, { width: 985, height: 619 }).zoom).toBe(1)
  })

  it('centres content smaller than the stage and clamps scroll', () => {
    const view: View = { area: { x: 0, y: 0, width: 20, height: 10 }, zoom: 2, client: { width: 1000, height: 600 }, scroll: { x: 0, y: 0 } }
    expect(mapOffset(view)).toEqual({ x: 180, y: 140 })
    expect(clampScroll(view, { x: 50, y: -3 })).toEqual({ x: 0, y: 0 })
    const big: View = { ...view, area: { x: 0, y: 0, width: 100, height: 60 } }
    expect(mapOffset(big)).toEqual({ x: 0, y: 0 })
    expect(clampScroll(big, { x: 99999, y: 99999 })).toEqual({ x: 3200 - 1000, y: 1920 - 600 })
  })

  it('pins a world point under a screen point and round-trips', () => {
    const view: View = { area: { x: -1, y: 4, width: 60, height: 30 }, zoom: 2, client: { width: 800, height: 500 }, scroll: { x: 0, y: 0 } }
    const world = { x: 400, y: 300 }
    const screen = { x: 300, y: 200 }
    const scroll = pinScroll(view, world, screen)
    const placed = { ...view, scroll }
    expect(toScreen(placed, world)).toEqual(screen)
    expect(toWorld(placed, screen)).toEqual(world)
  })

  it('keeps the stage-centre world point fixed across a zoom change', () => {
    const base: View = { area: { x: 0, y: 0, width: 60, height: 40 }, zoom: 1, client: { width: 800, height: 500 }, scroll: { x: 120, y: 90 } }
    const centre = { x: 400, y: 250 }
    const world = toWorld(base, centre)
    const zoomed = { ...base, zoom: 2 }
    const scroll = pinScroll(zoomed, world, centre)
    expect(toWorld({ ...zoomed, scroll }, centre)).toEqual(world)
  })

  it('reveals a target with a margin and leaves a visible one alone', () => {
    const view: View = { area: { x: 0, y: 0, width: 100, height: 60 }, zoom: 1, client: { width: 800, height: 500 }, scroll: { x: 200, y: 100 } }
    expect(revealScroll(view, { x: 400, y: 200, width: 20, height: 30 })).toEqual({ x: 200, y: 100 })
    expect(revealScroll(view, { x: 100, y: 200, width: 20, height: 30 }).x).toBe(100 - 24)
    expect(revealScroll(view, { x: 1100, y: 200, width: 20, height: 30 }).x).toBe(1100 + 20 + 24 - 800)
    expect(revealScroll(view, { x: 400, y: 20, width: 20, height: 30 }).y).toBe(0)
    expect(revealScroll(view, { x: 400, y: 570, width: 20, height: 30 }).y).toBe(570 + 30 + 24 - 500)
  })

  it('maps arrow keys to pans of 48 and 192', () => {
    expect(panBy('ArrowLeft', false)).toEqual({ x: -48, y: 0 })
    expect(panBy('ArrowDown', true)).toEqual({ x: 0, y: 192 })
    expect(panBy('a', false)).toBeNull()
  })
})
