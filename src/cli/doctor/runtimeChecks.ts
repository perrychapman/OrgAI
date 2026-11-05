/**
 * WP-C: the Claude runtime the resolver finds (src/main/runtime/claudeBinary.ts claudeExecutable) and Codex on PATH
 * with its version against the tested range (cli-standalone.md 6.1, 6.2). Contracts only: no checks yet.
 */
import type { DoctorCheckGroup } from './types'

export const runtimeChecks: DoctorCheckGroup = async () => []
