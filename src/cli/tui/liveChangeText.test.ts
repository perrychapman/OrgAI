import { describe, expect, it } from 'vitest'

import type { LiveRunChange } from '../../shared/types'

import { liveChangeNotice, takesSavedTeam } from './liveChangeText'

const c = (over: Partial<LiveRunChange>): LiveRunChange => ({ runId: 'r1', title: 'T', availability: 'now', ...over })

describe('liveChangeNotice', () => {
  it('stays silent while the run has not answered', () => {
    expect(liveChangeNotice(c({ availability: 'pending' }), ['skills'])).toBeUndefined()
  })

  it('says what this run does with the change', () => {
    expect(liveChangeNotice(c({}), ['mcpServers'])).toEqual({
      text: 'MCP servers: this run uses the change now.',
      tone: 'ok'
    })
    expect(liveChangeNotice(c({ availability: 'after-idle' }), ['skills'])).toEqual({
      text: 'Skills: this run takes the change when it is next idle.',
      tone: 'ok'
    })
    expect(liveChangeNotice(c({ availability: 'next-run', reason: '  The run is ending.  ' }), ['orgChart'])).toEqual({
      text: 'The team: this run uses the change from the next run. The run is ending.',
      tone: 'warn'
    })
  })

  it('lets a next-run reason that says "next run" itself stand in for the sentence, so nothing is said twice or lost', () => {
    expect(liveChangeNotice(c({ availability: 'next-run', reason: 'This run takes org chart changes from the next run.' }), ['orgChart'])).toEqual({
      text: 'The team: This run takes org chart changes from the next run.',
      tone: 'warn'
    })
    expect(liveChangeNotice(c({ availability: 'next-run', reason: 'Some grants name a server or skill this run does not have; they apply from the next run.' }), ['grants'])?.text).toBe(
      'Role grants: Some grants name a server or skill this run does not have; they apply from the next run.'
    )
  })

  it('keeps a next-run reason that adds information', () => {
    expect(liveChangeNotice(c({ availability: 'next-run', reason: 'The run was still starting when the change was saved.' }), ['orgChart'])).toEqual({
      text: 'The team: this run uses the change from the next run. The run was still starting when the change was saved.',
      tone: 'warn'
    })
    expect(liveChangeNotice(c({ availability: 'next-run', reason: 'OrgAI could not apply it to this run.' }), ['orgChart'])).toEqual({
      text: 'The team: this run uses the change from the next run. OrgAI could not apply it to this run.',
      tone: 'warn'
    })
  })

  it('names the subject', () => {
    expect(liveChangeNotice(c({}), [])?.text).toBe('The change: this run uses the change now.')
    expect(liveChangeNotice(c({}), ['skills', 'orgChart', 'skills'])?.text).toBe('Skills and the team: this run uses the change now.')
    expect(liveChangeNotice(c({}), ['mcpServers', 'skills'])?.text).toBe('MCP servers and Skills: this run uses the change now.')
    expect(liveChangeNotice(c({}), ['mcpServers', 'skills', 'grants'])?.text).toBe('The change: this run uses the change now.')
  })

  it('appends the deferred roles and the first note', () => {
    expect(liveChangeNotice(c({ deferred: [{ name: 'A', reason: 'x' }] }), ['orgChart'])?.text).toBe(
      'The team: this run uses the change now. 1 role waits for the next run.'
    )
    expect(
      liveChangeNotice(c({ deferred: [{ name: 'A', reason: 'x' }, { name: 'B', reason: 'y' }], notes: [{ name: 'A', note: ' Renamed to Lead. ' }] }), ['orgChart'])?.text
    ).toBe('The team: this run uses the change now. 2 roles wait for the next run. Renamed to Lead.')
  })

  it('names a run that is not on screen by its tag, also inside the reason and the note', () => {
    expect(liveChangeNotice(c({}), ['orgChart'], 'R2')?.text).toBe('The team: R2 uses the change now.')
    expect(liveChangeNotice(c({ availability: 'after-idle' }), ['skills'], 'R2')?.text).toBe('Skills: R2 takes the change when it is next idle.')
    expect(liveChangeNotice(c({ availability: 'next-run', reason: 'This run takes org chart changes from the next run.' }), ['orgChart'], 'R2')?.text).toBe(
      'The team: R2 takes org chart changes from the next run.'
    )
    expect(liveChangeNotice(c({ notes: [{ name: 'Lead', note: 'Renamed to Lead. This run keeps calling it boss until the next run.' }] }), ['orgChart'], 'R3')?.text).toBe(
      'The team: R3 uses the change now. Renamed to Lead. R3 keeps calling it boss until the next run.'
    )
    // A reason that does not name the run cannot stand in for the sentence that does.
    expect(liveChangeNotice(c({ availability: 'next-run', reason: 'The top role keeps whether it can hand out work until the next run.' }), ['orgChart'], 'R2')?.text).toBe(
      'The team: R2 uses the change from the next run. The top role keeps whether it can hand out work until the next run.'
    )
  })
})

describe('takesSavedTeam', () => {
  it('is true only for a team work run this terminal hosts', () => {
    expect(takesSavedTeam({ kind: 'work', status: 'running' })).toBe(true)
    expect(takesSavedTeam({ kind: 'work', team: 'single', status: 'running' })).toBe(false)
    expect(takesSavedTeam({ kind: 'work', quick: {} as never, status: 'running' })).toBe(false)
    expect(takesSavedTeam({ kind: 'setup', status: 'running' })).toBe(false)
    expect(takesSavedTeam({ kind: 'work', liveElsewhere: { pid: 1, cwd: '/x', command: 'orgai' }, status: 'running' })).toBe(false)
    expect(takesSavedTeam({ kind: 'work', status: 'stopping' })).toBe(false)
  })
})
