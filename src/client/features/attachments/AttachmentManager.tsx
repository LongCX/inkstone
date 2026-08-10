import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Sparkles, Trash2 } from 'lucide-react';
import type { AttachmentWithUsage } from '@shared/types';
import { cn } from '../../lib/cn';
import { api } from '../../lib/api';
import { formatBytes } from '../../lib/time';
import { Button, IconButton } from '../../components/primitives';
import { LoadingBlock } from '../../components/feedback';
import { Segmented } from '../../components/form';
import { Drawer, Tooltip, confirm } from '../../components/overlay';
import { useUi } from '../../store/ui';
import { t } from "../../lib/i18n";

type FilterKind = 'all' | 'image' | 'document' | 'other';

export function AttachmentManager({ open, onClose, onChanged, }: {
    open: boolean;
    onClose: () => void;
    onChanged?: () => void;
}) {
    const [files, setFiles] = useState<AttachmentWithUsage[] | null>(null);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState<FilterKind>('all');
    const [busy, setBusy] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const loadEpoch = useRef(0);
    const toast = useUi((s) => s.toast);
    const loadPage = useCallback(async (cursor: string | undefined, epoch: number, signal?: AbortSignal) => {
        try {
            const result = await api.files.list(cursor, signal);
            if (epoch !== loadEpoch.current)
                return false;
            setFiles((previous) => {
                if (!cursor)
                    return result.files;
                const seen = new Set((previous ?? []).map((file) => file.id));
                return [...(previous ?? []), ...result.files.filter((file) => !seen.has(file.id))];
            });
            setNextCursor(result.nextCursor ?? null);
            setError(null);
            return true;
        }
        catch (err) {
            if (epoch !== loadEpoch.current || signal?.aborted)
                return false;
            const message = err instanceof Error ? err.message : String(err);
            if (cursor) {
                toast({ title: t("attachments.load_failed"), description: message, tone: 'danger' });
            }
            else {
                setError(message);
            }
            return false;
        }
    }, [toast]);
    const reloadFiles = useCallback((signal?: AbortSignal) => {
        const epoch = ++loadEpoch.current;
        setFiles(null);
        setNextCursor(null);
        setError(null);
        setLoadingMore(false);
        return loadPage(undefined, epoch, signal);
    }, [loadPage]);
    useEffect(() => {
        if (!open) {
            loadEpoch.current++;
            return;
        }
        const controller = new AbortController();
        void reloadFiles(controller.signal);
        return () => {
            controller.abort();
            loadEpoch.current++;
        };
    }, [open, reloadFiles]);
    const isImage = (file: AttachmentWithUsage) => file.mime.startsWith('image/');
    const isDocument = (file: AttachmentWithUsage) => !isImage(file) && file.mime !== 'application/octet-stream';
    const filtered = useMemo(() => {
        if (!files)
            return [];
        switch (filter) {
            case 'image':
                return files.filter(isImage);
            case 'document':
                return files.filter(isDocument);
            case 'other':
                return files.filter((file) => !isImage(file) && !isDocument(file));
            default:
                return files;
        }
    }, [files, filter]);
    const removeFile = async (file: AttachmentWithUsage) => {
        if (busy || loadingMore)
            return;
        const ok = await confirm({
            title: t("attachments.delete_confirm_value0", { value0: file.filename }),
            confirmLabel: t("attachments.delete"),
            tone: 'danger',
        });
        if (!ok)
            return;
        setBusy(true);
        try {
            await api.files.remove(file.id);
            setFiles((prev) => prev?.filter((item) => item.id !== file.id) ?? null);
            onChanged?.();
            toast({ title: t("attachments.deleted"), tone: 'success' });
        }
        catch (err) {
            toast({
                title: t("attachments.delete_failed"),
                description: err instanceof Error ? err.message : String(err),
                tone: 'danger',
            });
        }
        finally {
            setBusy(false);
        }
    };
    const runCleanup = async () => {
        if (busy || loadingMore)
            return;
        const ok = await confirm({
            title: t("attachments.cleanup_confirm"),
            description: t("attachments.cleanup_confirm_description"),
            confirmLabel: t("attachments.cleanup"),
            tone: 'danger',
        });
        if (!ok)
            return;
        setBusy(true);
        try {
            const result = await api.files.prune();
            await reloadFiles();
            onChanged?.();
            toast({
                title: result.removed
                    ? t("attachments.cleaned_value0", { value0: result.removed })
                    : t("attachments.nothing_to_clean"),
                description: result.removed ? t("attachments.freed_value0", { value0: formatBytes(result.freedBytes) }) : undefined,
                tone: 'success',
            });
        }
        catch (err) {
            toast({
                title: t("attachments.cleanup_failed"),
                description: err instanceof Error ? err.message : String(err),
                tone: 'danger',
            });
        }
        finally {
            setBusy(false);
        }
    };
    const loadMore = async () => {
        if (busy || loadingMore || !nextCursor)
            return;
        setLoadingMore(true);
        const epoch = loadEpoch.current;
        try {
            await loadPage(nextCursor, epoch);
        }
        finally {
            if (epoch === loadEpoch.current)
                setLoadingMore(false);
        }
    };
    return (<Drawer open={open} onClose={onClose} title={t("attachments.manage")} width={420} zIndex={230}>
      <div className="flex h-full flex-col">
        <div className="shrink-0 space-y-2 border-b border-[var(--border-subtle)] p-2">
          <Segmented value={filter} onChange={setFilter} size="sm" options={[
            { value: 'all', label: t("attachments.filter_all") },
            { value: 'image', label: t("attachments.filter_images") },
            { value: 'document', label: t("attachments.filter_documents") },
            { value: 'other', label: t("attachments.filter_other") },
          ]}/>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {error ? (<div className="px-3 py-8 text-center text-[12px] text-[var(--danger)]">
              {error}
            </div>) : files === null ? (<LoadingBlock label={t("common.loading")}/>) : files.length === 0 ? (<div className="px-3 py-10 text-center text-[12px] text-[var(--text-quaternary)]">
              {t("attachments.empty")}
            </div>) : filtered.length === 0 ? (<div className="px-3 py-10 text-center text-[12px] text-[var(--text-quaternary)]">
              {t("attachments.none_match")}
            </div>) : (<div className="grid grid-cols-2 gap-2">
              {filtered.map((file) => (<div key={file.id} className="group overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
                  <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-[var(--bg-sunken)]">
                    {isImage(file) ? (<img src={file.url} alt={file.filename} loading="lazy" className="h-full w-full object-cover"/>) : (<div className="flex flex-col items-center gap-1 text-[var(--text-tertiary)]">
                        <FileText size={26}/>
                        <span className="max-w-[80%] truncate text-[10px]">{file.filename}</span>
                      </div>)}
                    <div className="absolute top-1.5 right-1.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                      <Tooltip label={t("attachments.delete")} side="left">
                        <IconButton label={t("attachments.delete")} size="sm" disabled={busy || loadingMore} onClick={() => void removeFile(file)} className="border border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--shadow-pop)] hover:text-[var(--danger)]">
                          <Trash2 size={13}/>
                        </IconButton>
                      </Tooltip>
                    </div>
                  </div>
                  <div className="space-y-0.5 px-2 py-1.5">
                    <div className="truncate text-[11.5px] text-[var(--text-secondary)]">
                      {file.filename}
                    </div>
                    <div className={cn('flex items-center gap-1 text-[10.5px]', file.references > 0 ? 'text-[var(--text-quaternary)]' : 'text-[var(--warning)]')}>
                      <span className="tabular">{formatBytes(file.size)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{file.references > 0 ? t("attachments.referenced_value0", { value0: file.references }) : t("attachments.unreferenced")}</span>
                    </div>
                  </div>
                </div>))}
            </div>)}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] px-3 py-2">
          <span className="text-[11px] text-[var(--text-quaternary)]">
            {files ? (nextCursor
                ? t("attachments.shown_value0", { value0: filtered.length })
                : t("attachments.total_value0", { value0: filtered.length })) : ''}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {nextCursor ? (<Button size="sm" variant="ghost" loading={loadingMore} disabled={busy} onClick={() => void loadMore()}>
                {t("attachments.load_more")}
              </Button>) : null}
            <Button size="sm" variant="secondary" icon={<Sparkles size={13}/>} loading={busy} disabled={loadingMore} onClick={() => void runCleanup()}>
              {t("attachments.cleanup")}
            </Button>
          </div>
        </div>
      </div>
    </Drawer>);
}
