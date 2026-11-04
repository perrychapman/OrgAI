import { describe, expect, it } from 'vitest'
import { WORKING_FOLDER_REFUSAL, folderConflict, folderDraftProblem, foldersSummary, moveConfirmCopy, moveFolder, workingFolderProblem } from './folderLists'

describe('folderLists', () => {
  it('refuses the working folder in either card', () => {
    expect(workingFolderProblem('/work/client', '/work/client/')).toBe(WORKING_FOLDER_REFUSAL)
    expect(workingFolderProblem('/work/client/sub', '/work/client')).toBeNull()
    expect(folderDraftProblem('/work/client', [], '/work/client')).toBe(WORKING_FOLDER_REFUSAL)
    expect(folderDraftProblem('', [], '/work/client')).toMatch(/Enter a folder/)
    expect(folderDraftProblem('/a', ['/a'], '/work/client')).toMatch(/already listed/)
  })
  it('finds a folder in the other list', () => {
    expect(folderConflict('/a/b', ['/x', '/a/b'])).toBe('/a/b')
    expect(folderConflict('/a/c', ['/x', '/a/b'])).toBeNull()
  })
  it('moves a folder once, leaving the source list', () => {
    expect(moveFolder(['/a', '/b'], ['/c'], '/a')).toEqual({ from: ['/b'], to: ['/c', '/a'] })
    expect(moveFolder(['/a'], ['/a', '/c'], '/a')).toEqual({ from: [], to: ['/c', '/a'] })
  })
  it('words the confirm for each direction', () => {
    expect(moveConfirmCopy('reference', '/a').title).toBe('Make it read only?')
    expect(moveConfirmCopy('allowed', '/a').title).toBe('Allow changes to it?')
  })
  it('counts both lists', () => {
    expect(foldersSummary(null, 0)).toBeNull()
    expect(foldersSummary(0, 0)).toBe('None yet. Approval cards add them here.')
    expect(foldersSummary(3, 1)).toBe('3 rules and 1 folder you allowed')
    expect(foldersSummary(0, 1)).toBe('1 folder you allowed')
    expect(foldersSummary(0, 1, 2)).toBe('2 reference folders, 1 folder you allowed')
    expect(foldersSummary(0, 0, 1)).toBe('1 reference folder')
    expect(foldersSummary(2, 2, 1)).toBe('2 rules, 1 reference folder, 2 folders you allowed')
  })
})
