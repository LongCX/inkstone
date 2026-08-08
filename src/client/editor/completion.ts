import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { normalizeLinkKey } from '@shared/markdown-utils';
import { truncateText } from '@shared/text-utils';
import { fuzzyMatch } from '../lib/fuzzy';
import { t } from "../lib/i18n";
export interface CompletionSources {
    notes: () => {
        id: string;
        title: string;
        excerpt: string;
    }[];
    tags: () => {
        name: string;
        count: number;
    }[];
}

export function wikiLinkSource(getSources: () => CompletionSources) {
    return (context: CompletionContext): CompletionResult | null => {
        const before = context.matchBefore(/\[\[([^[\]\n]*)$/);
        if (!before)
            return null;
        if (before.from === before.to && !context.explicit)
            return null;
        const query = before.text.slice(2);
        const options: Completion[] = [];
        const seenTitles = new Set<string>();
        for (const note of getSources().notes()) {
            if (!note.title)
                continue;
            const titleKey = normalizeLinkKey(note.title);
            if (seenTitles.has(titleKey))
                continue;
            seenTitles.add(titleKey);
            const match = query ? fuzzyMatch(note.title, query) : { score: 0, ranges: [] };
            if (!match)
                continue;
            options.push({
                label: note.title,
                detail: note.excerpt ? truncateText(note.excerpt, 34) : undefined,
                boost: match.score / 10,
                apply: (view, _completion, from, to) => {
                    const insert = `${note.title}]]`;
                    view.dispatch({
                        changes: { from, to, insert },
                        selection: { anchor: from + insert.length },
                    });
                },
            });
        }
        if (query.trim() && !options.some((o) => o.label === query.trim())) {
            options.push({
                label: query.trim(),
                detail: t("editor.create_new_note"),
                boost: -20,
                apply: (view, _completion, from, to) => {
                    const insert = `${query.trim()}]]`;
                    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
                },
            });
        }
        return {
            from: before.from + 2,
            options: options.slice(0, 24),
            filter: false,
            validFor: /^[^[\]\n]*$/,
        };
    };
}
export function tagSource(getSources: () => CompletionSources) {
    return (context: CompletionContext): CompletionResult | null => {
        const before = context.matchBefore(/(?:^|[\s(\uff08[\u3010>\u300c\u300e\uff0c,\u3001;\uff1b])#([\p{L}\p{N}_\-/·]{0,60})$/u);
        if (!before)
            return null;
        const hashIndex = before.text.lastIndexOf('#');
        const from = before.from + hashIndex + 1;
        const query = before.text.slice(hashIndex + 1);
        const line = context.state.doc.lineAt(context.pos);
        if (from - 1 === line.from && /^#{1,6}\s/.test(line.text))
            return null;
        const options: Completion[] = [];
        for (const tag of getSources().tags()) {
            const match = query ? fuzzyMatch(tag.name, query) : { score: tag.count, ranges: [] };
            if (!match)
                continue;
            options.push({
                label: tag.name,
                detail: t("common.value0_notes", { value0: tag.count }),
                boost: match.score / 10 + Math.min(tag.count, 20) / 10,
                type: 'keyword',
            });
        }
        if (!options.length)
            return null;
        return { from, options: options.slice(0, 20), filter: false, validFor: /^[\p{L}\p{N}_\-/·]{0,60}$/u };
    };
}
const LANGUAGES = [
    'javascript', 'typescript', 'tsx', 'jsx', 'python', 'go', 'rust', 'java', 'kotlin', 'swift',
    'c', 'cpp', 'csharp', 'php', 'ruby', 'sql', 'bash', 'shell', 'powershell', 'json', 'yaml',
    'toml', 'xml', 'html', 'css', 'scss', 'markdown', 'diff', 'dockerfile', 'nginx', 'mermaid',
];
export function codeFenceSource(context: CompletionContext): CompletionResult | null {
    const before = context.matchBefore(/^```([a-zA-Z0-9+#-]*)$/);
    if (!before)
        return null;
    return {
        from: before.from + 3,
        options: LANGUAGES.map((lang) => ({ label: lang, type: 'type' })),
        validFor: /^[a-zA-Z0-9+#-]*$/,
    };
}
