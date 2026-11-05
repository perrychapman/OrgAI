/**
 * Test helper: a CustodianSpawner whose children answer from a script, recording every call (file, args, options,
 * stdin). Never spawns anything. Used by the custodian tests only.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { CustodianChild, CustodianSpawner, CustodianSpawnOptions } from './run'

export interface FakeAnswer {
  code?: number | null
  stdout?: string
  stderr?: string
  /** Never exits (the caller's timeout must fire). */
  hang?: boolean
  /** Emit 'error' with this code instead of starting (ENOENT...). */
  spawnError?: string
}

export interface FakeCall {
  file: string
  args: string[]
  options: CustodianSpawnOptions
  stdin: string
  killed: boolean
}

export type FakeScript = (call: { file: string; args: string[]; stdin: string }) => FakeAnswer

class FakeChild extends EventEmitter implements CustodianChild {
  readonly pid = 4242
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  constructor(private readonly record: FakeCall) {
    super()
  }
  kill(): boolean {
    this.record.killed = true
    setImmediate(() => this.emit('close', null, 'SIGKILL'))
    return true
  }
}

export function fakeSpawner(script: FakeScript): { spawner: CustodianSpawner; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const spawner: CustodianSpawner = (file, args, options) => {
    const record: FakeCall = { file, args: [...args], options, stdin: '', killed: false }
    calls.push(record)
    const child = new FakeChild(record)
    const chunks: Buffer[] = []
    child.stdin.on('data', (c: Buffer) => chunks.push(Buffer.from(c)))
    child.stdin.on('end', () => {
      record.stdin = Buffer.concat(chunks).toString('utf8')
      const a = script({ file, args: record.args, stdin: record.stdin })
      if (a.spawnError) {
        setImmediate(() => child.emit('error', Object.assign(new Error(a.spawnError), { code: a.spawnError })))
        return
      }
      if (a.hang) return
      setImmediate(() => {
        if (a.stdout) child.stdout.write(a.stdout)
        if (a.stderr) child.stderr.write(a.stderr)
        child.stdout.end()
        child.stderr.end()
        child.emit('exit', a.code ?? 0, null)
        child.emit('close', a.code ?? 0, null)
      })
    })
    return child
  }
  return { spawner, calls }
}
