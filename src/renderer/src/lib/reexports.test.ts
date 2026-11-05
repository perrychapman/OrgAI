import { describe, expect, it } from 'vitest'
import * as runStatus from './runStatus'
import * as runChains from './runChains'
import * as pendingCards from './pendingCards'
import * as needsYou from './needsYou'
import * as orgDiff from './orgDiff'
import * as mcpProposal from './mcpProposal'
import * as transcriptRows from './transcriptRows'
import * as usageView from './usageView'
import * as cost from './cost'
import * as teamView from './teamView'
import * as permissionCopy from './permissionCopy'
import * as decisionTitle from './decisionTitle'
import * as hiddenChars from './hiddenChars'
import * as mcpVersion from './mcpVersion'
import * as clampLabel from './clampLabel'
import * as knowledge from './knowledge'
import * as dates from './dates'
import * as runLabels from './runLabels'
import * as roleServices from './roleServices'
import * as paths from './paths'
import * as settingsCopy from './settingsCopy'
import { formatTokens as layoutFormatTokens } from './layout'
import { connectorHue, connectorInitial } from './connectors'
import * as sharedCost from '@shared/view/cost'
import * as sharedMarks from '@shared/view/connectorMarks'

// The renderer lib paths are thin re-exports of src/shared/view (cli-spec 2.3); callers keep their import paths.
describe('renderer lib re-exports of the shared view-models', () => {
  it('exposes the key symbols', () => {
    expect(typeof runStatus.statusText).toBe('function')
    expect(typeof needsYou.waitingItems).toBe('function')
    expect(typeof cost.costView).toBe('function')
    expect(typeof cost.formatTokens).toBe('function')
    expect(typeof paths.abbreviatePath).toBe('function')
    expect(settingsCopy.PERMISSION_MODE_SHORT).toBeTypeOf('object')
    expect(connectorHue('github')).toBe(sharedMarks.connectorHue('github'))
    expect(connectorInitial({ name: 'Google Docs' })).toBe('GD')
  })

  it('layout.ts and cost.ts share one formatTokens', () => {
    expect(layoutFormatTokens).toBe(sharedCost.formatTokens)
    expect(cost.formatTokens).toBe(sharedCost.formatTokens)
    expect(layoutFormatTokens(1234)).toBe('1.2k')
  })

  it('every moved module still exports something through its lib path', () => {
    const mods = { runChains, pendingCards, orgDiff, mcpProposal, transcriptRows, usageView, teamView, permissionCopy, decisionTitle, hiddenChars, mcpVersion, clampLabel, knowledge, dates, runLabels, roleServices }
    for (const [name, mod] of Object.entries(mods)) expect(Object.keys(mod).length, name).toBeGreaterThan(0)
    expect(typeof pendingCards.mergePendingCards).toBe('function')
  })
})
