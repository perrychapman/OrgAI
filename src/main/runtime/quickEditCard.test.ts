import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { PermissionSuggestion } from '@shared/types'
import { QUICK_SESSION_EDIT_LABEL, editHasDotSegment, editHasMove, editInputAt, quickEditCard, quickEditFree } from './quickEditCard'
import { hasDotSegment } from '../quick/sessionEdits'
import { runSummary } from './testHelpers'

const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-quick-card-')))
mkdirSync(join(folder, 'sub'))
afterAll(() => rmSync(folder, { recursive: true, force: true }))
const quickRun = runSummary({ projectId: 'quick', quick: { folder, team: 'single', allowEdits: false, gitRepo: false } })
const addDirs: PermissionSuggestion = { type: 'addDirectories', directories: ['/x'], destination: 'session' }

describe('quickEditCard', () => {
  it('adds the quick session edit suggestion and its label for a covered edit, keeping the provider list apart', () => {
    const provider = [addDirs]
    const card = quickEditCard(quickRun, 'Edit', { file_path: join(folder, 'a.md') }, folder, provider)
    expect(card.quick).toBe(true)
    expect(card.suggestions).toEqual([addDirs, { type: 'setMode', mode: 'acceptEdits', destination: 'session' }])
    expect(card.ruleLabels).toEqual(['Edits and reads in /x', QUICK_SESSION_EDIT_LABEL])
    expect(provider).toEqual([addDirs])
  })

  it('offers nothing extra outside the folder, under .git or .claude, for a command, or on a non-quick run', () => {
    for (const [tool, input] of [
      ['Edit', { file_path: join(folder, '..', 'out.md') }],
      ['Edit', { file_path: join(folder, '.git', 'config') }],
      ['Write', { file_path: join(folder, '.claude', 'settings.json') }],
      ['Bash', { command: 'npm test' }]
    ] as const) {
      expect(quickEditCard(quickRun, tool, input, folder, []).quick, `${tool} ${JSON.stringify(input)}`).toBe(false)
    }
    const build = runSummary({ buildWorkspace: folder })
    expect(quickEditCard(build, 'Edit', { file_path: join(folder, 'a.md') }, folder, []).suggestions).toEqual([])
  })

  it('resolves relative targets against the cwd (Claude file_path, Codex changes[].path)', () => {
    expect(editInputAt({ file_path: 'a.md', old_string: 'x' }, folder)).toEqual({ file_path: join(folder, 'a.md'), old_string: 'x' })
    expect(editInputAt({ changes: [{ path: 'sub/b.md', kind: 'add' }] }, folder)).toEqual({ changes: [{ path: join(folder, 'sub/b.md'), kind: 'add' }] })
    // A relative path from a cwd outside the folder is judged where it really lands.
    const outside = realpathSync.native(tmpdir())
    expect(quickEditCard(quickRun, 'Edit', { file_path: 'a.md' }, outside, []).quick).toBe(false)
  })

  it('quickEditFree needs the session flag and a covered target', () => {
    const on = { run: quickRun, quickSessionEdits: () => true }
    expect(quickEditFree(on, 'Edit', { file_path: join(folder, 'sub', 'b.md') }, folder)).toBe(true)
    expect(quickEditFree({ run: quickRun, quickSessionEdits: () => false }, 'Edit', { file_path: join(folder, 'b.md') }, folder)).toBe(false)
    expect(quickEditFree({ run: quickRun }, 'Edit', { file_path: join(folder, 'b.md') }, folder)).toBe(false)
    expect(quickEditFree(on, 'Edit', { file_path: join(folder, '.git', 'HEAD') }, folder)).toBe(false)
    expect(quickEditFree(on, 'Edit', { changes: [{ path: join(folder, 'a.md') }], grantRoot: folder }, folder)).toBe(false)
    expect(quickEditFree(on, 'Bash', { command: 'echo hi > a.md' }, folder)).toBe(false)
  })

  it('never covers or offers the grant for a change that moves its file, wherever it goes (review H1)', () => {
    const on = { run: quickRun, quickSessionEdits: () => true }
    const src = join(folder, 'a.md')
    // Sanity: the same change without a move is covered.
    expect(quickEditFree(on, 'Edit', { changes: [{ path: src, kind: 'update' }] }, folder)).toBe(true)
    for (const change of [
      { path: src, kind: 'update', movePath: join(realpathSync.native(tmpdir()), '.bashrc') },
      { path: src, kind: 'update', movePath: join(folder, '.claude', 'settings.json') },
      // Even a destination inside the folder, a relative one, a malformed '' or the raw Codex shape.
      { path: src, kind: 'update', movePath: join(folder, 'sub', 'b.md') },
      { path: src, kind: 'update', movePath: 'b.md' },
      { path: src, kind: 'update', movePath: '' },
      { path: src, kind: { type: 'update', move_path: join(folder, 'b.md') } },
      { path: src, move_path: join(folder, 'b.md') }
    ]) {
      const input = { file_path: src, changes: [{ path: join(folder, 'ok.md'), kind: 'update' }, change] }
      expect(quickEditFree(on, 'Edit', input, folder), JSON.stringify(change)).toBe(false)
      const card = quickEditCard(quickRun, 'Edit', input, folder, [])
      expect(card.quick, JSON.stringify(change)).toBe(false)
      expect(card.ruleLabels).not.toContain(QUICK_SESSION_EDIT_LABEL)
    }
    // A null move is no move here (what quick/sessionEdits.ts decides for it is its own business).
    expect(editHasMove({ changes: [{ path: src, kind: { type: 'update', move_path: null } }] })).toBe(false)
    expect(editHasMove({ changes: [{ path: src, kind: { type: 'update', move_path: 'x' } }] })).toBe(true)
    expect(editHasMove({ file_path: src })).toBe(false)
    // editInputAt resolves a relative destination like a path.
    expect(editInputAt({ changes: [{ path: 'a.md', movePath: 'b.md' }] }, folder)).toEqual({ changes: [{ path: join(folder, 'a.md'), movePath: join(folder, 'b.md') }] })
  })

  describe('raw `.` / `..` segments (review NH1)', () => {
    const on = { run: quickRun, quickSessionEdits: () => true }
    const refused = (input: unknown, cwd = folder): void => {
      expect(editHasDotSegment(input), JSON.stringify(input)).toBe(true)
      expect(quickEditFree(on, 'Edit', input, cwd), JSON.stringify(input)).toBe(false)
      const card = quickEditCard(quickRun, 'Edit', input, cwd, [])
      expect(card.quick, JSON.stringify(input)).toBe(false)
      expect(card.ruleLabels).not.toContain(QUICK_SESSION_EDIT_LABEL)
    }
    // Raw string concatenation, never join (join would collapse the segment before the check sees it).
    const raw = (...parts: string[]): string => [folder, ...parts].join('/')

    it('refuses a dot segment in file_path or notebook_path, absolute or relative, either separator', () => {
      // Each of these resolves lexically to a file inside the folder, so only the raw check refuses it.
      refused({ file_path: raw('sub', '..', 'b.md') })
      refused({ file_path: raw('.', 'x.md') })
      refused({ file_path: `${folder}\\sub\\..\\b.md` })
      refused({ notebook_path: raw('sub', '..', 'n.ipynb') })
      refused({ file_path: 'a/../b.md' })
      refused({ file_path: './x.md' })
      refused({ file_path: 'sub\\..\\b.md' })
      // A relative `..` against a cwd inside the folder (lands back in the folder lexically).
      refused({ file_path: '../b.md' }, join(folder, 'sub'))
      // Every-dot segments too (Win32 strips trailing dots).
      refused({ file_path: raw('...', 'b.md') })
    })

    it('refuses a dot segment in any Codex change path or move destination', () => {
      refused({ changes: [{ path: raw('ok.md') }, { path: raw('sub', '..', 'b.md'), kind: 'update' }] })
      refused({ changes: [{ path: 'sub/../b.md', kind: 'add' }] })
      // Move destinations (already refused as moves; the dot check covers each spelling as well).
      refused({ changes: [{ path: raw('a.md'), movePath: raw('sub', '..', 'b.md') }] })
      refused({ changes: [{ path: raw('a.md'), kind: { type: 'update', move_path: 'sub/../b.md' } }] })
      refused({ changes: [{ path: raw('a.md'), move_path: './b.md' }] })
    })

    it('keeps names that merely contain dots, and an ordinary nested relative path still resolves and is covered', () => {
      for (const p of ['a..b.md', '.hidden.md', 'x/..y/z.md', 'v1.2/notes.md', '..md']) expect(hasDotSegment(p), p).toBe(false)
      expect(editHasDotSegment({ file_path: raw('sub', 'b.md') })).toBe(false)
      expect(editHasDotSegment({ command: '../x' })).toBe(false)
      expect(editInputAt({ file_path: 'sub/b.md' }, folder)).toEqual({ file_path: join(folder, 'sub/b.md') })
      expect(quickEditFree(on, 'Edit', { file_path: 'sub/b.md' }, folder)).toBe(true)
      expect(quickEditFree(on, 'Edit', { changes: [{ path: 'sub/b.md', kind: 'add' }] }, folder)).toBe(true)
      expect(quickEditCard(quickRun, 'Edit', { file_path: 'sub/b.md' }, folder, []).quick).toBe(true)
    })

    it('refuses `<folder>/vendor/../x` where vendor is a link out of the folder', () => {
      const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-quick-card-out-')))
      mkdirSync(join(outside, 'sub'))
      try {
        try {
          symlinkSync(join(outside, 'sub'), join(folder, 'vendor'), 'junction')
        } catch {
          return
        }
        // Lexically this is <folder>/x.md; the kernel follows vendor first and lands in <outside>/x.md.
        refused({ file_path: raw('vendor', '..', 'x.md') })
      } finally {
        // rm never follows a link (lstat), so this removes the link only.
        rmSync(join(folder, 'vendor'), { force: true, recursive: true })
        rmSync(outside, { recursive: true, force: true })
      }
    })
  })
})
