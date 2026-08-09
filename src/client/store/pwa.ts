import { create } from 'zustand'
import { t } from '../lib/i18n'
import { useUi } from './ui'

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

interface PwaState {
  installAvailable: boolean
  installed: boolean
  installing: boolean
  offlineStatus: 'idle' | 'preparing' | 'ready' | 'error'
  offlineCompleted: number
  offlineTotal: number
  install: () => Promise<void>
}

let installPrompt: InstallPromptEvent | null = null
let initialized = false
let updateToastShown = false
let reloadForUpdate = false
let serviceWorkerRegistration: ServiceWorkerRegistration | null = null
let warmupRequested = false
let warmupScheduled = false

export const usePwa = create<PwaState>((set) => ({
  installAvailable: false,
  installed: isStandalone(),
  installing: false,
  offlineStatus: 'idle',
  offlineCompleted: 0,
  offlineTotal: 0,

  async install() {
    const prompt = installPrompt
    if (!prompt) return
    installPrompt = null
    set({ installAvailable: false, installing: true })
    try {
      await prompt.prompt()
      const choice = await prompt.userChoice
      if (choice.outcome === 'accepted') set({ installed: true })
    } finally {
      set({ installing: false })
    }
  },
}))

export function initializePwa(): void {
  if (initialized || typeof window === 'undefined') return
  initialized = true

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    installPrompt = event as InstallPromptEvent
    usePwa.setState({ installAvailable: true })
  })
  window.addEventListener('appinstalled', () => {
    installPrompt = null
    usePwa.setState({ installAvailable: false, installed: true, installing: false })
  })

  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return

  navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage)
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadForUpdate) location.reload()
  })
  window.addEventListener('online', scheduleOfflineWarmup)
  void registerServiceWorker()
}

export function requestOfflineWarmup(): void {
  warmupRequested = true
  scheduleOfflineWarmup()
}

async function registerServiceWorker(): Promise<void> {
  try {
    const wasControlled = Boolean(navigator.serviceWorker.controller)
    const registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    })
    serviceWorkerRegistration = registration

    if (registration.waiting && wasControlled) notifyUpdate(registration.waiting)
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing
      if (!worker) return
      worker.addEventListener('statechange', () => {
        if (worker.state !== 'installed') return
        if (navigator.serviceWorker.controller) notifyUpdate(worker)
      })
    })

    const ready = await navigator.serviceWorker.ready
    serviceWorkerRegistration = ready
    ready.active?.postMessage({ type: 'GET_OFFLINE_CACHE_STATUS' })
    scheduleOfflineWarmup()

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        void registration.update().catch(() => {})
        scheduleOfflineWarmup()
      }
    })
  } catch {
  }
}

function scheduleOfflineWarmup(): void {
  if (!warmupRequested || warmupScheduled || !navigator.onLine) return
  const worker = serviceWorkerRegistration?.active ?? navigator.serviceWorker?.controller
  if (!worker) return
  warmupScheduled = true
  const run = () => {
    warmupScheduled = false
    if (!warmupRequested || !navigator.onLine) return
    worker.postMessage({ type: 'WARM_OFFLINE_CACHE' })
  }
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  }
  if (idleWindow.requestIdleCallback) idleWindow.requestIdleCallback(run, { timeout: 3_000 })
  else window.setTimeout(run, 1_200)
}

function handleServiceWorkerMessage(event: MessageEvent): void {
  const data = event.data as {
    type?: string
    status?: PwaState['offlineStatus']
    completed?: number
    total?: number
    notify?: boolean
  } | null
  if (data?.type !== 'OFFLINE_CACHE_STATUS') return
  if (!data.status || !['preparing', 'ready', 'error'].includes(data.status)) return
  const completed = Math.max(0, Number(data.completed) || 0)
  const total = Math.max(completed, Number(data.total) || 0)
  usePwa.setState({
    offlineStatus: data.status,
    offlineCompleted: completed,
    offlineTotal: total,
  })
  if (data.status === 'ready' && data.notify) {
    useUi.getState().toast({
      title: t('pwa.offline_ready'),
      description: t('pwa.offline_ready_description'),
      tone: 'success',
    })
  }
}

function notifyUpdate(worker: ServiceWorker): void {
  if (updateToastShown) return
  updateToastShown = true
  const durationMs = 30_000
  useUi.getState().toast({
    title: t('pwa.update_ready'),
    description: t('pwa.update_ready_description'),
    tone: 'default',
    duration: durationMs,
    action: {
      label: t('pwa.refresh_now'),
      run: () => {
        void applyUpdate(worker)
      },
    },
  })
  // Reset the flag once the toast is gone, so a later installed worker can
  // notify again instead of being permanently suppressed.
  window.setTimeout(() => {
    updateToastShown = false
  }, durationMs + 2_000)
}

async function applyUpdate(worker: ServiceWorker): Promise<void> {
  const { useNotes } = await import('./notes')
  await useNotes.getState().flush({ immediate: true }).catch(() => {})
  reloadForUpdate = true
  worker.postMessage({ type: 'SKIP_WAITING' })
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches) ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
}
