import { lazy, Suspense, useEffect, useState } from 'react'
import { ConfirmHost } from './components/overlay'
import { Toaster } from './components/feedback'
import { Spinner } from './components/primitives'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LoginPage } from './features/auth/LoginPage'
import { dismissBootScreen } from './lib/boot'
import { t, useLocale } from './lib/i18n'
import { initializePwa, requestOfflineWarmup } from './store/pwa'
import { useSession, watchSystemTheme } from './store/session'

const AppShell = lazy(() =>
  import('./features/shell/AppShell').then((module) => ({ default: module.AppShell })),
)
const SharePage = lazy(() =>
  import('./features/share/SharePage').then((module) => ({ default: module.SharePage })),
)

export function App() {

  useLocale()
  const status = useSession((s) => s.status)
  const load = useSession((s) => s.load)
  const [shareSlug] = useState(() => {
    const match = /^\/s\/([A-Za-z0-9_-]+)/.exec(location.pathname)
    return match?.[1] ?? null
  })

  useEffect(() => {
    if (shareSlug) return
    void load()
  }, [load, shareSlug])

  useEffect(() => watchSystemTheme(), [])

  useEffect(() => {
    initializePwa()
  }, [])

  useEffect(() => {
    if (!shareSlug && status !== 'loading') requestOfflineWarmup()
  }, [shareSlug, status])

  useEffect(() => {
    if (shareSlug || status !== 'loading') dismissBootScreen()
  }, [status, shareSlug])

  useEffect(() => {
    if (shareSlug) return
    const timer = window.setTimeout(() => dismissBootScreen(), 8000)
    return () => window.clearTimeout(timer)
  }, [shareSlug])

  if (shareSlug) {
    return (
      <>
        <ErrorBoundary>
          <Suspense fallback={<PageFallback />}>
            <SharePage slug={shareSlug} />
          </Suspense>
        </ErrorBoundary>
        <Toaster />
      </>
    )
  }

  return (
    <>
      <ErrorBoundary>
        {status === 'loading' && <div className="h-full" />}
        {status === 'anonymous' && <LoginPage />}
        {status === 'authed' && (
          <Suspense fallback={<PageFallback />}>
            <AppShell />
          </Suspense>
        )}
      </ErrorBoundary>
      <Toaster />
      <ConfirmHost />
    </>
  )
}

function PageFallback() {
  return (
    <div
      role="status"
      aria-label={t("common.loading")}
      className="flex h-full items-center justify-center bg-[var(--bg-base)] text-[var(--text-tertiary)]"
    >
      <Spinner size={18} />
    </div>
  )
}
