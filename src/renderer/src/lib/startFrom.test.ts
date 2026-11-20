import { describe, expect, it } from 'vitest'
import { importSide, startFromItems, startFromLabel } from './startFrom'

describe('startFrom', () => {
  it('names the count on the trigger only while the dot shows', () => {
    expect(startFromLabel(3, true)).toBe('Start from, 3 agent files found')
    expect(startFromLabel(1, true)).toBe('Start from, 1 agent file found')
    expect(startFromLabel(3, false)).toBe('Start from')
    expect(startFromLabel('error', true)).toBe('Start from')
  })
  it('maps the scan state to the import side text', () => {
    expect(importSide(null).side).toBe('Checking...')
    expect(importSide('error').side).toBe('Could not check')
    expect(importSide(0).side).toBe('None found')
    expect(importSide(3)).toEqual({ side: '3 found', sideTone: 'accent' })
  })
  it('disables template and save with their reasons', () => {
    const items = startFromItems({ found: 0, templateCount: 0, roleCount: 1, sessionOpen: false })
    expect(items.find((i) => i.id === 'template')).toMatchObject({ disabled: true, description: 'No templates yet. Save this team as one first.' })
    expect(items.find((i) => i.id === 'save')).toMatchObject({ disabled: true, description: 'Add a role first.' })
  })
  it('shows the saved count and the open session', () => {
    const items = startFromItems({ found: 2, templateCount: 4, roleCount: 5, sessionOpen: true })
    expect(items.find((i) => i.id === 'template')).toMatchObject({ side: '4 saved', disabled: false })
    expect(items.find((i) => i.id === 'architect')).toMatchObject({ title: 'Open the Architect session', side: 'Session open' })
  })
})
