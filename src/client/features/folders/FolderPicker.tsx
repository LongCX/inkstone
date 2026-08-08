import { useMemo, useState } from 'react';
import { Check, FolderClosed, Search } from 'lucide-react';
import type { Folder } from '@shared/types';
import { ORGANIZER_COLORS } from '@shared/organizer-colors';
import { Drawer } from '../../components/overlay';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import { folderPathLabel } from '../../lib/folders';

export function FolderPicker({
    open,
    title,
    folders,
    currentId,
    excludedIds,
    allowRoot = true,
    rootLabel,
    onSelect,
    onClose,
}: {
    open: boolean;
    title: string;
    folders: Folder[];
    currentId?: string | null;
    excludedIds?: ReadonlySet<string>;
    allowRoot?: boolean;
    rootLabel?: string;
    onSelect: (folderId: string | null) => void;
    onClose: () => void;
}) {
    const [query, setQuery] = useState('');
    const choices = useMemo(() => {
        const normalized = query.trim().toLocaleLowerCase();
        return (folders ?? [])
            .map((folder) => ({ folder, path: folderPathLabel(folders, folder.id) }))
            .filter(({ folder, path }) => !excludedIds?.has(folder.id) && (!normalized || path.toLocaleLowerCase().includes(normalized)))
            .sort((a, b) => a.path.localeCompare(b.path));
    }, [excludedIds, folders, query]);
    const choose = (folderId: string | null) => {
        if (folderId !== currentId)
            onSelect(folderId);
        setQuery('');
        onClose();
    };
    return (<Drawer open={open} onClose={() => {
        setQuery('');
        onClose();
    }} title={title} width={420}>
      <div className="sticky top-0 z-10 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
        <label className="relative block">
          <Search size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--text-quaternary)]"/>
          <span className="sr-only">{t("folders.search")}</span>
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("folders.search")} className="h-10 w-full rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-base)] pr-3 pl-9 text-[13px] outline-none focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-ring)]"/>
        </label>
      </div>
      <div className="space-y-1 p-2">
        {allowRoot && !query.trim() && (<FolderChoice label={rootLabel ?? t("folders.top_level")} selected={currentId === null} onClick={() => choose(null)}/>)}
        {choices.map(({ folder, path }) => (<FolderChoice key={folder.id} label={path} icon={folder.icon} color={folder.color} selected={currentId === folder.id} onClick={() => choose(folder.id)}/>))}
        {choices.length === 0 && (query.trim() || !allowRoot) && (<p className="px-3 py-10 text-center text-[12.5px] text-[var(--text-quaternary)]">{t("folders.no_match")}</p>)}
      </div>
    </Drawer>);
}

function FolderChoice({ label, icon, color, selected, onClick }: {
    label: string;
    icon?: string | null;
    color?: string | null;
    selected: boolean;
    onClick: () => void;
}) {
    return (<button type="button" aria-pressed={selected} onClick={onClick} className={cn('flex min-h-11 w-full items-center gap-3 rounded-[var(--r-md)] px-3 text-left transition-colors', selected ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
      <span className="flex size-6 shrink-0 items-center justify-center" style={{ color: color ?? 'var(--text-tertiary)' }}>
        {icon
            ? <span className="text-[15px] leading-none">{icon}</span>
            : <FolderClosed size={16}/>}
      </span>
      <span className="min-w-0 flex-1 break-words text-[13px]">{label}</span>
      {selected && <Check size={15} className="shrink-0 text-[var(--accent)]"/>}
    </button>);
}

const FOLDER_ICONS = ['📁', '📚', '💼', '🧠', '💡', '🎯', '🗂️', '✨'] as const;

export function FolderAppearance({
    open,
    folder,
    onChange,
    onClose,
}: {
    open: boolean;
    folder: Folder | null;
    onChange: (patch: { icon?: string | null; color?: string | null }) => void;
    onClose: () => void;
}) {
    return (<Drawer open={open} onClose={onClose} title={t("folders.appearance")} width={380}>
      {folder && <div className="space-y-7 p-4">
        <section>
          <h3 className="mb-3 text-[12px] font-semibold text-[var(--text-secondary)]">{t("folders.icon")}</h3>
          <div className="grid grid-cols-5 gap-2">
            <AppearanceChoice selected={!folder.icon} label={t("folders.no_icon")} onClick={() => onChange({ icon: null })}>
              <FolderClosed size={17}/>
            </AppearanceChoice>
            {FOLDER_ICONS.map((icon) => (<AppearanceChoice key={icon} selected={folder.icon === icon} label={icon} onClick={() => onChange({ icon })}>
              <span className="text-[17px]">{icon}</span>
            </AppearanceChoice>))}
          </div>
        </section>
        <section>
          <h3 className="mb-3 text-[12px] font-semibold text-[var(--text-secondary)]">{t("folders.color")}</h3>
          <div className="grid grid-cols-6 gap-3">
            <button type="button" aria-label={t("folders.no_color")} aria-pressed={!folder.color} onClick={() => onChange({ color: null })} className={cn('flex size-10 items-center justify-center rounded-full border bg-[var(--bg-base)] text-[var(--text-quaternary)] transition-transform hover:scale-105', !folder.color ? 'border-[var(--accent)] ring-2 ring-[var(--accent-ring)]' : 'border-[var(--border-default)]')}>
              <FolderClosed size={16}/>
            </button>
            {ORGANIZER_COLORS.map((color) => (<button key={color} type="button" aria-label={color} aria-pressed={folder.color === color} onClick={() => onChange({ color })} className={cn('flex size-10 items-center justify-center rounded-full transition-transform hover:scale-105', folder.color === color && 'ring-2 ring-[var(--accent-ring)] ring-offset-2 ring-offset-[var(--bg-surface)]')} style={{ backgroundColor: color }}>
              {folder.color === color && <Check size={16} className="text-white"/>}
            </button>))}
          </div>
        </section>
      </div>}
    </Drawer>);
}

function AppearanceChoice({ selected, label, onClick, children }: {
    selected: boolean;
    label: string;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (<button type="button" aria-label={label} aria-pressed={selected} onClick={onClick} className={cn('flex h-11 items-center justify-center rounded-[var(--r-md)] border bg-[var(--bg-base)] transition-colors hover:bg-[var(--bg-hover)]', selected ? 'border-[var(--accent)] ring-2 ring-[var(--accent-ring)]' : 'border-[var(--border-default)]')}>
      {children}
    </button>);
}
