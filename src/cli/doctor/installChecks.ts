/**
 * WP-A: the install channel (install.json, src/cli/installInfo.ts), every `orgai` on PATH in order with channel and
 * version (a shadowed newer one flagged), the Node floor for system certificates (cli-standalone.md 3.5, 7.1, 8.2).
 * Contracts only: no checks yet.
 */
import type { DoctorCheckGroup } from './types'

export const installChecks: DoctorCheckGroup = async () => []
