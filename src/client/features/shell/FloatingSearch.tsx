import { Search } from 'lucide-react';
import { cn } from '../../lib/cn';
import { IS_MAC } from '../../lib/hotkeys';
import { useUi } from '../../store/ui';
import { t } from "../../lib/i18n";


export function FloatingSearch({ compact = false }: {
    compact?: boolean;
}) {
    const openPanel = useUi((s) => s.openPanel);
    return (<div className={cn('group/search absolute z-50', compact ? 'right-3 bottom-[calc(64px+env(safe-area-inset-bottom))]' : 'top-2 left-1/2 -translate-x-1/2')}>
      <button type="button" onClick={() => openPanel('command')} aria-label={t("common.search_notes_or_run_a_command")} className={cn('flex h-8 w-8 items-center overflow-hidden rounded-full', 'border border-[var(--border-default)] bg-[var(--bg-overlay)]/94 text-[var(--text-tertiary)]', 'shadow-[var(--shadow-pop)] backdrop-blur-xl', 'transition-[width,border-color,color,box-shadow] duration-200 ease-[var(--ease-out)]', 'hover:w-[min(360px,calc(100vw-24px))] hover:border-[var(--accent)] hover:text-[var(--text-primary)]', 'focus-visible:w-[min(360px,calc(100vw-24px))] focus-visible:border-[var(--accent)] focus-visible:outline-none')}>
        <span className="flex size-[30px] shrink-0 items-center justify-center">
          <Search size={14}/>
        </span>
        <span className="min-w-0 flex-1 whitespace-nowrap pr-3 text-left text-[12px] opacity-0 transition-opacity duration-150 group-hover/search:opacity-100 group-focus-within/search:opacity-100">{t("shell.search_notes_or_run_a_command")}</span>
        <kbd className="mr-2 hidden shrink-0 rounded-[4px] border border-[var(--border-default)] px-1 py-px text-[10px] text-[var(--text-quaternary)] group-hover/search:block group-focus-within/search:block">
          {IS_MAC ? '⌘K' : 'Ctrl K'}
        </kbd>
      </button>
    </div>);
}
