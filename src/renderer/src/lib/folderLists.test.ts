import { describe, expect, it } from 'vitest'
import {
  WORKING_FOLDER_REFUSAL,
  droppedExtrasMessage,
  firstWorkingFolderConflict,
  folderConflict,
  folderDraftProblem,
  foldersSummary,
  moveConfirmCopy,
  moveFolder,
  workingFolderProblem,
  workingFolderRelation
} from './folderLists'

describe('working folder relation', () => {
  it('finds equal, inside and containing folders on POSIX paths', () => {
    expect(workingFolderRelation('/w/', '/w')).toBe('same')
    expect(workingFolderRelation('/w/a/b', '/w')).toBe('inside')
    expect(workingFolderRelation('/', '/w')).toBe('contains')
    expect(workingFolderRelation('/x', '/w')).toBeNull()
    expect(workingFolderRelation('/W/a', '/w')).toBeNull()
  })
  it('ignores case and separator style on Windows paths', () => {
    expect(workingFolderRelation('c:/WORK/', 'C:\\work')).toBe('same')
    expect(workingFolderRelation('C:\\Work\\Sub\\', 'c:\\work')).toBe('inside')
    expect(workingFolderRelation('C:\\', 'C:\\work')).toBe('contains')
    expect(workingFolderRelation('D:\\work', 'C:\\work')).toBeNull()
  })
  it('does not count a sibling with a shared prefix', () => {
    expect(workingFolderRelation('C:\\work2', 'C:\\work')).toBeNull()
    expect(workingFolderRelation('C:\\work', 'C:\\work2')).toBeNull()
    expect(workingFolderRelation('/w2', '/w')).toBeNull()
  })
  it('words the refusals for each kind', () => {
    expect(workingFolderProblem('/p', '/p', 'code')).toBe('This is the project folder. Agents can already change files in it.')
    expect(workingFolderProblem('/', '/p', 'code')).toBe('This folder contains the project folder. Pick a folder outside it.')
    expect(workingFolderProblem('/p/x', '/p', 'engagement')).toMatch(/inside the working folder/)
    expect(WORKING_FOLDER_REFUSAL).toBe('This is the working folder. Agents can already change files in it.')
  })
  it('finds the first conflicting reference folder', () => {
    expect(firstWorkingFolderConflict(['/a', '/w/x', '/'], '/w')).toMatchObject({ path: '/w/x' })
    expect(firstWorkingFolderConflict(['/a'], '/w')).toBeNull()
  })
})

describe('droppedExtrasMessage', () => {
  it('is null when everything was kept', () => {
    expect(droppedExtrasMessage(['/a'], { referenceDirectories: ['/a/'], client: 'Acme' }, 'Acme')).toBeNull()
    expect(droppedExtrasMessage([], {}, undefined)).toBeNull()
  })
  it('names dropped folders and a dropped client', () => {
    expect(droppedExtrasMessage(['/a', '/b'], { referenceDirectories: ['/a'] })).toMatch(/did not keep these folders: \/b\./)
    expect(droppedExtrasMessage([], {}, 'Acme')).toBe('OrgAI did not keep the client name.')
  })
})

describe('folderLists', () => {
  it('refuses the working folder in either card', () => {
    expect(workingFolderProblem('/work/client', '/work/client/')).toBe(WORKING_FOLDER_REFUSAL)
    expect(workingFolderProblem('/work/client/sub', '/work/client')).toBe('This folder is inside the working folder. Reference folders must be outside it.')
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
