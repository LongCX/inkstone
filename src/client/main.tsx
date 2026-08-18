import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/inter.css'
import './styles/app.css'
import { LOCALE_STORAGE_KEY, UI_STORAGE_KEY } from './lib/runtime'
import { installViewportSizing } from './lib/viewport'

installViewportSizing()

async function start(): Promise<void> {
  if (import.meta.env.MODE === 'demo') {
    localStorage.removeItem(UI_STORAGE_KEY)
    localStorage.removeItem(LOCALE_STORAGE_KEY)
    const { installDemoRuntime } = await import('./demo/runtime')
    await installDemoRuntime()
  }

  const [{ App }, { t }] = await Promise.all([import('./App'), import('./lib/i18n')])
  const container = document.getElementById('root')
  if (!container) throw new Error(t("app.missing_root_mount_point"))
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void start()
