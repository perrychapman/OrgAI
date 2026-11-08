import { describe, expect, it } from 'vitest'
import { DECISIONS_NOTICES, DESKTOP_DECISIONS_NOTICE, decisionsNotice, HIDDEN_APP_DECISIONS_NOTICE, NODE_HOST_DECISIONS_NOTICE, TERMINAL_HOST_DECISIONS_NOTICE } from './decisionNotices'

describe('decisionsNotice (cli-standalone-default.md 4.3)', () => {
  it('names where approvals are answered for each host kind; never a desktop window for a terminal host', () => {
    expect(decisionsNotice('desktop')).toBe(DESKTOP_DECISIONS_NOTICE)
    expect(decisionsNotice(undefined)).toBe(DESKTOP_DECISIONS_NOTICE)
    expect(decisionsNotice('headless-host')).toBe(HIDDEN_APP_DECISIONS_NOTICE)
    expect(decisionsNotice('inproc')).toBe(TERMINAL_HOST_DECISIONS_NOTICE)
    expect(decisionsNotice('node')).toBe(NODE_HOST_DECISIONS_NOTICE)
    for (const kind of ['inproc', 'node'] as const) expect(decisionsNotice(kind)).not.toMatch(/desktop app|App settings/)
    expect(HIDDEN_APP_DECISIONS_NOTICE).toContain('orgai daemon stop')
    expect(DECISIONS_NOTICES.size).toBe(4)
  })
})
