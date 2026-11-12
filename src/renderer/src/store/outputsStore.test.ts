import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunOutput } from '@shared/types'

const list = vi.fn(async (_projectId: string): Promise<RunOutput[]> => [])
vi.stubGlobal('window', {
  orgai: { outputs: { list } },
  dispatchEvent: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  location: { hash: '' }
})
vi.stubGlobal('Event', class {})

const { useAppStore } = await import('./useAppStore')

function out(id: string, extra: Partial<RunOutput> = {}): RunOutput {
  return { id, projectId: 'p1', runId: 'r1', kind: 'docx', title: id, fileName: `${id}.docx`, path: `/p/${id}.docx`, relPath: `outputs/${id}.docx`, bytes: 1, createdAt: 1, source: 'produced', ...extra }
}

describe('store: run outputs', () => {
  beforeEach(() => {
    list.mockReset()
    useAppStore.setState({ outputsByProject: {}, outputsFocus: null, runOutputsByChain: {}, sideTabByRun: {}, runs: {}, historyByProject: {} })
  })

  it('loadOutputs stores the list and keeps the old one on failure', async () => {
    list.mockResolvedValueOnce([out('a')])
    await useAppStore.getState().loadOutputs('p1')
    expect(useAppStore.getState().outputsByProject.p1.map((o) => o.id)).toEqual(['a'])
    list.mockRejectedValueOnce(new Error('nope'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await useAppStore.getState().loadOutputs('p1')
    warn.mockRestore()
    expect(useAppStore.getState().outputsByProject.p1.map((o) => o.id)).toEqual(['a'])
  })

  it('never loads for a virtual project', async () => {
    await useAppStore.getState().loadOutputs('quick')
    expect(list).not.toHaveBeenCalled()
  })

  it('output.created prepends or replaces into a loaded list', () => {
    useAppStore.setState({ outputsByProject: { p1: [out('a')] } })
    useAppStore.getState().handleEvent({ type: 'output.created', runId: 'r1', output: out('b') })
    expect(useAppStore.getState().outputsByProject.p1.map((o) => o.id)).toEqual(['b', 'a'])
    useAppStore.getState().handleEvent({ type: 'output.created', runId: 'r1', output: out('a', { title: 'Renamed' }) })
    const now = useAppStore.getState().outputsByProject.p1
    expect(now.map((o) => o.id)).toEqual(['b', 'a'])
    expect(now[1].title).toBe('Renamed')
  })

  it('output.created for an unloaded project fetches the whole list instead', async () => {
    list.mockResolvedValueOnce([out('z', { projectId: 'p2' }), out('y', { projectId: 'p2' })])
    useAppStore.getState().handleEvent({ type: 'output.created', runId: 'r1', output: out('z', { projectId: 'p2' }) })
    await vi.waitFor(() => expect(useAppStore.getState().outputsByProject.p2?.length).toBe(2))
    expect(list).toHaveBeenCalledWith('p2')
  })

  it('openRunOutput switches the side tab and remembers the open item per chain', () => {
    useAppStore.setState({ runs: { r1: { summary: { id: 'r1', projectId: 'p1', startedAt: 1, status: 'running' } } } as never })
    useAppStore.getState().openRunOutput('r1', 'out_1')
    expect(useAppStore.getState().sideTabByRun.r1).toBe('outputs')
    expect(useAppStore.getState().runOutputsByChain.r1.openId).toBe('out_1')
    useAppStore.getState().openRunOutput('r1')
    expect(useAppStore.getState().runOutputsByChain.r1.openId).toBe('out_1')
    useAppStore.getState().openRunOutput('r1', null)
    expect(useAppStore.getState().runOutputsByChain.r1.openId).toBeNull()
  })

  it('openOutputItem opens the Outputs view with a focus request', () => {
    useAppStore.setState({ selectedProjectId: 'p1' })
    useAppStore.getState().openOutputItem({ projectId: 'p1', outputId: 'out_1' })
    expect(useAppStore.getState().view).toBe('outputs')
    expect(useAppStore.getState().outputsFocus).toEqual({ projectId: 'p1', outputId: 'out_1' })
    useAppStore.getState().clearOutputsFocus()
    expect(useAppStore.getState().outputsFocus).toBeNull()
  })
})
