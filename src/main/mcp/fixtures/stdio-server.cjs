// A tiny MCP server over stdio for tests. Modes (argv[2]): ok (default), crash, silent, pages.
const mode = process.argv[2] || 'ok'
const readline = require('node:readline')

if (mode === 'crash') {
  console.error(`boom: token=${process.env.SECRET_TOKEN || ''}`)
  process.exit(3)
}
if (mode === 'silent') setInterval(() => {}, 1000)

const rl = readline.createInterface({ input: process.stdin })
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)
console.log('not json banner')

rl.on('line', (line) => {
  if (mode === 'silent') return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } }
    })
  } else if (msg.method === 'tools/list') {
    if (mode === 'pages') {
      const first = !msg.params || !msg.params.cursor
      send({ jsonrpc: '2.0', id: msg.id, result: first ? { tools: [{ name: 'alpha' }], nextCursor: 'c2' } : { tools: [{ name: 'beta' }] } })
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: '  Echo the input back.  ' }, { name: 'sum' }] } })
    }
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })
  }
})
