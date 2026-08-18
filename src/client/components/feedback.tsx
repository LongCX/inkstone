import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Info, X, XCircle } from 'lucide-react';
import { cn } from '../lib/cn';
import { useUi, type ToastItem } from '../store/ui';
import { Button } from './primitives';
import { Tooltip } from './overlay';
import { t } from "../lib/i18n";

const TONE_ICON = {
    default: <Info size={14}/>,
    success: <Check size={14}/>,
    warning: <AlertTriangle size={14}/>,
    danger: <XCircle size={14}/>,
};
const TONE_COLOR = {
    default: 'text-[var(--accent)]',
    success: 'text-[var(--success)]',
    warning: 'text-[var(--warning)]',
    danger: 'text-[var(--danger)]',
};
function Toast({ item }: {
    item: ToastItem;
}) {
    const dismiss = useUi((s) => s.dismissToast);
    const [leaving, setLeaving] = useState(false);
    const pausedRef = useRef(false);
    const timerRef = useRef<number>(0);
    const dismissTimerRef = useRef<number>(0);
    useEffect(() => {
        const start = () => {
            timerRef.current = window.setTimeout(() => {
                if (pausedRef.current)
                    return start();
                setLeaving(true);
                dismissTimerRef.current = window.setTimeout(() => dismiss(item.id), 200);
            }, item.duration);
        };
        start();
        return () => {
            window.clearTimeout(timerRef.current);
            window.clearTimeout(dismissTimerRef.current);
        };
    }, [item.id, item.duration, dismiss]);
    return (<div onMouseEnter={() => (pausedRef.current = true)} onMouseLeave={() => (pausedRef.current = false)} className={cn('pointer-events-auto flex w-[min(400px,calc(100vw-32px))] items-start gap-2.5', 'rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-3 pr-2', 'shadow-[var(--shadow-pop)] transition-all duration-200 ease-[var(--ease-out)]', leaving ? 'translate-x-2 opacity-0' : 'anim-slide-right')} role={item.tone === 'danger' ? 'alert' : 'status'}>
      <span className={cn('mt-[1px] shrink-0', TONE_COLOR[item.tone])}>{TONE_ICON[item.tone]}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] leading-snug font-medium text-[var(--text-primary)]">
          {item.title}
        </div>
        {item.description && (<div className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">
            {item.description}
          </div>)}
      </div>
      {item.action && (<Button size="sm" variant="ghost" className="-my-0.5 shrink-0 text-[var(--accent)]" onClick={() => {
                item.action?.run();
                dismiss(item.id);
            }}>
          {item.action.label}
        </Button>)}
      <Tooltip label={t("feedback.dismiss")} side="left">
        <button type="button" onClick={() => dismiss(item.id)} aria-label={t("feedback.dismiss")} className="mt-[1px] shrink-0 rounded p-1 text-[var(--text-quaternary)] transition-colors hover:text-[var(--text-secondary)]">
          <X size={12}/>
        </button>
      </Tooltip>
    </div>);
}
export function Toaster() {
    const toasts = useUi((s) => s.toasts);
    if (typeof document === 'undefined')
        return null;
    return createPortal(<div className="app-viewport-toaster pointer-events-none fixed right-2 bottom-[calc(64px+env(safe-area-inset-bottom))] z-[400] flex flex-col items-end gap-2 md:right-4 md:bottom-4">
      {toasts.map((item) => (<Toast key={item.id} item={item}/>))}
    </div>, document.body);
}

export function Skeleton({ className, style }: {
    className?: string;
    style?: React.CSSProperties;
}) {
    return <div className={cn('skeleton', className)} style={style}/>;
}
export function NoteListSkeleton({ count = 7 }: {
    count?: number;
}) {
    return (<div className="space-y-1 p-2">
      {Array.from({ length: count }, (_, i) => (<div key={i} className="space-y-2 rounded-[var(--r-md)] p-2.5" style={{ opacity: 1 - i * 0.11 }}>
          <Skeleton className="h-[13px]" style={{ width: `${58 + ((i * 13) % 34)}%` }}/>
          <Skeleton className="h-[11px]" style={{ width: `${72 + ((i * 7) % 24)}%` }}/>
          <Skeleton className="h-[10px] w-16"/>
        </div>))}
    </div>);
}
export function EditorSkeleton() {
    return (<div className="mx-auto max-w-[70ch] space-y-3 px-6 py-8">
      <Skeleton className="h-6 w-1/2"/>
      <div className="h-3"/>
      {[92, 100, 78, 96, 64].map((w, i) => (<Skeleton key={i} className="h-[13px]" style={{ width: `${w}%` }}/>))}
      <div className="h-4"/>
      <Skeleton className="h-[13px] w-[86%]"/>
      <Skeleton className="h-[13px] w-[70%]"/>
    </div>);
}
export type EmptyArt = 'notes' | 'search' | 'trash' | 'starred' | 'archive' | 'folder' | 'select' | 'tag';
export function Empty({ art = 'notes', title, description, action, compact, }: {
    art?: EmptyArt;
    title: string;
    description?: ReactNode;
    action?: ReactNode;
    compact?: boolean;
}) {
    return (<div className={cn('flex flex-col items-center justify-center px-8 text-center', compact ? 'py-10' : 'h-full min-h-[240px] py-16')}>
      <EmptyIllustration art={art}/>
      <p className="mt-4 text-[13.5px] font-medium text-[var(--text-secondary)]">{title}</p>
      {description && (<p className="mt-1.5 max-w-[290px] text-[12px] leading-relaxed text-[var(--text-quaternary)]">
          {description}
        </p>)}
      {action && <div className="mt-4">{action}</div>}
    </div>);
}
function EmptyIllustration({ art }: {
    art: EmptyArt;
}) {
    const common = {
        width: 78,
        height: 78,
        viewBox: '0 0 64 64',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.25,
        strokeLinecap: 'round' as const,
        strokeLinejoin: 'round' as const,
        'aria-hidden': true,
        className: 'text-[var(--text-quaternary)] [&>*]:[stroke-dasharray:220] [&>*]:[stroke-dashoffset:220] [&>*]:animate-[ink-draw_900ms_var(--ease-out)_forwards]',
    };
    switch (art) {
        case 'search':
            return (<svg {...common}>
          <circle cx="28" cy="28" r="14"/>
          <path d="M38.5 38.5 50 50"/>
          <path d="M22 28h12M24 23h8" opacity="0.5"/>
        </svg>);
        case 'trash':
            return (<svg {...common}>
          <path d="M17 20h30l-2.5 27a4 4 0 0 1-4 3.6H23.5a4 4 0 0 1-4-3.6z"/>
          <path d="M13 20h38M26 20v-4a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v4"/>
          <path d="M27 29v13M37 29v13" opacity="0.5"/>
        </svg>);
        case 'starred':
            return (<svg {...common}>
          <path d="M32 13.5l5.6 11.7 12.4 1.8-9 9 2.1 12.7L32 42.7l-11.1 6 2.1-12.7-9-9 12.4-1.8z"/>
        </svg>);
        case 'archive':
            return (<svg {...common}>
          <rect x="12" y="16" width="40" height="10" rx="2.5"/>
          <path d="M16 26v22a3 3 0 0 0 3 3h26a3 3 0 0 0 3-3V26"/>
          <path d="M26 34h12" opacity="0.6"/>
        </svg>);
        case 'folder':
            return (<svg {...common}>
          <path d="M11 22a3 3 0 0 1 3-3h11l4.5 5H50a3 3 0 0 1 3 3v20a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3z"/>
          <path d="M11 30h42" opacity="0.5"/>
        </svg>);
        case 'tag':
            return (<svg {...common}>
          <path d="M31 12H16a4 4 0 0 0-4 4v15l21 21 19-19z"/>
          <circle cx="23" cy="23" r="3.5"/>
        </svg>);
        case 'select':
            return (<svg {...common}>
          <rect x="12" y="13" width="26" height="38" rx="3"/>
          <path d="M44 21h8v30a3 3 0 0 1-3 3H26" opacity="0.55"/>
          <path d="M19 24h12M19 31h12M19 38h7" opacity="0.7"/>
        </svg>);
        default:
            return (<svg {...common}>
          <path d="M18 11h20l10 10v32a3 3 0 0 1-3 3H18a3 3 0 0 1-3-3V14a3 3 0 0 1 3-3z"/>
          <path d="M38 11v10h10"/>
          <path d="M23 32h18M23 40h13" opacity="0.65"/>
        </svg>);
    }
}
export function LoadingBlock({ label = t("common.loading") }: {
    label?: string;
}) {
    return (<div role="status" aria-live="polite" className="flex h-full min-h-[160px] flex-col items-center justify-center gap-2.5 text-[var(--text-quaternary)]">
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" className="animate-[ink-spin_.7s_linear_infinite]">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.4" opacity="0.2"/>
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/>
      </svg>
      <span className="text-[12px]">{label}</span>
    </div>);
}
