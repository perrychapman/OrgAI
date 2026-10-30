// CI helper: fail when a release tag does not match package.json's version (tag v0.1.0 <-> version 0.1.0).
// Usage: node scripts/ci-check-version.mjs <tag>. Free, no network.
import { readFileSync } from 'node:fs'

const tag = process.argv[2] ?? ''
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
if (tag !== `v${version}`) {
  console.error(`Tag "${tag}" does not match package.json version ${version} (expected v${version}).`)
  process.exit(1)
}
console.log(`Tag ${tag} matches package.json version ${version}.`)
