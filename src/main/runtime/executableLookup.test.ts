import { describe, expect, it } from 'vitest'
import { asarResourcesOf, fileKindOf, filesOnPath, pathDirectories, unpackedAsarPath } from './executableLookup'
import { ELF, FakeLookupFs, MACHO, PE } from './fakeLookupFs'

describe('executableLookup', () => {
  it('PATH directories: absolute only, never the cwd, no UNC on Windows, each once', () => {
    expect(pathDirectories({ PATH: '/a::.:rel:/b:/a' }, 'darwin')).toEqual(['/a', '/b'])
    expect(pathDirectories({ Path: '"C:\\A";;.;\\\\srv\\share;C:\\a;D:/b;\\root' }, 'win32')).toEqual(['C:\\A', 'D:/b'])
    expect(pathDirectories({}, 'linux')).toEqual([])
  })

  it('filesOnPath lists regular files folder by folder, names in order', () => {
    const fs = new FakeLookupFs({ '/a/x.cmd': '', '/a/x.exe': '', '/b/x.exe': '' }, ['/a/dir'])
    expect(filesOnPath(['x.exe', 'x.cmd', 'dir'], { PATH: '/a:/b' }, 'linux', fs)).toEqual(['/a/x.exe', '/a/x.cmd', '/b/x.exe'])
  })

  it('classifies by content: Mach-O, ELF and PE are native, #! is a script, the rest is other', () => {
    expect(fileKindOf(MACHO)).toBe('native')
    expect(fileKindOf(Uint8Array.from([0xca, 0xfe, 0xba, 0xbe]))).toBe('native')
    expect(fileKindOf(ELF)).toBe('native')
    expect(fileKindOf(PE)).toBe('native')
    expect(fileKindOf(new TextEncoder().encode('#!/bin/sh'))).toBe('script')
    expect(fileKindOf(new TextEncoder().encode('@ECHO off'))).toBe('other')
    expect(fileKindOf(undefined)).toBe('other')
  })

  it('finds the resources folder of a packaged app and rewrites app.asar to app.asar.unpacked', () => {
    expect(asarResourcesOf('/A/OrgAI.app/Contents/Resources/app.asar/out/main', 'darwin')).toBe('/A/OrgAI.app/Contents/Resources')
    expect(asarResourcesOf('C:\\P\\resources\\app.asar.unpacked\\out\\cli', 'win32')).toBe('C:\\P\\resources')
    expect(asarResourcesOf('/x/app.asar.bak/out', 'darwin')).toBeUndefined()
    expect(unpackedAsarPath('/R/app.asar/node_modules/p')).toEqual({ path: '/R/app.asar.unpacked/node_modules/p', rewritten: true })
    expect(unpackedAsarPath('C:\\R\\app.asar\\node_modules\\p')).toEqual({ path: 'C:\\R\\app.asar.unpacked\\node_modules\\p', rewritten: true })
    expect(unpackedAsarPath('/R/app.asar.unpacked/node_modules/p')).toEqual({ path: '/R/app.asar.unpacked/node_modules/p', rewritten: false })
  })
})
