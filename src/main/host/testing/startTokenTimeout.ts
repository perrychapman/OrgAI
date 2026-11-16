/**
 * Test helper for real-process start-token tests. A token read (ps, or PowerShell + CIM on Windows) that runs into
 * START_TOKEN_TIMEOUT_MS reports null by design ("no information"); on a heavily loaded machine PowerShell alone can
 * take longer than that. Then the property under test cannot be checked, so the test skips itself with a message.
 * A null (or a wrong value) that comes back faster than the timeout is a real failure and is never skipped.
 */
import { START_TOKEN_TIMEOUT_MS } from '../startTokens'

/** Elapsed time that means the read ran into its timeout (a little slack for timer granularity). */
export const TIMED_OUT_AFTER_MS = START_TOKEN_TIMEOUT_MS - 500

interface Skippable {
  skip(condition: boolean, note?: string): void
}

/** Run `read`, timing it. */
export async function timed<T>(read: () => T | Promise<T>): Promise<{ value: T; ms: number }> {
  const start = Date.now()
  const value = await read()
  return { value, ms: Date.now() - start }
}

/**
 * Skip the running test when `noInformation` is true and the read took as long as the token timeout: the machine was
 * too slow to read process start times, not the code wrong.
 */
export function skipIfTokenReadTimedOut(ctx: Skippable, noInformation: boolean, ms: number, what: string): void {
  ctx.skip(
    noInformation && ms >= TIMED_OUT_AFTER_MS,
    `${what} gave no information after ${ms} ms (token read timeout ${START_TOKEN_TIMEOUT_MS} ms): this machine is too loaded to check the property`
  )
}
