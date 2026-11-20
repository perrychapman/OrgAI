// The settings sample and thumbnail of the Factory Floor (docs/design/factory-floor.md section 6.6): a static picture of the
// real scene, never a canvas and never a second WebGL context. sample-dark.png and sample-light.png are 480 x 260 CSS px at
// 2x (960 x 520 px), rendered from the built app on the fixed five-agent sample team (Orchestrator in the booth, Running;
// Architect, Running; Reviewer, Idle; Developer under Architect, Needs you; Tester under Reviewer, Finished) by
// scripts/render-factory-sample.mjs, a script run by hand. The wrapper is one image to assistive technology; the picture
// follows the app theme (data-theme on <html>, written by lib/theme.ts) and changes when the theme does.
import { useSyncExternalStore, type ReactElement } from 'react'
import sampleDark from '../../../assets/factory/sample-dark.png'
import sampleLight from '../../../assets/factory/sample-light.png'
import '../../../styles/factory-sample.css'

type SampleTheme = 'dark' | 'light'

/** The resolved app theme: lib/theme.ts resolves System to dark or light and writes it as data-theme on <html>. */
function readTheme(): SampleTheme {
  const t = document.documentElement.getAttribute('data-theme')
  if (t === 'light' || t === 'dark') return t
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

export function FactorySample(): ReactElement {
  const theme = useSyncExternalStore(subscribe, readTheme, () => 'dark')
  return (
    <div className="factory-sample" role="img" aria-label="Static sample factory floor" data-testid="factory-sample">
      <img
        className="factory-sample-image"
        src={theme === 'light' ? sampleLight : sampleDark}
        alt=""
        width={480}
        height={260}
        draggable={false}
        data-testid="factory-sample-image"
        data-sample-theme={theme}
      />
    </div>
  )
}
