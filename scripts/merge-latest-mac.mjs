// Merges the two mac legs' electron-builder update metadata (latest-mac.yml) into one file for the GitHub release.
// node scripts/merge-latest-mac.mjs <arm64 latest-mac.yml> <x64 latest-mac.yml> <out path>
// No npm dependencies (the release publish job runs without `npm ci`): a small strict parser for exactly the shape
// electron-builder writes (top-level scalars, a `files:` list of maps of scalars). Anything else fails closed: a
// non-zero exit and nothing written. electron-updater's MacUpdater picks the file for the running arch out of `files`.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._+~%-]*$/
const SAFE_PLAIN = /^[A-Za-z0-9][A-Za-z0-9._+/=-]*$/
const BARE_KEYS = new Set(['size', 'blockMapSize', 'isAdminRightsRequired'])

function fail(msg) {
  throw new Error(msg)
}

/** One scalar: single-quoted, double-quoted (only \\ and \" escapes) or plain. Returns a string. */
function parseScalar(raw, where) {
  const s = raw.trim()
  if (s === '') fail(`${where}: empty value`)
  if (s[0] === "'") {
    if (s.length < 2 || s[s.length - 1] !== "'") fail(`${where}: unterminated single-quoted scalar`)
    const inner = s.slice(1, -1)
    if (/'(?!')/.test(inner.replace(/''/g, ''))) fail(`${where}: stray quote in scalar`)
    return inner.replace(/''/g, "'")
  }
  if (s[0] === '"') {
    if (s.length < 2 || s[s.length - 1] !== '"') fail(`${where}: unterminated double-quoted scalar`)
    const inner = s.slice(1, -1)
    let out = ''
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i]
      if (c === '"') fail(`${where}: stray quote in scalar`)
      if (c === '\\') {
        const n = inner[++i]
        if (n !== '\\' && n !== '"') fail(`${where}: unsupported escape in scalar`)
        out += n
      } else out += c
    }
    return out
  }
  if (/^[[\]{}&*!|>%@`#,?-]/.test(s) && !/^-?[0-9]/.test(s)) fail(`${where}: unsupported syntax "${s}"`)
  if (/:(\s|$)/.test(s) || /\s#/.test(s)) fail(`${where}: unsupported syntax "${s}"`)
  return s
}

/** Parses an update-info YAML into { top: {key: string}, files: [{key: string}] }. */
export function parseUpdateYaml(text) {
  if (typeof text !== 'string' || text.trim() === '') fail('empty file')
  const top = {}
  const files = []
  let inFiles = false
  let filesSeen = false
  let item = null
  let dashIndent = -1
  const lines = text.replace(/^﻿/, '').split('\n')
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].replace(/\r$/, '')
    const where = `line ${n + 1}`
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (/\t/.test(line.match(/^\s*/)[0])) fail(`${where}: tab indentation`)
    const m = /^( *)(- )?([A-Za-z][A-Za-z0-9_]*):(?: +(.*))?$/.exec(line)
    if (!m) fail(`${where}: unsupported syntax "${line.trim()}"`)
    const [, indentStr, dash, key, rest] = m
    const indent = indentStr.length
    if (indent === 0 && !dash) {
      inFiles = false
      item = null
      if (key in top) fail(`${where}: duplicate key ${key}`)
      if (key === 'files') {
        if (rest !== undefined && rest.trim() !== '') fail(`${where}: files must be a block list`)
        if (filesSeen) fail(`${where}: duplicate key files`)
        filesSeen = true
        inFiles = true
        dashIndent = -1
        top.files = ''
        continue
      }
      if (rest === undefined || rest.trim() === '') fail(`${where}: key ${key} has no scalar value`)
      top[key] = parseScalar(rest, where)
      continue
    }
    if (!inFiles) fail(`${where}: indented content outside files`)
    if (rest === undefined || rest.trim() === '') fail(`${where}: key ${key} has no scalar value`)
    if (dash) {
      if (dashIndent === -1) dashIndent = indent
      if (indent !== dashIndent) fail(`${where}: inconsistent list indentation`)
      item = {}
      files.push(item)
    } else {
      if (!item) fail(`${where}: map entry before a list item`)
      if (indent !== dashIndent + 2) fail(`${where}: inconsistent list item indentation`)
    }
    if (key in item) fail(`${where}: duplicate key ${key} in a file entry`)
    item[key] = parseScalar(rest, where)
  }
  delete top.files
  return { top, files }
}

function checkName(name, where) {
  if (typeof name !== 'string' || !PLAIN_NAME.test(name) || name.includes('..') || /[\\/]/.test(name)) {
    fail(`${where}: "${name}" is not a plain file name`)
  }
}

function checkLeg(leg, arch, label) {
  const { top, files } = leg
  if (!top.version) fail(`${label}: version is missing`)
  if (!SEMVER.test(top.version)) fail(`${label}: version "${top.version}" is not semver`)
  if (!top.releaseDate || Number.isNaN(Date.parse(top.releaseDate))) fail(`${label}: releaseDate is missing or invalid`)
  if (files.length === 0) fail(`${label}: no files`)
  const seen = new Set()
  for (const f of files) {
    if (!f.url) fail(`${label}: a file entry has no url`)
    checkName(f.url, `${label} url`)
    if (!f.sha512) fail(`${label}: ${f.url} has no sha512`)
    if (seen.has(f.url)) fail(`${label}: duplicate url ${f.url}`)
    seen.add(f.url)
  }
  const arm = files.filter((f) => f.url.includes('arm64'))
  if (arch === 'arm64' && arm.length === 0) fail(`${label}: no url contains arm64`)
  if (arch === 'x64' && arm.length > 0) fail(`${label}: contains an arm64 url (${arm[0].url})`)
}

/** Merges two parsed legs. Pure; throws on anything inconsistent. */
export function mergeLatestMac(arm64, x64) {
  checkLeg(arm64, 'arm64', 'arm64 leg')
  checkLeg(x64, 'x64', 'x64 leg')
  if (arm64.top.version !== x64.top.version) {
    fail(`versions differ: arm64 ${arm64.top.version}, x64 ${x64.top.version}`)
  }
  const urls = new Set(arm64.files.map((f) => f.url))
  for (const f of x64.files) if (urls.has(f.url)) fail(`url ${f.url} appears in both legs`)
  if (!x64.top.path) fail('x64 leg: path is missing')
  checkName(x64.top.path, 'x64 leg path')
  if (!x64.top.sha512) fail('x64 leg: sha512 is missing')
  const later = Date.parse(arm64.top.releaseDate) > Date.parse(x64.top.releaseDate) ? arm64.top.releaseDate : x64.top.releaseDate
  return {
    top: { version: x64.top.version, path: x64.top.path, sha512: x64.top.sha512, releaseDate: later },
    files: [...arm64.files, ...x64.files].map((f) => ({ ...f }))
  }
}

function emitScalar(key, value) {
  if (BARE_KEYS.has(key) && (/^[0-9]+$/.test(value) || /^(true|false)$/.test(value))) return value
  const ambiguous = /^(true|false|null|yes|no|on|off|y|n|~)$/i.test(value) || /^[-+]?[0-9.]+(e[-+]?[0-9]+)?$/i.test(value)
  if (SAFE_PLAIN.test(value) && !ambiguous) return value
  return `'${value.replace(/'/g, "''")}'`
}

/** Serializes a merged document as YAML that js-yaml (electron-updater) parses. */
export function serializeUpdateYaml(doc) {
  const out = [`version: ${emitScalar('version', doc.top.version)}`, 'files:']
  for (const f of doc.files) {
    const keys = Object.keys(f)
    keys.forEach((k, i) => out.push(`${i === 0 ? '  - ' : '    '}${k}: ${emitScalar(k, f[k])}`))
  }
  out.push(`path: ${emitScalar('path', doc.top.path)}`)
  out.push(`sha512: ${emitScalar('sha512', doc.top.sha512)}`)
  out.push(`releaseDate: '${doc.top.releaseDate.replace(/'/g, "''")}'`)
  return out.join('\n') + '\n'
}

function readLeg(file, label) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    fail(`${label}: cannot read ${file} (${e.code ?? e.message})`)
  }
  try {
    return parseUpdateYaml(text)
  } catch (e) {
    fail(`${label} (${file}): ${e.message}`)
  }
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3) fail('usage: merge-latest-mac.mjs <arm64 latest-mac.yml> <x64 latest-mac.yml> <out path>')
  const [armPath, x64Path, outPath] = argv
  const merged = mergeLatestMac(readLeg(armPath, 'arm64 leg'), readLeg(x64Path, 'x64 leg'))
  const yaml = serializeUpdateYaml(merged)
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
  const tmp = `${outPath}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, yaml)
    fs.renameSync(tmp, outPath)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
  return yaml
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main()
    console.log(`merge-latest-mac: wrote ${process.argv[4]}`)
  } catch (e) {
    console.error(`merge-latest-mac: ${e.message}`)
    process.exit(1)
  }
}
