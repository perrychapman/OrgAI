import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { isLiveProcess, isLiveProcessCached, processStartTime, selfStartTime } from './processInfo'

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

describe('processStartTime environment independence', () => {
  it.runIf(process.platform === 'darwin' || process.platform === 'linux')('reads the same value whatever TZ and locale the reader has', () => {
    const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL, LANG: process.env.LANG, LC_TIME: process.env.LC_TIME }
    const read = (env: Partial<Record<keyof typeof saved, string>>): string | undefined => {
      for (const k of Object.keys(saved) as (keyof typeof saved)[]) {
        if (env[k] === undefined) delete process.env[k]
        else process.env[k] = env[k]
      }
      return processStartTime(process.pid)
    }
    try {
      const base = read({})
      expect(base).toBeTruthy()
      expect(read({ TZ: 'UTC' })).toBe(base)
      expect(read({ TZ: 'Asia/Kathmandu' })).toBe(base)
      expect(read({ LC_ALL: 'de_DE.UTF-8' })).toBe(base)
      expect(read({ LANG: 'ja_JP.UTF-8', LC_TIME: 'fr_FR.UTF-8', TZ: 'America/Los_Angeles' })).toBe(base)
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})

describe('isLiveProcessCached', () => {
  it('reads the start time once per recheck window and only probes the pid in between', () => {
    let t = 1_000
    let reads = 0
    let alive = true
    const deps = {
      now: () => t,
      recheckMs: 5000,
      kill: () => {
        if (!alive) throw errno('ESRCH')
      },
      startTimeOf: () => {
        reads++
        return 'start-a'
      }
    }
    for (let i = 0; i < 50; i++) expect(isLiveProcessCached(7001, 'start-a', deps)).toBe(true)
    expect(reads).toBe(1)
    t += 5000
    expect(isLiveProcessCached(7001, 'start-a', deps)).toBe(true)
    expect(reads).toBe(2)
    alive = false
    expect(isLiveProcessCached(7001, 'start-a', deps)).toBe(false)
  })

  it('never caches a mismatch', () => {
    let reads = 0
    const deps = { kill: () => {}, startTimeOf: () => (reads++, 'other') }
    expect(isLiveProcessCached(7002, 'start-b', deps)).toBe(false)
    expect(isLiveProcessCached(7002, 'start-b', deps)).toBe(false)
    expect(reads).toBe(2)
  })
})
