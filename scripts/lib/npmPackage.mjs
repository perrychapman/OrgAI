// The npm package of the orgai command (Wave 7, docs/design/cli-standalone.md 3.1, 3.4, 3.5, 7.1): the generated
// package.json, the npm-shrinkwrap.json restricted to the CLI's dependency closure, install.json, the README, and the
// checks verify-npm.mjs runs on an installed tree. Pure: no fs, no child process; scripts/build-npm-package.mjs and
// scripts/verify-npm.mjs do the I/O. Typed for the vitest tests by npmPackage.d.mts.
import path from 'node:path'

/** The package name (D1, owner decision 2026-11-06: npm refused `orgai`, too similar to `org.ai`). The bin stays `orgai`. */
export const NPM_PACKAGE_NAME = 'orgai-cli'

/**
 * The CLI bundle's bare imports (src/cli/packaging.ts CLI_RUNTIME_PACKAGES) minus Codex, which is bring-your-own
 * (6.2, D7). Kept in step with packaging.ts by src/cli/npmPackage.test.ts.
 */
export const NPM_RUNTIME_PACKAGES = ['@anthropic-ai/claude-agent-sdk', 'zod']

/** The SDK whose declared peers become direct dependencies (npm would otherwise pick their versions at install). */
export const AGENT_SDK = '@anthropic-ai/claude-agent-sdk'

/**
 * engines.node (7.1): the lowest 22.x and 24.x with both tls.getCACertificates and tls.setDefaultCACertificates.
 * @types/node 22.20.5 (in this repo) says getCACertificates @since v22.15.0 and setDefaultCACertificates
 * @since v22.19.0; 24.5.0 is the first 24.x with setDefaultCACertificates (Node changelog, read from memory:
 * UNVERIFIED). 23.x is end of life and left out.
 */
export const NODE_FLOOR_22 = '22.19.0'
export const NODE_FLOOR_24 = '24.5.0'
export const NODE_ENGINES = `>=${NODE_FLOOR_22} <23 || >=${NODE_FLOOR_24}`

/** Lifecycle scripts npm runs at install; any of them in the installed tree must be on the allowlist (3.1). */
export const INSTALL_SCRIPT_NAMES = ['preinstall', 'install', 'postinstall']

/** The commit stamp install.json accepts (src/cli/installInfo.ts TOKEN_RE). */
const TOKEN_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/

/** install.json for a channel (3.5). Throws on a version or commit the reader would refuse. */
export function installInfoFor(channel, version, commit) {
  if (!['npm', 'app', 'archive'].includes(channel)) throw new Error(`Unknown install channel ${channel}`)
  if (typeof version !== 'string' || !TOKEN_RE.test(version)) throw new Error(`Malformed version ${version}`)
  const out = { channel, version }
  if (commit !== undefined && commit !== null && commit !== '' && commit !== 'unknown') {
    if (typeof commit !== 'string' || !TOKEN_RE.test(commit)) throw new Error(`Malformed commit ${commit}`)
    out.commit = commit
  }
  return out
}

/** The package key of a lockfile location: `node_modules/a/node_modules/@s/b` -> `@s/b`. */
export function nameOfLocation(location) {
  const i = location.lastIndexOf('node_modules/')
  return i < 0 ? location : location.slice(i + 'node_modules/'.length)
}

/**
 * Where Node resolves `dep` from the package at `from` in a lockfile's `packages` map: the nearest
 * `<ancestor>/node_modules/<dep>` walking up, as require() does. Returns the location key or undefined.
 */
export function resolveLocation(packages, from, dep) {
  let base = from
  for (;;) {
    const candidate = base ? `${base}/node_modules/${dep}` : `node_modules/${dep}`
    if (packages[candidate] && !packages[candidate].link) return candidate
    if (!base) return undefined
    const i = base.lastIndexOf('/node_modules/')
    base = i < 0 ? '' : base.slice(0, i)
  }
}

/**
 * The exact versions of `names` in the lockfile (top-level locations). Throws for a name the lockfile does not hold:
 * a dependency of the published package must be the tested one.
 */
export function pinnedVersions(lock, names) {
  const out = {}
  for (const name of [...names].sort()) {
    const entry = lock?.packages?.[`node_modules/${name}`]
    if (!entry?.version) throw new Error(`${name} is not in package-lock.json; run npm install first`)
    out[name] = entry.version
  }
  return out
}

/**
 * The dependency names of the published package: NPM_RUNTIME_PACKAGES plus the SDK's declared peers (read from its
 * package.json), sorted and unique. Optional peers (peerDependenciesMeta) are left out.
 */
export function cliDependencyNames(sdkPackageJson, runtimePackages = NPM_RUNTIME_PACKAGES) {
  const peers = Object.keys(sdkPackageJson?.peerDependencies ?? {}).filter((p) => !sdkPackageJson?.peerDependenciesMeta?.[p]?.optional)
  return [...new Set([...runtimePackages, ...peers])].sort()
}

/**
 * The lockfile locations the published package installs, starting from `rootDeps` (names at top level): every
 * dependency, optional dependency and non-optional peer, resolved as Node does. Returns a Map location -> { optional }
 * where optional is true when the package is reachable only through optional edges. Throws for a required dependency
 * the lockfile cannot resolve; an optional one that is missing is skipped.
 */
export function dependencyClosure(lock, rootDeps) {
  const packages = lock?.packages ?? {}
  const roots = [...rootDeps].map((name) => {
    const loc = `node_modules/${name}`
    if (!packages[loc]) throw new Error(`${name} is not in package-lock.json`)
    return loc
  })
  /** Edges of a location: [target location or undefined, dep name, optional edge]. */
  const edgesOf = (loc) => {
    const entry = packages[loc]
    const out = []
    for (const d of Object.keys(entry.dependencies ?? {})) out.push([d, false])
    for (const d of Object.keys(entry.optionalDependencies ?? {})) out.push([d, true])
    for (const d of Object.keys(entry.peerDependencies ?? {})) if (!entry.peerDependenciesMeta?.[d]?.optional) out.push([d, false])
    return out.map(([dep, opt]) => [resolveLocation(packages, loc, dep), dep, opt])
  }
  const walk = (followOptional) => {
    const seen = new Set(roots)
    const queue = [...roots]
    while (queue.length) {
      const loc = queue.shift()
      for (const [target, dep, opt] of edgesOf(loc)) {
        if (opt && !followOptional) continue
        if (!target) {
          if (opt || followOptional) continue
          throw new Error(`${dep} (needed by ${nameOfLocation(loc) || 'the package'}) is not in package-lock.json`)
        }
        if (seen.has(target)) continue
        seen.add(target)
        queue.push(target)
      }
    }
    return seen
  }
  // Required: reachable from the roots through non-optional edges only. Everything else reachable is optional.
  const required = walk(false)
  const all = walk(true)
  const out = new Map()
  for (const loc of [...all].sort()) out.set(loc, { optional: !required.has(loc) })
  return out
}

/** Lockfile fields a shrinkwrap entry keeps. dev / devOptional / peer describe the repo, not this package. */
const ENTRY_FIELDS = ['version', 'resolved', 'integrity', 'license', 'cpu', 'os', 'libc', 'engines', 'bin', 'hasInstallScript', 'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'funding', 'deprecated']

/** The generated package.json (3.1). No lifecycle scripts. `shrinkwrap: false` leaves npm-shrinkwrap.json out of `files`. */
export function npmPackageJson({ version, dependencies, repository, license, description, shrinkwrap = true }) {
  const pkg = {
    name: NPM_PACKAGE_NAME,
    version,
    description: description || 'The OrgAI command: run and steer OrgAI agent teams from a terminal.',
    type: 'module',
    bin: { orgai: 'out/cli/orgai.mjs' },
    files: ['out/cli/', ...(shrinkwrap ? ['npm-shrinkwrap.json'] : []), 'README.md', 'LICENSE'],
    engines: { node: NODE_ENGINES },
    license: license || 'UNLICENSED',
    dependencies
  }
  if (repository) pkg.repository = repository
  return pkg
}

/** npm-shrinkwrap.json for the package: the lockfile restricted to the closure of `dependencies`. */
export function shrinkwrapFor(lock, pkg) {
  const closure = dependencyClosure(lock, Object.keys(pkg.dependencies))
  const packages = {
    '': {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      dependencies: { ...pkg.dependencies },
      bin: { ...pkg.bin },
      engines: { ...pkg.engines }
    }
  }
  for (const [loc, { optional }] of closure) {
    const src = lock.packages[loc]
    const entry = {}
    for (const f of ENTRY_FIELDS) if (src[f] !== undefined) entry[f] = src[f]
    if (optional) entry.optional = true
    packages[loc] = entry
  }
  return { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages }
}

/** True when a lockfile `os` / `cpu` list admits `value` (npm's rules: names, `!name` excludes). */
export function listAdmits(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true
  const excluded = list.filter((v) => typeof v === 'string' && v.startsWith('!')).map((v) => v.slice(1))
  if (excluded.includes(value)) return false
  const included = list.filter((v) => typeof v === 'string' && !v.startsWith('!'))
  return included.length === 0 || included.includes(value)
}

/** True when a shrinkwrap entry installs on this platform. */
export function entryMatchesPlatform(entry, platform, arch) {
  return listAdmits(entry?.os, platform) && listAdmits(entry?.cpu, arch)
}

/**
 * Packages whose presence the libc decides (npm reads `libc` from the package itself; the lockfile carries none for
 * the musl builds), so on Linux both outcomes are accepted.
 */
export function libcDecides(location, entry, platform) {
  if (platform !== 'linux') return false
  return Array.isArray(entry?.libc) || /-(musl|gnu)$/.test(nameOfLocation(location))
}

/**
 * Compares an installed tree with the shrinkwrap (3.4 step 1). `installed` maps a location relative to the package
 * folder (`node_modules/x`, posix separators) to its version. Returns { ok, missing, extra, wrongVersion, skipped,
 * otherPlatforms }: `otherPlatforms` are shrinkwrap entries for another os / cpu that were installed anyway (npm
 * 11.12.1 applies no platform check to a dependency's shrinkwrap, so every platform's native package lands).
 */
export function compareInstalledTree(shrinkwrap, installed, platform, arch) {
  const expected = new Map()
  const skipped = []
  const otherPlatforms = []
  for (const [loc, entry] of Object.entries(shrinkwrap.packages)) {
    if (loc === '') continue
    if (!entryMatchesPlatform(entry, platform, arch)) {
      if (installed.has(loc)) otherPlatforms.push(loc)
      else skipped.push(loc)
      continue
    }
    expected.set(loc, entry)
  }
  const missing = []
  const wrongVersion = []
  for (const [loc, entry] of expected) {
    const got = installed.get(loc)
    if (got === undefined) {
      if (!libcDecides(loc, entry, platform)) missing.push(loc)
    } else if (got !== entry.version) wrongVersion.push({ location: loc, expected: entry.version, installed: got })
  }
  const extra = []
  for (const loc of installed.keys()) {
    if (!expected.has(loc) && !otherPlatforms.includes(loc)) extra.push(loc)
  }
  return {
    ok: missing.length === 0 && extra.length === 0 && wrongVersion.length === 0 && otherPlatforms.length === 0,
    missing: missing.sort(),
    extra: extra.sort(),
    wrongVersion,
    skipped: skipped.sort(),
    otherPlatforms: otherPlatforms.sort()
  }
}

/**
 * Without a shrinkwrap (build-npm-package default; --shrinkwrap writes one): the top-level dependencies are installed at exactly their
 * pinned versions and no native package of another platform is there. Returns { ok, problems }. Pure.
 */
export function compareTopLevel(dependencies, installed, platform, arch) {
  const problems = []
  for (const [name, version] of Object.entries(dependencies)) {
    const got = installed.get(`node_modules/${name}`)
    if (got === undefined) problems.push(`${name} is not installed`)
    else if (got !== version) problems.push(`${name} is ${got}, package.json pins ${version}`)
  }
  const own = claudeNativePackage(platform, arch)
  for (const loc of installed.keys()) {
    const name = nameOfLocation(loc)
    if (name.startsWith(`${AGENT_SDK}-`) && name !== own && name !== `${own}-musl`) {
      problems.push(`${name} (another platform's runtime) is installed`)
    }
  }
  return { ok: problems.length === 0, problems }
}

/** The SDK's native package for a platform (`@anthropic-ai/claude-agent-sdk-darwin-arm64`). */
export function claudeNativePackage(platform, arch) {
  return `${AGENT_SDK}-${platform}-${arch}`
}

/**
 * Lifecycle scripts in an installed tree that are not on the allowlist. `manifests` maps a location to its
 * package.json object (plus `hasBindingGyp`, which makes npm run `node-gyp rebuild`). `allowlist` holds
 * `name@version` strings. Returns [{ location, name, version, scripts }].
 */
export function unlistedInstallScripts(manifests, allowlist) {
  const allowed = new Set(allowlist)
  const out = []
  for (const [location, m] of manifests) {
    const scripts = INSTALL_SCRIPT_NAMES.filter((s) => typeof m?.scripts?.[s] === 'string' && m.scripts[s].trim() !== '')
    if (m?.hasBindingGyp && !scripts.includes('install')) scripts.push('install (binding.gyp)')
    if (scripts.length === 0) continue
    const id = `${m?.name ?? nameOfLocation(location)}@${m?.version ?? '?'}`
    if (!allowed.has(id)) out.push({ location, name: m?.name ?? nameOfLocation(location), version: m?.version, scripts })
  }
  return out.sort((a, b) => a.location.localeCompare(b.location))
}

/** Where `npm i -g --prefix <prefix>` puts the package and its bin (npm's global layout). */
export function globalLayout(platform, prefix, name = NPM_PACKAGE_NAME) {
  const p = platform === 'win32' ? path.win32 : path.posix
  const modules = platform === 'win32' ? p.join(prefix, 'node_modules') : p.join(prefix, 'lib', 'node_modules')
  return {
    packageDir: p.join(modules, ...name.split('/')),
    binDir: platform === 'win32' ? prefix : p.join(prefix, 'bin'),
    bin: platform === 'win32' ? p.join(prefix, 'orgai.cmd') : p.join(prefix, 'bin', 'orgai')
  }
}

/** The tarball `npm pack` writes for a package name and version (`@s/n` -> `s-n-1.0.0.tgz`). */
export function tarballName(name, version) {
  return `${name.replace(/^@/, '').replace(/\//g, '-')}-${version}.tgz`
}

/** True when a version carries a prerelease tag (publishes with --tag next, 3.4). */
export function isPrerelease(version) {
  return /^\d+\.\d+\.\d+-/.test(String(version))
}

/** The README.md shipped in the package (3.1). */
export function readmeText({ version, nodeEngines = NODE_ENGINES, shrinkwrap = true }) {
  const pinning = shrinkwrap
    ? 'The package pins its whole dependency tree (npm-shrinkwrap.json).'
    : 'The package pins its direct dependencies to exact versions.'
  return `# orgai-cli

The \`orgai\` command for [OrgAI](https://github.com/perrychapman/OrgAI): run and steer OrgAI agent teams from a
terminal, with or without the OrgAI desktop app. Version ${version}.

## Install

\`\`\`sh
npm i -g ${NPM_PACKAGE_NAME}${/-/.test(version) ? '@next' : ''}
orgai --version     # prints the version and "channel npm"
orgai doctor        # checks the install, the data folder, the agent runtimes and the secret vault
\`\`\`

Node ${nodeEngines}. Older Node versions run, but cannot add the operating system's root certificates (a corporate
or HTTPS-inspecting network then fails); \`orgai doctor\` warns when that is the case.

${pinning} The Claude runtime is an optional, per-platform
package of \`@anthropic-ai/claude-agent-sdk\`: do not install with \`--omit=optional\`. Installing with
\`--ignore-scripts\` is supported when no package in the tree has an install script (the release check verifies it).
Codex is not bundled: install \`@openai/codex\` yourself (or set \`ORGAI_CODEX_PATH\`) to use an OpenAI connection.

## Hosts

Every command talks to an OrgAI host that owns the data folder (one owner at a time):

- If the OrgAI app (or a background host) is running, \`orgai\` connects to it.
- If the app is installed but not running, \`orgai\` starts it in the background (no window).
- With no app installed, the command runs the host inside itself for as long as it runs.
  \`orgai daemon start\` keeps one running in the background instead.

The CLI and the app share one data folder by default (projects, runs, secrets). With both installed, keep them on the
same version: a CLI of another version can read and watch the app's runs but cannot change settings.

## Secrets

Secrets (API keys, MCP tokens) are stored encrypted in a vault in the data folder, under a key the operating system's
credential store keeps (Keychain on macOS, the Windows credential store, Secret Service on Linux). The CLI never takes
a secret as an argument: use \`--from-env VAR\` or \`--stdin\`. \`orgai secrets status\` shows the vault's state.

Where no credential store is available (a server, a container, CI), \`orgai secrets init --key-file <path>\` keeps
the vault key in a file instead. **Anyone who can read that key file can read every stored secret**: keep it outside
the data folder, readable only by you, and never commit or share it.

## The app and this package

The OrgAI desktop app ships its own copy of the \`orgai\` command (App settings > General > Advanced settings >
Terminal). When this npm package is first on your PATH, the app says so and does not install its own command over it.
\`orgai doctor\` lists every \`orgai\` on your PATH, which one runs, and whether a newer one is shadowed.
`
}
