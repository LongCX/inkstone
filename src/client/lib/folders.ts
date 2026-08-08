import type { Folder } from '@shared/types';
import { useUi } from '../store/ui';

export function folderDescendantIds(folders: Folder[], rootId: string): Set<string> {
    const children = new Map<string, string[]>();
    for (const folder of folders) {
        if (!folder.parentId)
            continue;
        const siblings = children.get(folder.parentId) ?? [];
        siblings.push(folder.id);
        children.set(folder.parentId, siblings);
    }
    const ids = new Set<string>();
    const pending = [rootId];
    while (pending.length) {
        const id = pending.pop()!;
        if (ids.has(id))
            continue;
        ids.add(id);
        pending.push(...(children.get(id) ?? []));
    }
    return ids;
}

export function folderPath(folders: Folder[], folderId: string | null): Folder[] {
    if (!folderId)
        return [];
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const path: Folder[] = [];
    const visited = new Set<string>();
    let cursor: string | null = folderId;
    while (cursor && !visited.has(cursor)) {
        visited.add(cursor);
        const folder = byId.get(cursor);
        if (!folder)
            break;
        path.unshift(folder);
        cursor = folder.parentId;
    }
    return path;
}

export function folderPathLabel(folders: Folder[], folderId: string | null, separator = ' / '): string {
    return folderPath(folders, folderId).map((folder) => folder.name).join(separator);
}

export function openFolderView(folders: Folder[], folderId: string): void {
    const ancestors = folderPath(folders, folderId).slice(0, -1).map((folder) => folder.id);
    if (ancestors.length) {
        useUi.setState((state) => ({
            expandedFolders: [...new Set([...state.expandedFolders, ...ancestors])],
        }));
    }
    useUi.getState().openView('folder', { folderId });
}
