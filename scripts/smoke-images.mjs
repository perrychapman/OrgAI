// Verifies that an image pasted mid-session reaches the model the way claude.ts send() delivers it: a
// streaming-input session starts with a text prompt, then a second user message carries
// [image block (base64 PNG), text block]. One haiku session, no tools. Asserts the reply says red.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { deflateSync } from 'node:zlib'

/** A solid red 16x16 RGB PNG, built in memory so the script needs no fixture file. */
function redPng(size = 16) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([0xff, 0x00, 0x00]))])
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const png = redPng().toString('base64')
const t0 = Date.now()
let sendImage
const firstTurnDone = new Promise((r) => (sendImage = r))
let closeInput
const secondTurnDone = new Promise((r) => (closeInput = r))

async function* prompt() {
  yield { type: 'user', message: { role: 'user', content: 'Reply with exactly the word READY and nothing else.' }, parent_tool_use_id: null }
  await firstTurnDone
  // Same shape as userContent(text, images) in src/main/runtime/claude.ts: image blocks first, then text.
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
        { type: 'text', text: 'What color is this image? One word.' }
      ]
    },
    parent_tool_use_id: null
  }
  await secondTurnDone
}

const q = query({
  prompt: prompt(),
  options: {
    cwd: process.cwd(),
    model: 'haiku',
    systemPrompt: { type: 'custom', prompt: 'You are a terse assistant.' },
    tools: [],
    settingSources: [],
    permissionMode: 'dontAsk'
  }
})

let results = 0
let reply = ''
let totalCost = 0
for await (const msg of q) {
  if (msg.type === 'system' && msg.subtype === 'init') console.log('init model:', msg.model, '| apiKeySource:', msg.apiKeySource)
  if (msg.type === 'assistant') {
    if (msg.error) console.log('assistant error:', msg.error)
    for (const b of msg.message.content) if (b.type === 'text') {
      console.log(`turn ${results + 1} text:`, JSON.stringify(b.text))
      if (results === 1) reply += b.text
    }
  }
  if (msg.type === 'result') {
    results++
    totalCost = msg.total_cost_usd ?? totalCost
    console.log(`result ${results}:`, msg.subtype, '| cost:', msg.total_cost_usd, `| ${Date.now() - t0} ms`)
    if (results === 1) sendImage()
    else {
      closeInput()
      break
    }
  }
}

const ok = /\bred\b/i.test(reply)
console.log(ok ? 'PASS' : 'FAIL', '| reply:', JSON.stringify(reply.trim()), '| png bytes:', Buffer.from(png, 'base64').length, '| total cost:', totalCost)
process.exit(ok ? 0 : 1)
