import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { isLiveProcess, processStartTime, selfStartTime } from './processInfo'

function errno(code: string): Error {
  return Object.assign(new Error(code), { code })
}

describe('isLiveProcess', () => {
  it('is true for this process', () => {
    expect(isLiveProcess(process.pid)).toBe(true)
    expect(isLiveProcess(process.pid, selfStartTime())).toBe(true)
  })

  it('is false for a child that has exited', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    const pid = child.pid!
    await new Promise<void>((resolve) => child.on('exit', () => resolve()))
    // Give the OS a moment to reap it (node reaps on exit; the pid is free afterwards).
    await new Promise((r) => setTimeout(r, 50))
    expect(isLiveProcess(pid)).toBe(false)
  })

  it('is false when the recorded start time differs (pid reuse)', () => {
    expect(isLiveProcess(process.pid, 'not-the-start-time', { startTimeOf: () => 'the-real-start-time' })).toBe(false)
    if (selfStartTime()) expect(isLiveProcess(process.pid, `${selfStartTime()}x`)).toBe(false)
  })

  it('is true when kill throws EPERM', () => {
    expect(isLiveProcess(4242, undefined, { kill: () => { throw errno('EPERM') } })).toBe(true)
  })

  it('is false when kill throws ESRCH', () => {
    expect(isLiveProcess(4242, 'any', { kill: () => { throw errno('ESRCH') } })).toBe(false)
  })

  it('is true when the start time is unavailable on either side', () => {
    const kill = (): void => {}
    expect(isLiveProcess(4242, 'recorded', { kill, startTimeOf: () => undefined })).toBe(true)
    expect(isLiveProcess(4242, undefined, { kill, startTimeOf: () => 'now' })).toBe(true)
  })

  it('is true when both start times match', () => {
    expect(isLiveProcess(4242, 'same', { kill: () => {}, startTimeOf: () => 'same' })).toBe(true)
  })

  it('is false for invalid pids', () => {
    for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(isLiveProcess(pid)).toBe(false)
  })
})

describe('processStartTime', () => {
  it.runIf(process.platform === 'darwin' || process.platform === 'linux')('is a stable non-empty string for this process', () => {
    const a = processStartTime(process.pid)
    const b = processStartTime(process.pid)
    expect(typeof a).toBe('string')
    expect(a!.length).toBeGreaterThan(0)
    expect(b).toBe(a)
    expect(selfStartTime()).toBe(a)
  })

  it('is undefined for invalid pids', () => {
    expect(processStartTime(0)).toBeUndefined()
    expect(processStartTime(-5)).toBeUndefined()
  })
})
