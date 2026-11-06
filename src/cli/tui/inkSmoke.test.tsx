import { Text } from 'ink'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

// .tsx compiles with React's automatic runtime under vitest and Ink renders through ink-testing-library.
describe('ink smoke', () => {
  it('renders <Text>', () => {
    const r = render(<Text>hello</Text>)
    expect(r.lastFrame()).toBe('hello')
    r.unmount()
  })
})
