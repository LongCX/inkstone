import { useEffect, useState } from 'react';
import { ArrowUpRight, Link2 } from 'lucide-react';
import type { Backlink } from '@shared/types';
import { api } from '../../lib/api';
import { Button } from '../../components/primitives';
import { useNotes } from '../../store/notes';
import { t } from "../../lib/i18n";

export function BacklinksPanel({ noteId }: {
    noteId: string;
}) {
    const [links, setLinks] = useState<Backlink[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [reload, setReload] = useState(0);
    const openNote = useNotes((s) => s.openNote);
    const rev = useNotes((s) => s.notes[noteId]?.rev ?? 0);
    const cursor = useNotes((s) => s.cursor);
    useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;
        setLinks(null);
        setLoadError(null);
        api.notes
            .backlinks(noteId, controller.signal)
            .then((res) => {
            if (!cancelled)
                setLinks(res.backlinks);
        })
            .catch((error) => {
            if (!cancelled)
                setLoadError(error instanceof Error ? error.message : String(error));
        });
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [noteId, rev, cursor, reload]);
    return (<section className="max-h-[36%] shrink-0 overflow-y-auto border-t border-[var(--border-subtle)] bg-[var(--bg-base)]">
      <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-[10.5px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
        <Link2 size={11}/>{t("common.backlinks")}{links && links.length > 0 && <span className="tabular">· {links.length}</span>}
      </div>

      {loadError ? (<div className="flex items-center justify-between gap-3 px-3 py-4 text-[12px] text-[var(--text-quaternary)]"><span>{t("workspace.could_not_load_backlinks")}</span><Button size="sm" variant="ghost" onClick={() => setReload((value) => value + 1)}>{t("common.retry")}</Button></div>) : links === null ? (<div className="px-3 py-4 text-[12px] text-[var(--text-quaternary)]">{t("common.loading")}</div>) : links.length === 0 ? (<div className="px-3 py-4 text-[12px] leading-relaxed text-[var(--text-quaternary)]">{t("workspace.no_notes_link_here_yet_write")}{' '}
          <code className="rounded bg-[var(--bg-inset)] px-1 py-0.5 font-mono text-[11px]">{t("workspace.title")}</code>{' '}{t("workspace.will_appear_here")}</div>) : (<ul className="p-2">
          {links.map((link) => (<li key={link.id}>
              <button type="button" onClick={() => void openNote(link.id)} className="group w-full rounded-[var(--r-md)] px-2 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]">
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 truncate text-[12.5px] font-medium text-[var(--text-primary)]">
                    {link.title}
                  </span>
                  <ArrowUpRight size={11} className="shrink-0 text-[var(--text-quaternary)] opacity-0 transition-opacity group-hover:opacity-100"/>
                </div>
                <p className="truncate-2 mt-0.5 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">
                  {link.context}
                </p>
              </button>
            </li>))}
        </ul>)}
    </section>);
}
