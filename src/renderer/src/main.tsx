import React from 'react'
import ReactDOM from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './styles/global.css'
import App from './App'
import { initTheme } from './lib/theme'

// Applies the cached saved appearance synchronously, then the settings reply. Render at once: a window that waited for
// settings subscribed to run events late and could miss them (lib/theme.ts isAppearanceKnown, lib/usePageArrival.ts).
initTheme()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
