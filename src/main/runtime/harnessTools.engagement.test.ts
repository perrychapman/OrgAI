import { describe, expect, it } from 'vitest'
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
    expect(await tool.call(archArgs)).toContain('The engagement charter was saved and written to .orgai/ENGAGEMENT.md')
  })
})
