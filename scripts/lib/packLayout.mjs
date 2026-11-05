// Where `npm run pack` (electron-builder --dir) puts the packaged app and its orgai command (cli-spec 7, Wave 6), and
// a small scanner for the packages a built .mjs file imports. Pure ESM, node:path and node:module only, no fs.
//
// src/main/host/packagedLayout.ts is the TypeScript source of the in-app paths; packLayoutParity.test.ts checks the two
// agree. Every function takes the platform so tests can check all layouts on one machine ('win32' uses path.win32,
// everything else path.posix).
import path from 'node:path'
import { isBuiltin } from 'node:module'

/** Where electron-builder --dir puts the app for this platform, and the entry that proves a build is there. */
export function unpackedLayout(platform, arch) {
  if (platform === 'win32') return { dir: 'win-unpacked', marker: 'OrgAI.exe' }
  if (platform === 'darwin') return { dir: arch === 'arm64' ? 'mac-arm64' : 'mac', marker: 'OrgAI.app' }
  return { dir: 'linux-unpacked', marker: 'orgai' }
}

/**
 * The packaged pieces under `releaseDir` (the repo's release/ folder):
 * - unpackedDir: release/mac-arm64 | mac | win-unpacked | linux-unpacked
 * - resourcesDir: <unpacked>/OrgAI.app/Contents/Resources (darwin), else <unpacked>/resources
 * - launcher: <resources>/bin/orgai (orgai.cmd on Windows)
 * - cliBundleDir: <resources>/app.asar.unpacked/out/cli
 * - appBinary: Contents/MacOS/OrgAI, <unpacked>/OrgAI.exe, <unpacked>/orgai
 */
export function packagedPaths(platform, arch, releaseDir) {
  const p = platform === 'win32' ? path.win32 : path.posix
  const unpackedDir = p.join(p.normalize(releaseDir), unpackedLayout(platform, arch).dir)
  let resourcesDir
  let appBinary
  if (platform === 'darwin') {
    const contents = p.join(unpackedDir, 'OrgAI.app', 'Contents')
    resourcesDir = p.join(contents, 'Resources')
    appBinary = p.join(contents, 'MacOS', 'OrgAI')
  } else {
    resourcesDir = p.join(unpackedDir, 'resources')
    appBinary = p.join(unpackedDir, platform === 'win32' ? 'OrgAI.exe' : 'orgai')
  }
  return {
    unpackedDir,
    resourcesDir,
    launcher: p.join(resourcesDir, 'bin', platform === 'win32' ? 'orgai.cmd' : 'orgai'),
    cliBundleDir: p.join(resourcesDir, 'app.asar.unpacked', 'out', 'cli'),
    appBinary
  }
}

/** True for a Node builtin, with or without the node: prefix (node:test and other prefix-only modules included). */
export function isNodeBuiltin(name) {
  return typeof name === 'string' && name.length > 0 && isBuiltin(name)
}

/** The package a bare specifier names (`@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`), else undefined. */
export function packageOf(specifier) {
  if (typeof specifier !== 'string' || !specifier) return undefined
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('\\') || specifier.startsWith('#')) return undefined
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) return undefined // node:, file:, data:, C:\ ...
  if (isNodeBuiltin(specifier)) return undefined
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) return parts.length >= 2 && parts[0].length > 1 && parts[1] ? `${parts[0]}/${parts[1]}` : undefined
  return parts[0] || undefined
}

const WORD_START = /[A-Za-z_$]/
const WORD_CHAR = /[A-Za-z0-9_$]/
/** After these words a `/` starts a regular expression, not a division. */
const REGEX_AFTER_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'])

/**
 * Splits JavaScript into words, punctuation and string literals, skipping comments, template text and regular
 * expressions. Approximate (no full parser), good enough for built bundles: `${...}` inside templates is scanned as
 * code, so an import() there still counts.
 */
function tokenize(src) {
  const tokens = []
  let i = 0
  const n = src.length
  // A stack of brace depths for open template substitutions.
  const templateDepth = []
  let braces = 0
  const prevAllowsRegex = () => {
    const t = tokens[tokens.length - 1]
    if (!t) return true
    if (t.type === 'string' || t.type === 'number') return false
    if (t.type === 'word') return REGEX_AFTER_WORDS.has(t.value)
    return !(t.value === ')' || t.value === ']' || t.value === '}')
  }
  const skipTemplate = () => {
    // i is just past a backtick or a closing `}` of a substitution; read text until ` or ${.
    while (i < n) {
      const c = src[i]
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '`') {
        i++
        tokens.push({ type: 'string', value: null })
        return
      }
      if (c === '$' && src[i + 1] === '{') {
        i += 2
        templateDepth.push(braces)
        braces++
        tokens.push({ type: 'punct', value: '${' })
        return
      }
      i++
    }
  }
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let value = ''
      while (j < n && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') {
          value += src[j + 1] ?? ''
          j += 2
          continue
        }
        value += src[j]
        j++
      }
      tokens.push({ type: 'string', value })
      i = j + 1
      continue
    }
    if (c === '`') {
      i++
      skipTemplate()
      continue
    }
    if (c === '}' && templateDepth.length && templateDepth[templateDepth.length - 1] === braces - 1) {
      templateDepth.pop()
      braces--
      i++
      skipTemplate()
      continue
    }
    if (c === '/' && prevAllowsRegex()) {
      let j = i + 1
      let inClass = false
      while (j < n && src[j] !== '\n') {
        const d = src[j]
        if (d === '\\') {
          j += 2
          continue
        }
        if (d === '[') inClass = true
        else if (d === ']') inClass = false
        else if (d === '/' && !inClass) break
        j++
      }
      j++
      while (j < n && WORD_CHAR.test(src[j])) j++
      tokens.push({ type: 'regex', value: null })
      i = j
      continue
    }
    if (WORD_START.test(c)) {
      let j = i + 1
      while (j < n && WORD_CHAR.test(src[j])) j++
      tokens.push({ type: 'word', value: src.slice(i, j) })
      i = j
      continue
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1
      while (j < n && /[0-9A-Za-z_.]/.test(src[j])) j++
      tokens.push({ type: 'number', value: src.slice(i, j) })
      i = j
      continue
    }
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '{') braces++
    else if (c === '}') braces = Math.max(0, braces - 1)
    tokens.push({ type: 'punct', value: c })
    i++
  }
  return tokens
}

/**
 * The package names a module imports: static `import ... from 'x'`, `import 'x'`, `export ... from 'x'` and
 * `import('x')` with a string literal. Relative, absolute, URL and builtin specifiers are left out; subpaths are
 * reduced to their package. Sorted, unique.
 */
export function bareImports(sourceText) {
  const tokens = tokenize(String(sourceText ?? ''))
  const found = new Set()
  const add = (t) => {
    if (t?.type !== 'string' || t.value === null) return
    const pkg = packageOf(t.value)
    if (pkg) found.add(pkg)
  }
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]
    if (t.type !== 'word') continue
    const prev = tokens[k - 1]
    // `x.import(...)` / `x.from` are property accesses, not syntax.
    if (prev?.type === 'punct' && prev.value === '.') continue
    if (t.value === 'from') add(tokens[k + 1])
    else if (t.value === 'import') {
      const next = tokens[k + 1]
      if (next?.type === 'string') add(next)
      else if (next?.type === 'punct' && next.value === '(') add(tokens[k + 2])
    }
  }
  return [...found].sort()
}
