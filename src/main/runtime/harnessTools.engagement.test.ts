import { describe, expect, it, vi } from 'vitest'
import { PROPOSAL_TOOLS } from '@shared/setup'
import { harnessToolsFor, setupTools, type HarnessTool } from './harnessTools'
import { fakeCtx, project, runSummary } from './testHelpers'

const byName = (tools: HarnessTool[], name: string): HarnessTool => {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

const archArgs = {
  title: 'Charter',
  summary: 'S',
  stack: ['A platform'],
  modules: [{ name: 'stream', purpose: 'p', paths: ['work'] }],
  conventions: [],
  commands: [],
  risks: []
}

describe('harness tools per project kind', () => {
  const eng = () => fakeCtx({ project: project({ kind: 'engagement' }), run: runSummary({ kind: 'work' }) })

  it('code projects keep the verification wording', () => {
    const tools = harnessToolsFor(fakeCtx({ run: runSummary({ kind: 'work' }) }))
    expect(byName(tools, 'set_plan').description).toContain('the last step is verification: build and tests, then the final report')
    expect(byName(tools, 'complete_plan').description).toContain('done and verified (build and tests pass)')
  })

  it('engagements end the plan in a deliverable review', () => {
    const tools = harnessToolsFor(eng())
    expect(byName(tools, 'set_plan').description).toContain('the last step is a review of the deliverables against the brief, then the final report')
    expect(byName(tools, 'set_plan').description).not.toContain('build and tests')
    expect(byName(tools, 'complete_plan').description).toBe('Mark the plan complete once every step is done and the deliverables were reviewed. Ends the automatic continuation.')
  })

  it('propose_architecture names the right document in its result and description', async () => {
    const codeText = await byName(setupTools(fakeCtx()), PROPOSAL_TOOLS.architecture).call(archArgs)
    expect(codeText).toContain('The architecture was saved and written to .orgai/ARCHITECTURE.md')
    const ctx = fakeCtx({ project: project({ kind: 'engagement' }) })
    const tool = byName(setupTools(ctx), PROPOSAL_TOOLS.architecture)
    expect(tool.description).toMatch(/engagement charter/)
    const text = await tool.call(archArgs)
    expect(text).toContain('The engagement document was saved in OrgAI (nothing is written to the working folder). Continue with the org chart.')
    expect(text).not.toContain('.orgai')
  })

  it('propose_settings carries a trimmed client, refuses hidden characters and drops isolateWriters for engagements', async () => {
    const ctx = fakeCtx({ project: project({ kind: 'engagement' }) })
    const tool = byName(setupTools(ctx), PROPOSAL_TOOLS.settings)
    const base = { title: 'S', rationale: 'r', brief: 'b' }
    expect(await tool.call({ ...base, client: '  Northwind Ltd  ', isolateWriters: true })).toContain('settings were applied')
    const sent = vi.mocked(ctx.requestProposal).mock.calls[0][0] as unknown as { payload: Record<string, unknown> }
    expect(sent.payload.client).toBe('Northwind Ltd')
    expect('isolateWriters' in sent.payload).toBe(false)
    expect(await tool.call({ ...base, client: 'North​wind' })).toMatch(/^REVISE\. .*client contains a hidden character/)
    await expect(tool.call({ ...base, client: 'x'.repeat(121) })).rejects.toThrow()
    expect(ctx.requestProposal).toHaveBeenCalledTimes(1)
  })
})
