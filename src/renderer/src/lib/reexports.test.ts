import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as runStatus from './runStatus'
import * as pendingCards from './pendingCards'
import * as needsYou from './needsYou'
import * as cost from './cost'
import * as paths from './paths'
import * as settingsCopy from './settingsCopy'
import { formatTokens as layoutFormatTokens } from './layout'
import { connectorHue, connectorInitial } from './connectors'
import * as sharedCost from '@shared/view/cost'
import * as sharedMarks from '@shared/view/connectorMarks'

const STUB_MODULES = import.meta.glob('./*.ts')
const SHARED_MODULES = import.meta.glob('../../../shared/view/*.ts')

/**
 * The runtime export names of every renderer lib stub (`export * from '@shared/view/<name>'`), pinned (H6 of the PR #18
 * review): a dropped export fails the test instead of passing because "something is exported". Update the list together
 * with the shared module when an export is added or removed on purpose.
 */
const EXPECTED_EXPORTS: Readonly<Record<string, readonly string[]>> = {
  clampLabel: [
    'clampLabel'
  ],
  cost: [
    'COST_TITLES', 'agentCostInput', 'costView', 'formatDuration', 'formatTokens', 'formatUsd', 'runCostInput',
    'sumCosts', 'unpricedModels'
  ],
  dates: [
    'formatDate', 'formatDateTime', 'formatFullDateTime'
  ],
  decisionTitle: [
    'PROPOSAL_KIND_LABEL', 'baseName', 'installTitle', 'isCdSegment', 'isHiddenCommand', 'mergeTitle', 'oneLine',
    'permissionTitle', 'proposalKindLabel', 'proposalTitle', 'questionTitle', 'rulesTitle', 'shellAction',
    'shellSegments'
  ],
  hiddenChars: [
    'HIDDEN_CHARS', 'HIDDEN_CLASS', 'HIDDEN_OR_CONTROL_RUN', 'hasHidden', 'showHidden'
  ],
  knowledge: [
    'EMPTY_FILTER', 'NOTE_KIND', 'applyFilter', 'clearCountsLine', 'countLine', 'factsInOrder', 'groupItems',
    'historyLines', 'idAfterRemoval', 'isFilterActive', 'itemCreatedAt', 'itemExcerpt', 'itemKind', 'itemName',
    'itemOrigin', 'itemRetired', 'itemSource', 'itemsOf', 'keyWords', 'kindColor', 'kindCounts', 'kindGroupLabel',
    'kindLabel', 'kindMark', 'kindOrder', 'knowledgeSummaryLine', 'orderItems', 'originCounts', 'provenanceLine',
    'relatedRows', 'resolveFocus', 'roleWord', 'runNamesOf', 'searchItems', 'searchRank', 'sentenceCase', 'sourceOf',
    'splitHistoryLine'
  ],
  mcpProposal: [
    'SKIP_MCP_FEEDBACK', 'classifyUpsert', 'codeLoadingEnv', 'diffMcpProposal', 'effectLine', 'mcpApplyNote',
    'mcpFieldChanges', 'mcpRowVerb', 'mcpServerHidden', 'mcpSummaryLine', 'newEffectLine', 'pinState',
    'proposalCommand', 'proposalEffectCopy', 'proposalScope', 'proposalSource', 'proposalTarget', 'remoteHost',
    'removalLabels', 'roleNames', 'secretSlotNames', 'secretsHelp', 'secretsLine', 'targetText', 'toggleDirection',
    'toggleLine', 'uniqueSecretSlots', 'upsertAction', 'whoCanUse', 'whoCanUseChange'
  ],
  mcpVersion: [
    'isPinnedVersion', 'pinnedVersionOf'
  ],
  needsYou: [
    'decisionCount', 'defaultDecisionIndex', 'defaultRunToOpen', 'waitingItems'
  ],
  orgDiff: [
    'RENAME_SIMILARITY', 'diffOrgChart', 'diffSummary', 'modelDisplay', 'nameSimilarity', 'promptChange',
    'responsibilitiesChange'
  ],
  paths: [
    'abbreviatePath', 'folderName'
  ],
  pendingCards: [
    'mergeById', 'mergePendingCards'
  ],
  permissionCopy: [
    'PERMISSION_MODE_TRADEOFF', 'REFERENCE_EFFECT', 'REFERENCE_EFFECT_TOOL', 'RULE_FORMAT_HINT',
    'SINGLE_SLASH_REASON', 'allowedFolderDraftProblem', 'checkRuleDraft', 'collapseRules', 'droppedFolderNotice',
    'droppedFolders', 'isAbsolutePath', 'isInsidePath', 'mcpServerOf', 'noRuleLine', 'normalizePath', 'parentPath',
    'pathKey', 'permissionLocation', 'permissionOffer', 'referenceEffect', 'referenceLocation', 'relativePath',
    'resolvePath', 'ruleChip', 'ruleInfo', 'ruleSubject', 'rulesApplyInMode', 'scopeCopy'
  ],
  roleServices: [
    'serviceFor', 'servicesForRole'
  ],
  runChains: [
    'CHAIN_EAGER_MEMBERS', 'CHAIN_FETCH_CONCURRENCY', 'CHAIN_WALK_MAX_HOPS', 'adoptEndFacts', 'canContinue',
    'canContinueIn', 'chainGroups', 'chainIdsToLoad', 'chainKeyOf', 'chainOf', 'continuationDivider', 'continuedBy',
    'continuedByIn', 'earlierMembersToLoad', 'endedComposerCopy', 'gapLabel', 'isOpenStatus', 'lastActivityAt',
    'needsYou', 'newestOf', 'predecessorOf', 'projectCounts', 'relativeTime', 'runBatched', 'sessionOpenRunId',
    'statusEventEndFacts'
  ],
  runLabels: [
    'RUN_NAME_EXCERPT_CHARS', 'promptLine', 'runIndexMap', 'runName', 'runTag', 'runTitle', 'shortPrompt'
  ],
  runStatus: [
    'ENDED_WITH_APP', 'autoContinueState', 'cutWhile', 'endedByOf', 'isStoppedRun', 'runStatus', 'settleEndedAgents',
    'statusOfRun', 'statusText'
  ],
  settingsCopy: [
    'CONNECTION_NAME', 'ISOLATE_WRITERS_STATE', 'MAINTENANCE_ENGAGEMENT_LINE', 'PERMISSION_MODE_SHORT',
    'PLAN_GUARD_LINE', 'PLAN_LIMIT_PAUSE', 'RUN_MESSAGING_ENGAGEMENT_DESCRIPTION', 'SETTINGS_COPY',
    'TEAM_ASSISTANT_COPY', 'planGuardLine', 'projectKindLine', 'ruleExamples', 'rulePlaceholder', 'rulesSavedIn'
  ],
  teamView: [
    'capabilityCounts', 'capabilityLabel', 'capabilityParts', 'normalizeView'
  ],
  transcriptRows: [
    'FEED_MAX_ITEMS', 'autoContinueLine', 'bareToolName', 'humanizeToolResult', 'humanizeToolUse',
    'isContinuationNotice', 'isHarnessTool', 'mergeChainFeed', 'omittedLabel', 'rawDetails', 'resultSummary',
    'toolWords'
  ],
  usageView: [
    'WAITING_MIN_MS', 'WAITING_SHARE', 'agentRow', 'agentRows', 'agentSignals', 'formatHitRate', 'loadsWording',
    'roleRows', 'runSignals', 'skillLoadsFromTranscript', 'skillRows', 'timeRows', 'tokenRows'
  ]
}

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

  it('every stub re-exports exactly the shared module, and the shared module keeps the pinned export names', async () => {
    const libDir = dirname(fileURLToPath(import.meta.url))
    const stubs = new Map<string, string>()
    for (const f of readdirSync(libDir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      const m = /^export \* from '@shared\/view\/(\w+)'\s*$/.exec(readFileSync(join(libDir, f), 'utf8'))
      if (m) stubs.set(f.replace(/\.ts$/, ''), m[1])
    }
    // A new stub needs its names pinned below; a stub that became a real module again must leave the table.
    expect([...stubs.keys()].sort()).toEqual(Object.keys(EXPECTED_EXPORTS).sort())
    for (const [lib, shared] of stubs) {
      const stubMod = (await STUB_MODULES[`./${lib}.ts`]()) as Record<string, unknown>
      const sharedMod = (await SHARED_MODULES[`../../../shared/view/${shared}.ts`]()) as Record<string, unknown>
      const stubNames = Object.keys(stubMod).sort()
      expect(stubNames, lib).toEqual(Object.keys(sharedMod).sort())
      for (const n of stubNames) expect(stubMod[n], `${lib}.${n}`).toBe(sharedMod[n])
      // Pinned: a merge that replaces a shared body with an older one (dropping e.g. kindMark) fails here.
      expect(stubNames, lib).toEqual([...EXPECTED_EXPORTS[lib]].sort())
    }
    expect(typeof pendingCards.mergePendingCards).toBe('function')
  })
})
