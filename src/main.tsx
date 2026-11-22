import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { CloudGate } from './app/CloudGate.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()

createRoot(document.getElementById('root') as HTMLElement).render(
  <CloudGate>
    <App />
  </CloudGate>
)
