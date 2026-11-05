import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { killTrackedChildren, trackChildProcess, trackedChildCount } from './shutdown'

class FakeChild extends EventEmitter {
  killed: (NodeJS.Signals | number | undefined)[] = []
  pid = 4242
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push(signal)
    return true
  }
}

describe('tracked child processes (cli-standalone.md 4.3 hard limit)', () => {
  it('tracks until exit or untrack, and kills what is left with SIGKILL', () => {
    const a = new FakeChild()
    const b = new FakeChild()
    const c = new FakeChild()
    trackChildProcess(a, 'custodian:keychain')
    const untrackB = trackChildProcess(b, 'git')
    trackChildProcess(c, 'custodian:dpapi')
    expect(trackedChildCount('custodian:')).toBe(2)
    a.emit('exit', 0)
    untrackB()
    untrackB()
    expect(trackedChildCount()).toBe(1)
    expect(killTrackedChildren()).toBe(1)
    expect(c.killed).toEqual(['SIGKILL'])
    expect(a.killed).toEqual([])
    expect(trackedChildCount()).toBe(0)
  })

  it('never throws on a child that cannot be killed', () => {
    trackChildProcess({ kill: () => { throw new Error('gone') } }, 'x')
    expect(killTrackedChildren('SIGTERM')).toBe(0)
    expect(trackedChildCount()).toBe(0)
  })
})
