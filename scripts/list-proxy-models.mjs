// Token-free: list the models a proxy serves, with the family OrgAI would pick for each.
//
//   PROXY_API_KEY=... node scripts/list-proxy-models.mjs --url https://proxy.example.com/v1/models [--key-env VAR]
//
// One GET with the key as a Bearer token. The key comes from the environment variable named by --key-env (default
// PROXY_API_KEY), is never an argument and is never printed. https only, or http on localhost / a private network
// address; no credentials in the URL; no redirects; 10 s; 5 MB. Output is ids and owners only (control characters
// removed). Unit-tested pure parts: scripts/lib/proxyModels.mjs. It makes a network call: run it only against a proxy
// you own, and only with the user's consent.
import { MAX_BODY_BYTES, checkKey, checkModelsUrl, formatRows, keyEnvName, parseModels } from './lib/proxyModels.mjs'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const rawUrl = arg('--url')
  if (!rawUrl) throw new Error('Usage: node scripts/list-proxy-models.mjs --url <models url> [--key-env VAR]')
  const url = checkModelsUrl(rawUrl)
  const key = checkKey(process.env[keyEnvName(arg('--key-env'))])
  const res = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${key}`, accept: 'application/json' } })
  if (!res.ok) throw new Error(`The proxy answered ${res.status}`)
  const chunks = []
  let size = 0
  for await (const chunk of res.body) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('The answer is larger than 5 MB')
    chunks.push(chunk)
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  console.log(formatRows(parseModels(body)))
}

main().catch((e) => {
  // Never print the key: the messages above name the variable, not its value.
  console.error(e instanceof Error ? e.message.replace(/Bearer\s+\S+/g, 'Bearer ***') : 'Failed')
  process.exit(1)
})
