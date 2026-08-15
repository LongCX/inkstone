import { Component, type ErrorInfo, type ReactNode } from 'react'
import { CircleAlert } from 'lucide-react'
import { t } from '../lib/i18n'

interface ErrorBoundaryProps {
  children: ReactNode
  fallback?: ReactNode
  onError?: (error: Error, info: ErrorInfo) => void
}

interface ErrorBoundaryState {
  hasError: boolean
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info)
    console.error('[inkstone] Render error caught by boundary:', error, info)
  }

  handleReload = (): void => {
    this.setState({ hasError: false })
    window.location.reload()
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children

    if (this.props.fallback) return this.props.fallback

    return (
      <div
        role="alert"
        className="flex h-full min-h-[240px] flex-col items-center justify-center gap-3 bg-[var(--bg-base)] px-6 text-center"
      >
        <div className="flex size-12 items-center justify-center rounded-full bg-[var(--danger-soft)] text-[var(--danger)]">
          <CircleAlert size={22} aria-hidden="true" />
        </div>
        <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
          {t('app.something_went_wrong')}
        </h2>
        <p className="max-w-[320px] text-[12.5px] leading-relaxed text-[var(--text-tertiary)]">
          {t('app.error_boundary_description')}
        </p>
        <button
          type="button"
          onClick={this.handleReload}
          className="mt-2 inline-flex h-9 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent)] px-4 text-[12.5px] font-semibold text-white transition-colors hover:bg-[var(--accent-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
        >
          {t('app.reload')}
        </button>
      </div>
    )
  }
}

export function InlineErrorBoundary({ children, label }: {
  children: ReactNode
  label?: string
}): ReactNode {
  return (
    <ErrorBoundary
      fallback={
        <div className="flex h-full min-h-[120px] items-center justify-center px-4 text-center text-[12.5px] text-[var(--text-tertiary)]">
          {label ?? t('app.section_unavailable')}
        </div>
      }
    >
      {children}
    </ErrorBoundary>
  )
}
