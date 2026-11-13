// Parser: rolldown's oxc parseSync, imported through vite 8's own re-export (vite is a declared devDependency;
// rolldown is only a transitive one); the repo's TypeScript 7 has no JS compiler API.
// Write-path inventory (docs/design/parallel-sessions.md 8). Statically scans src/main and src/cli for file-write call
// sites and fails on any site that is not classified in writePathInventory.allowlist.ts (and on stale entries).
//
// Scanner limits (best effort, by design):
//  - Only calls on the Node fs API are found: named / aliased / namespace imports of fs, node:fs, fs/promises,
//    node:fs/promises (and `require`), plus receivers literally named fs, fsp, fsPromises, promises, `fs.promises`.
//    Wrappers (fsRetry, atomicWrite, ...) are classified at their own fs call; their callers are not listed.
//  - FileHandle writes are found only when the handle variable is initialised from an fs `open(...)` call in the same
//    file (`const fh = await open(...)`, `fs.promises.open`, `fsp.open`) and then `.write/.writeFile/.appendFile/
//    .truncate/.writev` is called on that identifier. Handles passed through parameters or properties are missed.
//  - `open*` is a write site when the flag is a string containing w, a or + , or an expression mentioning
//    O_WRONLY/O_RDWR/O_CREAT/O_APPEND/O_TRUNC/O_EXCL, or a non-literal flag (unknown, counted as write).
//  - Writes by child processes (git, rm via exec, shell redirection), SQLite, Electron APIs (dialog, app.setPath,
//    safeStorage) and `fs.chmod/chown/utimes` are not detected.
//  - Wrapper calls are matched by name only (WRAPPER_NAME: *Durable, *Retry, *Atomic, atomicWrite ...), and fs functions
//    used as values (stored in an object, passed as a callback) are listed as `callee#ref`; calls through such an
//    object are found only when its name ends in `fs` (kitFs, nodeVaultFs, deps.fs).
//  - Dynamic access (`fs[name](...)`) is not detected. Keys omit line numbers: `file:function:callee`. Two calls to the
//    same callee in one function share one key.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'vite'
import { WRITE_SITES } from './writePathInventory.allowlist'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCAN_DIRS = ['src/main', 'src/cli']

const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'fs-extra'])
const FS_RECEIVERS = new Set(['fs', 'fsp', 'fsPromises', 'promises', 'nodeFs', 'fs.promises', 'nodeFsPromises'])

const WRITE_NAME =
  /^(writeFile|appendFile|rename|rm|rmdir|unlink|mkdir|mkdtemp|cp|copyFile|link|symlink|truncate|ftruncate|writeSync|writev|writevSync|write)(Sync)?$/
// Project-level wrappers around fs writes (durableFs, fsRetry, atomic writers): their callers are writers too.
const WRAPPER_NAME =
  /^(writeFile|rename|unlink|rm|mkdir|appendFile|copyFile)(Sync)?(Durable|Retry|Atomic|Atomically|Raw)$|^(atomicWrite|writeFileAtomic|writeAtomic|writeAtomically)$/
const HANDLE_WRITE = new Set(['write', 'writeFile', 'appendFile', 'truncate', 'writev'])

function excluded(rel: string): boolean {
  const parts = rel.split('/')
  const base = parts[parts.length - 1]
  if (/\.test\.tsx?$/.test(base)) return true
  if (parts.some((p) => ['testing', 'fixtures', 'testFixtures', '__fixtures__', '__tests__'].includes(p))) return true
  // Test-only helpers that live beside production modules.
  return /(^|\.)(fixture|fixtures)\.tsx?$|Testing\.tsx?$|testHelpers\.tsx?$|[tT]estUtil\.tsx?$/.test(base)
}

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue
      walk(p, out)
    } else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
}

// Minimal ESTree view (rolldown's oxc parser; TypeScript 7 ships no JS compiler API).
interface N {
  type: string
  [k: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

function children(n: N): N[] {
  const out: N[] = []
  for (const [k, v] of Object.entries(n)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue
    if (Array.isArray(v)) for (const c of v) if (c && typeof c === 'object' && typeof c.type === 'string') out.push(c)
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.type === 'string') out.push(v)
  }
  return out
}

const keyName = (k: N | undefined): string | undefined =>
  k
    ? k.type === 'Identifier'
      ? k.name
      : k.type === 'Literal'
        ? String(k.value)
        : k.type === 'PrivateIdentifier'
          ? `#${k.name}`
          : undefined
    : undefined

function unwrap(e: N | undefined | null): N | undefined {
  let x = e ?? undefined
  while (
    x &&
    [
      'ChainExpression',
      'TSNonNullExpression',
      'TSAsExpression',
      'TSSatisfiesExpression',
      'ParenthesizedExpression',
      'AwaitExpression'
    ].includes(x.type)
  ) {
    x = (x.expression ?? x.argument) as N | undefined
  }
  return x
}

/** Source-like text of an identifier / member chain, e.g. `fs.promises.rm`; undefined for anything else. */
function chainText(e: N | undefined): string | undefined {
  const x = unwrap(e)
  if (!x) return undefined
  if (x.type === 'Identifier') return x.name
  if (x.type === 'ThisExpression') return 'this'
  if (x.type === 'MemberExpression' && !x.computed) {
    const o = chainText(x.object)
    return o === undefined ? undefined : `${o}.${keyName(x.property)}`
  }
  return undefined
}

function enclosingName(anc: N[]): string {
  for (let i = anc.length - 1; i >= 0; i--) {
    const n = anc[i]
    const p = anc[i - 1]
    if (n.type === 'FunctionDeclaration' && n.id) return n.id.name
    if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') {
      if (n.id) return n.id.name
      if (p?.type === 'MethodDefinition') {
        const cls = anc[i - 3]
        const cn =
          cls && (cls.type === 'ClassDeclaration' || cls.type === 'ClassExpression') && cls.id ? `${cls.id.name}.` : ''
        return cn + (keyName(p.key) ?? '<computed>')
      }
      if (p?.type === 'VariableDeclarator' && p.id.type === 'Identifier') return p.id.name
      if ((p?.type === 'Property' || p?.type === 'PropertyDefinition') && keyName(p.key)) return keyName(p.key)!
      if (p?.type === 'AssignmentExpression') return chainText(p.left) ?? '<assigned>'
    }
  }
  return '<module>'
}

let srcText = ''
function flagIsWrite(arg: N | undefined): boolean {
  if (!arg) return false
  if (arg.type === 'Literal' && typeof arg.value === 'string') return /[wa+]/.test(arg.value)
  if (srcText && typeof arg.start === 'number') {
    const t = srcText.slice(arg.start, arg.end)
    if (/O_(WRONLY|RDWR|CREAT|APPEND|TRUNC|EXCL)/.test(t)) return true
    if (/O_RDONLY/.test(t)) return false
  }
  return true // numeric or unknown flags: counted as a write
}

export function scanSource(rel: string, text: string): string[] {
  srcText = text
  const lang = rel.endsWith('x') ? 'tsx' : 'ts'
  const program = parseSync(rel, text, { lang }).program as unknown as N
  const namespaces = new Set<string>() // identifiers bound to the whole fs module (or fs.promises)
  const named = new Map<string, string>() // local name -> original export name
  const handles = new Set<string>()

  const requireSpec = (init: N | undefined): string | undefined => {
    const c = unwrap(init)
    if (!c) return undefined
    if (c.type === 'CallExpression' && c.callee.type === 'Identifier' && c.callee.name === 'require') {
      const a = c.arguments[0]
      return a?.type === 'Literal' ? String(a.value) : undefined
    }
    if (c.type === 'ImportExpression') return c.source?.type === 'Literal' ? String(c.source.value) : undefined
    return undefined
  }

  const all: { n: N; anc: N[] }[] = []
  const collect = (n: N, anc: N[]): void => {
    all.push({ n, anc })
    const next = [...anc, n]
    for (const c of children(n)) collect(c, next)
  }
  collect(program, [])

  // Pass 1: imports / requires.
  for (const { n } of all) {
    if (n.type === 'ImportDeclaration' && FS_MODULES.has(n.source.value)) {
      for (const s of n.specifiers ?? []) {
        if (s.type === 'ImportDefaultSpecifier' || s.type === 'ImportNamespaceSpecifier') namespaces.add(s.local.name)
        else {
          const orig = s.imported.name ?? String(s.imported.value)
          if (orig === 'promises') namespaces.add(s.local.name)
          else named.set(s.local.name, orig)
        }
      }
    } else if (n.type === 'VariableDeclarator' && n.init) {
      const spec = requireSpec(n.init)
      if (spec && FS_MODULES.has(spec)) {
        if (n.id.type === 'Identifier') namespaces.add(n.id.name)
        else if (n.id.type === 'ObjectPattern') {
          for (const pr of n.id.properties) {
            if (pr.type === 'Property' && pr.value.type === 'Identifier')
              named.set(pr.value.name, keyName(pr.key) ?? pr.value.name)
          }
        }
      }
    }
  }

  const isFsReceiver = (e: N): boolean => {
    const t = chainText(e)
    if (t === undefined) return false
    if (FS_RECEIVERS.has(t)) return true
    // Injected / shared fs objects: kitFs, nodeVaultFs, deps.fs, this.fs ...
    if (/(^|\.)[A-Za-z]*[fF]s$/.test(t) && !/^(process|ctx)\./.test(t)) return true
    const parts = t.split('.')
    if (namespaces.has(parts[0]) && (parts.length === 1 || (parts.length === 2 && parts[1] === 'promises'))) return true
    return false
  }

  // Resolve a call's fs function name and display callee; undefined when it is not an fs call.
  const fsCall = (call: N): { name: string; callee: string } | undefined => {
    const e = unwrap(call.callee)
    if (!e) return undefined
    if (e.type === 'Identifier') {
      const orig = named.get(e.name)
      return orig
        ? {
            name: orig,
            callee: e.name === orig ? e.name : `${e.name}(${orig})`
          }
        : undefined
    }
    if (e.type === 'MemberExpression' && !e.computed && isFsReceiver(e.object)) {
      return { name: keyName(e.property) ?? '', callee: chainText(e)! }
    }
    return undefined
  }

  // Pass 2: handle variables initialised from fs open().
  for (const { n } of all) {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init) {
      const init = unwrap(n.init)
      if (init?.type === 'CallExpression') {
        const f = fsCall(init)
        if (f?.name === 'open') handles.add(n.id.name)
      }
    }
  }

  const keys: string[] = []
  for (const { n, anc } of all) {
    if (n.type !== 'CallExpression') continue
    const f = fsCall(n)
    if (f) {
      let hit = WRITE_NAME.test(f.name)
      if (/^open(Sync)?$/.test(f.name)) hit = flagIsWrite(n.arguments[1])
      if (f.name === 'createWriteStream') hit = true
      if (hit) keys.push(`${rel}:${enclosingName(anc)}:${f.callee}`)
      continue
    }
    const callee = unwrap(n.callee)
    const calleeName =
      callee?.type === 'Identifier'
        ? callee.name
        : callee?.type === 'MemberExpression' && !callee.computed
          ? keyName(callee.property)
          : undefined
    if (calleeName && WRAPPER_NAME.test(calleeName)) {
      keys.push(`${rel}:${enclosingName(anc)}:${chainText(callee) ?? calleeName}`)
      continue
    }
    if (
      callee?.type === 'MemberExpression' &&
      !callee.computed &&
      callee.object.type === 'Identifier' &&
      handles.has(callee.object.name) &&
      HANDLE_WRITE.has(keyName(callee.property) ?? '')
    ) {
      keys.push(`${rel}:${enclosingName(anc)}:${chainText(callee)}`)
    }
  }
  // fs functions used as values (stored in an object, passed as a callback, aliased): `{ rename, writeFile }`.
  for (const { n, anc } of all) {
    const p = anc[anc.length - 1]
    if (!p) continue
    const isCallee = p.type === 'CallExpression' && p.callee === n
    if (n.type === 'Identifier' && named.has(n.name) && WRITE_NAME.test(named.get(n.name)!) && !isCallee) {
      if (p.type === 'ImportSpecifier' || p.type === 'ExportSpecifier') continue
      if (p.type === 'Property' && p.key === n && !p.shorthand) continue
      if (p.type === 'MemberExpression' && p.property === n && !p.computed) continue
      keys.push(`${rel}:${enclosingName(anc)}:${n.name}#ref`)
    } else if (
      n.type === 'MemberExpression' &&
      !n.computed &&
      !isCallee &&
      isFsReceiver(n.object) &&
      WRITE_NAME.test(keyName(n.property) ?? '')
    ) {
      if (p.type === 'MemberExpression' && p.object !== n) continue
      keys.push(`${rel}:${enclosingName(anc)}:${chainText(n)}#ref`)
    }
  }
  return [...new Set(keys)].sort()
}

export function scanAll(): string[] {
  const files: string[] = []
  for (const d of SCAN_DIRS) walk(join(ROOT, d), files)
  const keys = new Set<string>()
  for (const f of files.sort()) {
    const rel = relative(ROOT, f).split(sep).join('/')
    if (excluded(rel)) continue
    for (const k of scanSource(rel, readFileSync(f, 'utf8'))) keys.add(k)
  }
  return [...keys].sort()
}

describe('write-path inventory (parallel sessions, design section 8)', () => {
  const found = scanAll()

  it('every file-write call site is classified in the allow-list', () => {
    const missing = found.filter((k) => !(k in WRITE_SITES))
    const lines = missing.map((k) => `  '${k}': 'single owner',`)
    expect(
      missing,
      `Unclassified file writers. Classify each new writer with the lock or ownership rule that covers it, ` +
        `docs/design/parallel-sessions.md 8. Add to src/main/writePathInventory.allowlist.ts:\n${lines.join('\n')}\n`
    ).toEqual([])
  })

  it('has no stale allow-list entries', () => {
    const set = new Set(found)
    const stale = Object.keys(WRITE_SITES).filter((k) => !set.has(k))
    expect(
      stale,
      `Stale allow-list entries (the write site no longer exists), remove:\n${stale.map((k) => `  '${k}'`).join('\n')}\n`
    ).toEqual([])
  })

  it('every entry names a non-empty rule', () => {
    expect(Object.entries(WRITE_SITES).filter(([, v]) => !v.trim())).toEqual([])
  })

  it('detects the call shapes it claims to', () => {
    const src = `
import * as fs from 'node:fs'
import { writeFileSync as wf, readFileSync } from 'fs'
import { open, rename, link } from 'node:fs/promises'
function a() { fs.writeFileSync('x', 'y'); wf('a', 'b'); readFileSync('z'); fs.openSync('p', 'r'); fs.openSync('p', 'wx') }
const b = async () => { await rename('a', 'b'); const h = await open('f', 'a'); await h.write('x'); fs.promises.rm('d') }
const kitFs = { link }
function d() { kitFs.writeFile('a'); writeFileDurable('p', 'q'); return { rename } }
class C { m() { fs.createWriteStream('s'); map.rename('x') } }
`
    expect(scanSource('t.ts', src)).toEqual(
      [
        't.ts:a:fs.writeFileSync',
        't.ts:a:wf(writeFileSync)',
        't.ts:a:fs.openSync',
        't.ts:b:rename',
        't.ts:b:open',
        't.ts:b:h.write',
        't.ts:b:fs.promises.rm',
        't.ts:d:kitFs.writeFile',
        't.ts:d:writeFileDurable',
        't.ts:d:rename#ref',
        't.ts:<module>:link#ref',
        't.ts:C.m:fs.createWriteStream'
      ].sort()
    )
  })
})
