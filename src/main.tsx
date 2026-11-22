import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { SharedSessionPage } from './components/share/SharedSessionPage.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import './app/fonts.css'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()

const shareId = window.location.pathname.match(/^\/share\/([A-Za-z0-9]+)\/?$/)?.[1]

createRoot(document.getElementById('root') as HTMLElement).render(
  shareId ? <SharedSessionPage id={shareId} /> : <App />
)
