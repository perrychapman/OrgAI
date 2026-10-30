import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  onReset: () => void
  /** The boundary clears its error when this changes. */
  resetKey?: string
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer error caught by ErrorBoundary', error, info.componentStack)
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <section className="error-boundary" role="alert" aria-labelledby="error-boundary-title">
        <h2 id="error-boundary-title">Something went wrong showing this view</h2>
        <pre>{error.message}</pre>
        <button type="button" className="btn" onClick={this.props.onReset}>
          Back to projects
        </button>
      </section>
    )
  }
}
