import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '../shared/types'
import { fakeContext, record, summary } from './testing/fakeContext'
import { styleFor } from './output'
import { recordWithoutImages, transcriptLine } from './render'

const image = { mediaType: 'image/png' as const, data: 'U0VDUkVU' }
const entry = (block: TranscriptEntry['block']): TranscriptEntry => ({ id: 'e', agentId: 'root', at: 1, block })
const media = { kind: 'image' as const, image }
const unsupported = { kind: 'unsupported' as const, mediaType: 'audio/wav', name: 'sound', reason: 'unavailable' }

describe('transcript media', () => {
  it('renders ordered result parts and standalone media as labels without bytes', () => {
    const opts = { st: styleFor(fakeContext({ globals: { color: false } }).ctx), agentName: () => 'Agent', results: true }
    const result = transcriptLine(entry({ kind: 'tool_result', toolUseId: 't', content: 'fallback', isError: false, parts: [{ type: 'text', text: 'before' }, { type: 'media', media }, { type: 'text', text: 'after' }, { type: 'media', media: unsupported }] }), opts)
    expect(result).toContain('before [image image/png 6 bytes] after [unsupported media audio/wav sound: unavailable]')
    expect(transcriptLine(entry({ kind: 'media', media }), opts)).toContain('[image image/png 6 bytes]')
    expect(result).not.toContain(image.data)
  })

  it('redacts user, result-part and standalone image bytes without mutating the record', () => {
    const rec = record(summary('r'), { transcript: [entry({ kind: 'user', text: '', images: [image] }), entry({ kind: 'media', media }), entry({ kind: 'tool_result', toolUseId: 't', content: 'fallback', isError: false, parts: [{ type: 'media', media }, { type: 'media', media: unsupported }] })] })
    const redacted = recordWithoutImages(rec)
    expect(JSON.stringify(redacted)).not.toContain(image.data)
    expect(JSON.stringify(redacted).match(/omittedBase64/g)).toHaveLength(3)
    expect(redacted.transcript[2].block).toMatchObject({ parts: [{ media: { image: { byteLength: 6 } } }, { media: unsupported }] })
    expect(JSON.stringify(rec)).toContain(image.data)
  })
})

describe('agentTreeLines: compactions (compaction investigation 2026-11-10)', () => {
  it('names the count beside an agent that compacted, nothing for one that did not', async () => {
    const { agentTreeLines } = await import('./render')
    const st = styleFor(fakeContext({ globals: { color: false } }).ctx)
    const base = { roleId: null, roleSlug: 'lead', parentId: null, spawnToolUseId: null, state: 'idle' as const, activity: 'Waiting', inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: 1 }
    const lines = agentTreeLines(summary('r1'), {
      root: { ...base, id: 'root', name: 'Lead', compactions: 3 },
      w: { ...base, id: 'w', name: 'Writer', roleSlug: 'writer', parentId: 'root', startedAt: 2 }
    }, st)
    expect(lines[0]).toContain('compacted 3x')
    expect(lines[1]).not.toContain('compacted')
  })
})
