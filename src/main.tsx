import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Apply theme before first render to avoid flash of wrong theme.
// If the user has no persisted preference, fall back to system preference.
;(function applyInitialTheme() {
  try {
    const stored = localStorage.getItem('folio-ui')
    const persistedTheme = stored ? (JSON.parse(stored) as { state?: { theme?: string } }).state?.theme : null
    if (persistedTheme === 'dark' || (!persistedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.classList.add('dark')
    }
  } catch {
    // localStorage unavailable — leave default light theme
  }
})()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
