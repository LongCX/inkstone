import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound, Lock, Moon, Sun } from 'lucide-react';
import { LIMITS } from '@shared/constants';
import type { PublicNote } from '@shared/types';
import { api, ApiError } from '../../lib/api';
import { fullTime } from '../../lib/time';
import { readingMinutes, countText } from '@shared/markdown-utils';
import { renderMarkdown } from '../../lib/markdown/renderer';
import { enhancePreview, renderPendingMermaid, resetMermaidNode } from '../../lib/markdown/enhance';
import { Avatar, Button, Logo } from '../../components/primitives';
import { Input } from '../../components/form';
import { LoadingBlock } from '../../components/feedback';
import { Tooltip } from '../../components/overlay';
import { useUi } from '../../store/ui';
import { moveMarkdownTabFocus, selectMarkdownTab } from '../preview/markdown-tabs';
import { t, useLocale } from "../../lib/i18n";

export function SharePage({ slug }: {
    slug: string;
}) {
    const locale = useLocale();
    const [note, setNote] = useState<PublicNote | null>(null);
    const [needPassword, setNeedPassword] = useState(false);
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark');
    const toast = useUi((s) => s.toast);
    const hostRef = useRef<HTMLDivElement>(null);
    const requestRef = useRef<AbortController | null>(null);
    const enhancementRevisionRef = useRef(0);
    const copyResetTimersRef = useRef(new Map<HTMLElement, number>());
    const originalTitleRef = useRef(document.title);
    const appliedTitleRef = useRef<string | null>(null);
    const load = useCallback(async (pwd?: string) => {
        requestRef.current?.abort();
        const controller = new AbortController();
        requestRef.current = controller;
        setLoading(true);
        setError(null);
        try {
            const result = await api.share.read(slug, pwd, controller.signal);
            if (controller.signal.aborted)
                return;
            setNote(result);
            setNeedPassword(false);
            setPassword('');
            const title = `${result.title || t("common.untitled_note")} · ${result.site.name}`;
            document.title = title;
            appliedTitleRef.current = title;
        }
        catch (err) {
            if (controller.signal.aborted || (err as Error)?.name === 'AbortError')
                return;
            if (err instanceof ApiError && err.status === 401) {
                setNote(null);
                setNeedPassword(true);
                if (pwd)
                    setError(t("share.incorrect_passcode"));
            }
            else {
                setNeedPassword(false);
                setError(err instanceof ApiError ? err.message : t("share.content_unavailable"));
            }
        }
        finally {
            if (requestRef.current === controller) {
                requestRef.current = null;
                setLoading(false);
            }
        }
    }, [slug]);
    useEffect(() => {
        setNote(null);
        setNeedPassword(false);
        setPassword('');
        setError(null);
        void load();
        return () => {
            requestRef.current?.abort();
            requestRef.current = null;
            if (appliedTitleRef.current && document.title === appliedTitleRef.current)
                document.title = originalTitleRef.current;
            appliedTitleRef.current = null;
        };
    }, [load]);
    const rendered = useMemo(() => {
        if (!note)
            return null;
        const result = renderMarkdown(note.content);
        return {
            ...result,
            html: addShareAccess(result.html, note.share.slug),
        };
    }, [note, locale]);
    const htmlObj = useMemo(() => ({ __html: rendered?.html ?? '' }), [rendered]);
    useEffect(() => {
        if (!rendered || !hostRef.current)
            return;
        const host = hostRef.current;
        const revision = ++enhancementRevisionRef.current;
        let cancelled = false;
        const isCurrent = () => !cancelled && enhancementRevisionRef.current === revision && hostRef.current === host;
        void (async () => {
            await enhancePreview(host, { math: true, mermaid: true, dark });
            if (!isCurrent())
                return;
            await renderPendingMermaid(host, dark, { isCurrent });
        })();
        return () => {
            cancelled = true;
        };
    }, [rendered, dark]);
    useEffect(() => () => {
        enhancementRevisionRef.current++;
        for (const timer of copyResetTimersRef.current.values())
            window.clearTimeout(timer);
        copyResetTimersRef.current.clear();
    }, []);
    const onContentClick = (event: React.MouseEvent) => {
        const target = event.target as HTMLElement;
        const mermaidRetry = target.closest<HTMLElement>('[data-mermaid-retry]');
        if (mermaidRetry) {
            const block = mermaidRetry.closest<HTMLElement>('[data-mermaid]');
            const host = hostRef.current;
            if (block && host) {
                resetMermaidNode(block);
                const revision = ++enhancementRevisionRef.current;
                void renderPendingMermaid(host, dark, {
                    isCurrent: () => enhancementRevisionRef.current === revision && hostRef.current === host,
                });
            }
            return;
        }
        const copyButton = target.closest<HTMLElement>('[data-copy]');
        if (copyButton) {
            const code = copyButton.closest('.code-block')?.querySelector('pre')?.textContent ?? '';
            if (!navigator.clipboard?.writeText) {
                toast({ title: t("preview.could_not_copy"), tone: 'danger' });
                return;
            }
            void navigator.clipboard.writeText(code).then(() => {
                if (!hostRef.current?.contains(copyButton))
                    return;
                const existingTimer = copyResetTimersRef.current.get(copyButton);
                if (existingTimer !== undefined)
                    window.clearTimeout(existingTimer);
                copyButton.textContent = t("common.copied");
                copyButton.classList.add('copied');
                const timer = window.setTimeout(() => {
                    if (hostRef.current?.contains(copyButton)) {
                        copyButton.textContent = t("common.copy");
                        copyButton.classList.remove('copied');
                    }
                    copyResetTimersRef.current.delete(copyButton);
                }, 900);
                copyResetTimersRef.current.set(copyButton, timer);
            }).catch(() => toast({ title: t("preview.could_not_copy"), tone: 'danger' }));
            return;
        }
        const tabButton = target.closest<HTMLButtonElement>('[data-tab-button]');
        if (tabButton) {
            event.preventDefault();
            selectMarkdownTab(tabButton);
        }
    };
    const onContentKeyDown = (event: React.KeyboardEvent) => {
        const tab = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tab-button]');
        if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            moveMarkdownTabFocus(tab, event.key);
        }
    };
    const toggleTheme = () => {
        const next = !dark;
        setDark(next);
        document.documentElement.dataset.theme = next ? 'dark' : 'light';
    };
    const stats = note ? countText(note.content) : null;
    return (<div className="min-h-full bg-[var(--bg-base)]">
      <header className="sticky top-0 z-10 border-b border-[var(--border-subtle)] bg-[var(--bg-base)]/85 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex h-12 max-w-[860px] items-center gap-3 px-4 md:px-5">
          <span className="flex items-center gap-1.5 text-[var(--accent)]">
            <Logo size={15}/>
          </span>
          <span className="text-[12.5px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
            {note?.site.name ?? 'Inkstone'}
          </span>
          <span className="flex-1"/>
          <Tooltip label={t("share.switch_theme")} side="left">
            <button type="button" onClick={toggleTheme} aria-label={t("share.switch_theme")} className="inline-flex size-9 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:size-7">
              {dark ? <Sun size={14}/> : <Moon size={14}/>}
            </button>
          </Tooltip>
        </div>
      </header>

      <main className="mx-auto max-w-[860px] px-4 pb-[calc(64px+env(safe-area-inset-bottom))] md:px-5 md:pb-24">
        {loading && !needPassword ? (<div className="pt-24">
            <LoadingBlock label={t("share.opening")}/>
          </div>) : needPassword ? (<div className="anim-rise mx-auto max-w-[340px] pt-[16vh] text-center">
            <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-[16px] border border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-tertiary)]">
              <Lock size={20}/>
            </div>
            <h1 className="text-[16px] font-semibold text-[var(--text-primary)]">{t("share.this_note_requires_a_password")}</h1>
            <p className="mt-1.5 text-[12.5px] text-[var(--text-tertiary)]">{t("share.ask_the_person_who_shared_this_note_for_its_passcode")}</p>
            <form className="mt-5 space-y-2.5" onSubmit={(event) => {
                event.preventDefault();
                void load(password);
            }}>
              <Input aria-label={t("common.access_passcode")} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t("common.access_passcode")} autoComplete="current-password" maxLength={LIMITS.passwordMaxLength} autoFocus leading={<KeyRound size={13}/>} invalid={Boolean(error)}/>
              {error && <p role="alert" className="text-[12px] text-[var(--danger)]">{error}</p>}
              <Button type="submit" variant="primary" block loading={loading}>{t("share.view_content")}</Button>
            </form>
          </div>) : error ? (<div className="mx-auto max-w-[380px] pt-[18vh] text-center">
            <h1 className="text-[16px] font-semibold text-[var(--text-primary)]">{t("share.content_unavailable")}</h1>
            <p role="alert" className="mt-2 text-[13px] leading-relaxed text-[var(--text-tertiary)]">{error}</p>
          </div>) : note ? (<article className="pt-7 md:pt-10">
            <header className="mb-6 md:mb-8">
              <h1 className="text-[26px] leading-[1.25] font-bold tracking-[-0.03em] text-[var(--text-primary)] md:text-[30px]">
                {note.title || t("common.untitled_note")}
              </h1>
              <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-[var(--text-quaternary)]">
                <span className="flex items-center gap-1.5">
                  <Avatar src={note.author.avatarUrl} name={note.author.name} size={18}/>
                  {note.author.name}
                </span>
                <span>·</span>
                <span>{fullTime(note.updatedAt)}</span>
                {stats && (<>
                    <span>·</span>
                    <span>{stats.words}{t("common.words")}</span>
                    <span>·</span>
                    <span>{t("common.about")}{readingMinutes(stats.words)}{t("common.min")}</span>
                  </>)}
              </div>
            </header>

            <div ref={hostRef} onClick={onContentClick} onKeyDown={onContentKeyDown} className="ink-prose" style={{ maxWidth: 'none' }} dangerouslySetInnerHTML={htmlObj}/>

            <footer className="mt-16 border-t border-[var(--border-subtle)] pt-6 text-center">
              <a href="/" className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--text-quaternary)] transition-colors hover:text-[var(--accent)]">
                <Logo size={12}/>{t("share.shared_via_site", { site: note.site.name })}</a>
            </footer>
          </article>) : null}
      </main>
    </div>);
}
function addShareAccess(html: string, slug: string): string {
    const template = document.createElement('template');
    template.innerHTML = html;
    for (const embed of template.content.querySelectorAll<HTMLElement>('.note-embed[data-embed-target]')) {
        embed.removeAttribute('data-embed-target');
        embed.classList.remove('loading');
        embed.classList.add('error');
        const body = embed.querySelector<HTMLElement>('.note-embed-body');
        if (body) {
            body.removeAttribute('aria-busy');
            body.textContent = t("share.embedded_private_notes_are_not_included_in_public_shares");
        }
    }
    for (const task of template.content.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox')) {
        task.disabled = true;
        task.removeAttribute('data-task-line');
        task.setAttribute('aria-label', t("share.tasks_in_public_shares_are_read_only"));
    }
    for (const element of template.content.querySelectorAll<HTMLImageElement | HTMLAnchorElement>('img[src], a[href]')) {
        const attr = element instanceof HTMLImageElement ? 'src' : 'href';
        const raw = element.getAttribute(attr);
        if (!raw)
            continue;
        try {
            const url = new URL(raw, window.location.origin);
            if (url.origin !== window.location.origin ||
                !/^\/api\/files\/[0-9a-hjkmnp-tv-z]{26}$/i.test(url.pathname)) {
                continue;
            }
            url.searchParams.set('share', slug);
            element.setAttribute(attr, `${url.pathname}${url.search}`);
        }
        catch {
        }
    }
    return template.innerHTML;
}
