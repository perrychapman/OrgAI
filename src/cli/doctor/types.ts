/**
 * Wave 7 doctor check groups (cli-standalone.md 3.5, 5.7, 6, 7.1, 8.1, 8.2). Each work package fills its own group in
 * its own file, so they never edit doctor.ts at the same time; runDoctor calls the groups in a fixed order before it
 * closes its host connection. A group never throws (a failure is a 'warn' or 'fail' check) and never prints a secret.
 */
import type { DoctorCheck } from '../commands/doctor'
import type { CliContext, HostClient } from '../types'

export interface DoctorGroupInput {
  ctx: CliContext
  /** A verified read-scope connection to the running host, when one answered (runDoctor closes it afterwards). */
  client?: HostClient
}

export type DoctorCheckGroup = (input: DoctorGroupInput) => Promise<DoctorCheck[]>
