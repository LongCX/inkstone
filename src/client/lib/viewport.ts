export interface VisibleViewport {
  top: number
  right: number
  bottom: number
  left: number
  width: number
  height: number
}

function usableVisualViewport(): VisualViewport | null {
  const viewport = window.visualViewport
  if (!viewport || Math.abs(viewport.scale - 1) > 0.01) return null
  return viewport
}

export function getVisibleViewport(): VisibleViewport {
  const viewport = usableVisualViewport()
  const top = viewport?.offsetTop ?? 0
  const left = viewport?.offsetLeft ?? 0
  const width = viewport?.width ?? window.innerWidth
  const height = viewport?.height ?? window.innerHeight

  return {
    top,
    right: left + width,
    bottom: top + height,
    left,
    width,
    height,
  }
}

export function installViewportSizing(): () => void {
  let frame = 0
  const root = document.documentElement

  const sync = () => {
    frame = 0
    const viewport = getVisibleViewport()
    root.style.setProperty('--app-viewport-height', `${viewport.height}px`)
    root.style.setProperty('--app-viewport-width', `${viewport.width}px`)
    root.style.setProperty('--app-viewport-top', `${viewport.top}px`)
    root.style.setProperty('--app-viewport-left', `${viewport.left}px`)
  }

  const scheduleSync = () => {
    if (frame) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(sync)
  }
  const syncWhenVisible = () => {
    if (document.visibilityState === 'visible') scheduleSync()
  }

  sync()
  window.addEventListener('resize', scheduleSync)
  window.addEventListener('orientationchange', scheduleSync)
  window.addEventListener('pageshow', scheduleSync)
  document.addEventListener('visibilitychange', syncWhenVisible)
  window.visualViewport?.addEventListener('resize', scheduleSync)
  window.visualViewport?.addEventListener('scroll', scheduleSync)

  return () => {
    if (frame) cancelAnimationFrame(frame)
    window.removeEventListener('resize', scheduleSync)
    window.removeEventListener('orientationchange', scheduleSync)
    window.removeEventListener('pageshow', scheduleSync)
    document.removeEventListener('visibilitychange', syncWhenVisible)
    window.visualViewport?.removeEventListener('resize', scheduleSync)
    window.visualViewport?.removeEventListener('scroll', scheduleSync)
  }
}
