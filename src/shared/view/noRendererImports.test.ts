import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The view-models here are shared with the CLI / TUI (cli-spec 2.3): they must compile and run without the
// renderer, React, zustand, dagre, React Flow or DOM globals.
const dir = fileURLToPath(new URL('.', import.meta.url))
const sources = readdirSync(dir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }))

const FORBIDDEN_IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)['"](@renderer(?:\/[^'"]*)?|react(?:\/[^'"]*)?|react-dom(?:\/[^'"]*)?|zustand(?:\/[^'"]*)?|@dagrejs\/dagre|@xyflow\/[^'"]*)['"]/
const DOM_GLOBAL = /\bdocument\.|\blocalStorage\b|\bnavigator\./

describe('src/shared/view stays renderer-free', () => {
  it('has the moved view-models', () => {
    const names = sources.map((s) => s.file)
    for (const n of ['runStatus.ts', 'runChains.ts', 'viewPendingCards.ts', 'needsYou.ts', 'orgDiff.ts', 'mcpProposal.ts', 'transcriptRows.ts', 'usageView.ts', 'cost.ts', 'teamView.ts', 'permissionCopy.ts']) {
      expect(names).toContain(n)
    }
  })

  it('imports nothing from the renderer, React, zustand, dagre or React Flow', () => {
    const bad = sources.filter((s) => FORBIDDEN_IMPORT.test(s.text)).map((s) => s.file)
    expect(bad).toEqual([])
  })

  it('references no DOM globals', () => {
    const bad = sources.filter((s) => DOM_GLOBAL.test(s.text)).map((s) => s.file)
    expect(bad).toEqual([])
  })

  it('the scan catches what it should', () => {
    expect(FORBIDDEN_IMPORT.test("import { x } from '@renderer/lib/a'")).toBe(true)
    expect(FORBIDDEN_IMPORT.test("import dagre from '@dagrejs/dagre'")).toBe(true)
    expect(FORBIDDEN_IMPORT.test("import { useState } from 'react'")).toBe(true)
    expect(FORBIDDEN_IMPORT.test("import { create } from 'zustand'")).toBe(true)
    expect(FORBIDDEN_IMPORT.test("import type { Node } from '@xyflow/react'")).toBe(true)
    expect(FORBIDDEN_IMPORT.test("import { a } from './reactions'")).toBe(false)
    expect(DOM_GLOBAL.test('document.title')).toBe(true)
    expect(DOM_GLOBAL.test('localStorage.getItem')).toBe(true)
    expect(DOM_GLOBAL.test('navigator.platform')).toBe(true)
    expect(DOM_GLOBAL.test("document: 'Documents'")).toBe(false)
  })
})
