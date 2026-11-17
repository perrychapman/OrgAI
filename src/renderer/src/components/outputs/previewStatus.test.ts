import { describe, expect, it } from 'vitest'
import { noPreviewSentence } from './previewStatus'

describe('noPreviewSentence', () => {
  it('names the PDF app for a pdf and keeps main\'s sentence for any other kind', () => {
    expect(noPreviewSentence('pdf', 'x')).toBe('OrgAI cannot show PDFs yet. Open the file in your PDF app.')
    expect(noPreviewSentence('other', 'OrgAI cannot preview this kind of file; open it instead.')).toBe('OrgAI cannot preview this kind of file; open it instead.')
  })
})
