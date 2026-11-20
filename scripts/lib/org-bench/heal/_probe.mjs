import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const require = createRequire(import.meta.url)
const jiti = require('jiti').createJiti(import.meta.url, { fsCache: false, alias: { '@shared': join(root, 'src/shared') } })
const t0 = Date.now()
const S = await jiti.import(join(root, 'src/main/evolve/service.ts'))
const D = await jiti.import(join(root, 'src/shared/defaults.ts'))
const ST = await jiti.import(join(root, 'src/main/runtime/staffing.ts'))
console.log(Object.keys(S), Date.now() - t0, D.DEFAULT_MAX_CONCURRENT_SUBAGENTS, D.MAX_CONCURRENT_SUBAGENTS_LIMIT, Object.keys(ST).slice(0, 20))
