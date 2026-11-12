import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { INSTALL_INFO_MAX_BYTES, readInstallInfo } from './installInfo'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-install-info-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const write = (text: string): void => writeFileSync(join(dir, 'install.json'), text)

describe('readInstallInfo (cli-standalone.md 3.5)', () => {
  it('absent file: channel dev, source absent', () => {
    expect(readInstallInfo({ bundleDir: dir })).toEqual({ channel: 'dev', source: 'absent' })
    expect(readInstallInfo({ bundleDir: join(dir, 'missing') })).toEqual({ channel: 'dev', source: 'absent' })
  })

  it('this module under vitest has no install.json beside it', () => {
    expect(readInstallInfo()).toEqual({ channel: 'dev', source: 'absent' })
  })

  it('reads each written channel with version and commit', () => {
    for (const channel of ['npm', 'app', 'archive'] as const) {
      write(JSON.stringify({ channel, version: '0.1.6-dev1', commit: 'abc1234' }))
      expect(readInstallInfo({ bundleDir: dir })).toEqual({ channel, version: '0.1.6-dev1', commit: 'abc1234', source: 'file' })
    }
    write('﻿{"channel":"npm"}')
    expect(readInstallInfo({ bundleDir: dir })).toEqual({ channel: 'npm', source: 'file' })
  })

  it('an invalid file is dev with source invalid and a problem, never absent', () => {
    for (const text of ['nope', '[]', '{}', '{"channel":"dev"}', '{"channel":"npm","version":5}', '{"channel":"npm","commit":"a b"}', '{"channel":"npm","version":"-x"}']) {
      write(text)
      const info = readInstallInfo({ bundleDir: dir })
      expect(info.channel, text).toBe('dev')
      expect(info.source, text).toBe('invalid')
      expect(info.problem, text).toBeTruthy()
    }
    write(JSON.stringify({ channel: 'npm', pad: 'x'.repeat(INSTALL_INFO_MAX_BYTES) }))
    expect(readInstallInfo({ bundleDir: dir })).toMatchObject({ channel: 'dev', source: 'invalid' })
  })

  it('a folder or a link named install.json is invalid', () => {
    mkdirSync(join(dir, 'install.json'))
    expect(readInstallInfo({ bundleDir: dir })).toMatchObject({ source: 'invalid' })
    rmSync(join(dir, 'install.json'), { recursive: true })
    const target = join(dir, 'real.json')
    writeFileSync(target, '{"channel":"npm"}')
    try {
      symlinkSync(target, join(dir, 'install.json'))
    } catch {
      return // symlinks need privileges on some Windows setups
    }
    expect(readInstallInfo({ bundleDir: dir })).toMatchObject({ source: 'invalid' })
  })
})
