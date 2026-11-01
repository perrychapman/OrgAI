import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0', isPackaged: false, on: () => {} },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {} },
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false },
  nativeTheme: { on: () => {} },
  Notification: class {}
}))

const { capabilityArgs } = await import('./ipc')

const DIGEST = 'a'.repeat(64)
const base = { projectId: 'p1', digest: DIGEST, roleIds: ['r1'], candidateId: 'cap-1' }

describe('capabilityArgs.apply', () => {
  it('rebuilds only known fields and drops paths, specs and content', () => {
    const out = capabilityArgs.apply({ ...base, recommendationId: 'rec-1', path: 'C:/x', spec: { command: 'evil' }, files: ['a'] })
    expect(out).toEqual({ projectId: 'p1', digest: DIGEST, roleIds: ['r1'], recommendationId: 'rec-1', candidateId: 'cap-1' })
  })

  it('leaves access unset when the renderer omits it, so the recommendation keeps its own', () => {
    expect(capabilityArgs.apply(base).access).toBeUndefined()
    expect(capabilityArgs.apply({ ...base, access: 'full' }).access).toBe('full')
    expect(capabilityArgs.apply({ ...base, access: 'read' }).access).toBe('read')
  })

  it('refuses a bad access value', () => {
    for (const access of ['write', 'FULL', 1, null, {}]) expect(() => capabilityArgs.apply({ ...base, access }), String(access)).toThrow('Access must be read or full.')
  })

  it('refuses a missing or malformed digest', () => {
    for (const digest of [undefined, '', 'abc', 'A'.repeat(64), 'g'.repeat(64), DIGEST + '0', 64]) {
      expect(() => capabilityArgs.apply({ ...base, digest }), String(digest)).toThrow('Run the recommendations again first')
    }
  })

  it('refuses no roles, too many roles and path-like role ids', () => {
    expect(() => capabilityArgs.apply({ ...base, roleIds: [] })).toThrow('Choose at least one role.')
    expect(() => capabilityArgs.apply({ ...base, roleIds: 'r1' })).toThrow('Choose at least one role.')
    expect(() => capabilityArgs.apply({ ...base, roleIds: Array.from({ length: 101 }, (_, i) => `r${i}`) })).toThrow('Unknown role in the choice.')
    expect(capabilityArgs.apply({ ...base, roleIds: Array.from({ length: 100 }, (_, i) => `r${i}`) }).roleIds).toHaveLength(100)
    for (const bad of ['../r1', 'r/1', 'r 1', '', 7, null]) expect(() => capabilityArgs.apply({ ...base, roleIds: [bad] }), String(bad)).toThrow('Unknown role in the choice.')
  })

  it('dedupes role ids', () => {
    expect(capabilityArgs.apply({ ...base, roleIds: ['r1', 'r1', 'r2'] }).roleIds).toEqual(['r1', 'r2'])
  })

  it('refuses path-like candidate and recommendation ids, and needs one of them', () => {
    expect(() => capabilityArgs.apply({ ...base, candidateId: '../../etc/passwd' })).toThrow('Candidate not found')
    expect(() => capabilityArgs.apply({ ...base, candidateId: undefined, recommendationId: 'C:\\x' })).toThrow('Recommendation not found')
    expect(() => capabilityArgs.apply({ projectId: 'p1', digest: DIGEST, roleIds: ['r1'] })).toThrow('Name a recommendation or a candidate.')
  })

  it('refuses the harness project and malformed project ids', () => {
    for (const projectId of ['harness', '../p', '', 5, undefined]) expect(() => capabilityArgs.apply({ ...base, projectId }), String(projectId)).toThrow('Project not found')
  })

  it('refuses a non-object input', () => {
    for (const bad of [null, undefined, 'x', 3]) expect(() => capabilityArgs.apply(bad)).toThrow()
  })
})

describe('capabilityArgs other channels', () => {
  it('discover keeps includeOutside strict, bounds the query and checks the request id', () => {
    expect(capabilityArgs.discover({ projectId: 'p1', includeOutside: 'yes', extra: 1 })).toEqual({ projectId: 'p1', includeOutside: false })
    expect(capabilityArgs.discover({ projectId: 'p1', includeOutside: true, query: `  ${'q'.repeat(300)}  ` }).query).toHaveLength(100)
    expect(capabilityArgs.discover({ projectId: 'p1', requestId: 'req-1' }).requestId).toBe('req-1')
    expect(() => capabilityArgs.discover({ projectId: 'p1', requestId: '../x' })).toThrow('Invalid request id')
    expect(() => capabilityArgs.discover({ projectId: 'harness' })).toThrow('Project not found')
  })

  it('recommend checks the scope role id', () => {
    expect(capabilityArgs.recommend({ projectId: 'p1' }).scope).toEqual({})
    expect(capabilityArgs.recommend({ projectId: 'p1', scope: { roleId: 'r1', other: 1 } }).scope).toEqual({ roleId: 'r1' })
    expect(() => capabilityArgs.recommend({ projectId: 'p1', scope: { roleId: 'r/1' } })).toThrow('Role not found')
  })

  it('review never takes outside or model flags on the opened trigger', () => {
    expect(capabilityArgs.review({ projectId: 'p1', trigger: 'opened', includeOutside: true, useModel: true })).toEqual({ projectId: 'p1', trigger: 'opened' })
    expect(capabilityArgs.review({ projectId: 'p1', trigger: 'runEnded', useModel: true })).toEqual({ projectId: 'p1', trigger: 'manual', includeOutside: false, useModel: true })
  })

  it('undo and dismiss check their ids', () => {
    expect(() => capabilityArgs.undo({ projectId: 'p1', undoId: '../u' })).toThrow('Nothing to undo')
    expect(capabilityArgs.undo({ projectId: 'p1', undoId: 'undo-1', x: 1 })).toEqual({ projectId: 'p1', undoId: 'undo-1' })
    expect(() => capabilityArgs.dismiss({ projectId: 'p1', recommendationId: 'a b' })).toThrow('Recommendation not found')
    expect(() => capabilityArgs.dismiss({ projectId: 'p1', candidateId: '../c' })).toThrow('Candidate not found')
    expect(() => capabilityArgs.dismiss({ projectId: 'p1' })).toThrow('Recommendation not found')
    expect(capabilityArgs.dismiss({ projectId: 'p1', candidateId: 'cap-1', x: 1 })).toEqual({ projectId: 'p1', candidateId: 'cap-1' })
    expect(capabilityArgs.dismiss({ projectId: 'p1', recommendationId: 'rec-1', candidateId: 'cap-1' })).toEqual({ projectId: 'p1', recommendationId: 'rec-1', candidateId: 'cap-1' })
  })

  it('restore rebuilds projectId and candidateId only and refuses the harness project', () => {
    expect(capabilityArgs.restore({ projectId: 'p1', candidateId: 'cap-1', recommendation: { id: 'x' }, path: '/etc' })).toEqual({ projectId: 'p1', candidateId: 'cap-1' })
    expect(() => capabilityArgs.restore({ projectId: 'p1' })).toThrow('Candidate not found')
    expect(() => capabilityArgs.restore({ projectId: 'p1', candidateId: '../c' })).toThrow('Candidate not found')
    expect(() => capabilityArgs.restore({ projectId: 'p1', candidateId: 7 })).toThrow('Candidate not found')
    expect(() => capabilityArgs.restore({ projectId: 'harness', candidateId: 'cap-1' })).toThrow('Project not found')
    expect(() => capabilityArgs.restore({ projectId: '../p', candidateId: 'cap-1' })).toThrow('Project not found')
    expect(() => capabilityArgs.restore(null)).toThrow()
  })
})
