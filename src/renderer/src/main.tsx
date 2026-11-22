import React from 'react'
import ReactDOM from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './styles/global.css'
import App from './App'
import { initTheme, whenAppearanceApplied } from './lib/theme'

initTheme()

// Render once the saved appearance is applied (bounded wait), so the first page sees the saved theme and Reduce motion.
void whenAppearanceApplied().then(() => {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
})
