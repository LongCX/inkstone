import { LIMITS } from '@shared/constants'
import { replaceTagInContent, sortTagNames } from '@shared/markdown-utils'
import type { NoteSummary, Tag } from '@shared/types'
import { confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { setOptimisticTagCache, useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'

const TAG_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

export function normalizeTagName(value: string): string | null {
  const name = value.trim().replace(/^#+/, '')
  if (!name || /[\s#]/.test(name) || name.length > LIMITS.tagNameMaxLength) return null
  return name
}

export function createTag(value: string): string | null {
  const name = normalizeTagName(value)
  if (!name) {
    useUi.getState().toast({ title: t('tags.invalid_name'), tone: 'danger' })
    return null
  }
  const existing = useNotes.getState().tags.find((tag) =>
    tag.name.localeCompare(name, undefined, { sensitivity: 'base' }) === 0)
  if (existing) return existing.id

  const id = newTagId()
  const optimistic: Tag = { id, name, color: null, count: 0, createdAt: Date.now() }
  setOptimisticTagCache((state) => ({ tags: [...state.tags, optimistic] }))
  void api.tags.create({ id, name }).then(async () => {
    await useNotes.getState().refreshTags()
  }).catch(async (error) => {
    setOptimisticTagCache((state) => ({
      tags: state.tags.filter((tag) => tag.id !== id),
    }))
    await useNotes.getState().refreshTags()
    useUi.getState().toast({
      title: t('tags.create_failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
  })
  return id
}

export async function renameTag(tag: Tag, value: string): Promise<void> {
  const next = normalizeTagName(value)
  if (!next) {
    useUi.getState().toast({ title: t('tags.invalid_name'), tone: 'danger' })
    return
  }
  if (next === tag.name) return
  const tags = useNotes.getState().tags
  const target = tags.find((candidate) => candidate.id !== tag.id
    && candidate.name.localeCompare(next, undefined, { sensitivity: 'base' }) === 0)
  if (target) {
    const merge = await confirm({
      title: t('tags.merge_confirm_value0_value1', { value0: tag.name, value1: target.name }),
      description: t('tags.merge_description'),
      confirmLabel: t('tags.merge'),
    })
    if (!merge) return
  }

  const destination = target?.name ?? next
  const before = useNotes.getState()
  const beforeUi = useUi.getState()
  setOptimisticTagCache((state) => ({
    tags: optimisticRenameTags(state.tags, tag.id, destination),
    notes: rewriteNoteSummaryTags(state.notes, tag.name, destination),
  }))
  if (beforeUi.view === 'tag' && beforeUi.tag === tag.name) {
    beforeUi.openView('tag', { tag: destination })
  }
  try {
    const result = await api.tags.patch(tag.id, { name: next })
    await useNotes.getState().pull({ force: true })
    rewriteLoadedNoteContents(tag.name, destination)
    useUi.getState().toast({
      title: t('tags.renamed'),
      description: t('tags.updated_note_bodies_value0', {
        value0: 'renamed' in result ? result.renamed : tag.count,
      }),
      tone: 'success',
    })
  } catch (error) {
    setOptimisticTagCache(() => ({ tags: before.tags, notes: before.notes }))
    const ui = useUi.getState()
    if (ui.view === 'tag' && ui.tag === destination) {
      ui.openView(beforeUi.view, { folderId: beforeUi.folderId, tag: beforeUi.tag })
    }
    ui.toast({
      title: t('tags.rename_failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
  }
}

export async function deleteTag(tag: Tag): Promise<void> {
  const ok = await confirm({
    title: t('tags.delete_confirm_value0', { value0: tag.name }),
    description: t('tags.delete_description_value0', { value0: tag.count }),
    tone: 'danger',
    confirmLabel: t('tags.delete'),
  })
  if (!ok) return

  const before = useNotes.getState()
  const beforeUi = useUi.getState()
  setOptimisticTagCache((state) => ({
    tags: state.tags.filter((candidate) => candidate.id !== tag.id),
    notes: rewriteNoteSummaryTags(state.notes, tag.name, null),
  }))
  if (beforeUi.view === 'tag' && beforeUi.tag === tag.name) beforeUi.openView('all')
  try {
    const result = await api.tags.remove(tag.id)
    await useNotes.getState().pull({ force: true })
    rewriteLoadedNoteContents(tag.name, null)
    useUi.getState().toast({
      title: t('tags.deleted'),
      description: t('tags.updated_note_bodies_value0', { value0: result.affected }),
      tone: 'success',
    })
  } catch (error) {
    setOptimisticTagCache(() => ({ tags: before.tags, notes: before.notes }))
    const ui = useUi.getState()
    if (beforeUi.view === 'tag' && ui.view === 'all') ui.openView('tag', { tag: tag.name })
    ui.toast({
      title: t('tags.delete_failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
  }
}

export async function setTagColor(tag: Tag, color: string | null): Promise<void> {
  if (tag.color === color) return
  const previousColor = tag.color
  setOptimisticTagCache((state) => ({
    tags: state.tags.map((candidate) => candidate.id === tag.id ? { ...candidate, color } : candidate),
  }))
  try {
    await api.tags.patch(tag.id, { color })
    await useNotes.getState().refreshTags()
  } catch (error) {
    setOptimisticTagCache((state) => ({
      tags: state.tags.map((candidate) => candidate.id === tag.id
        ? { ...candidate, color: previousColor }
        : candidate),
    }))
    useUi.getState().toast({
      title: t('tags.color_failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
  }
}

function optimisticRenameTags(tags: Tag[], sourceId: string, destination: string): Tag[] {
  const source = tags.find((tag) => tag.id === sourceId)
  if (!source) return tags
  const target = tags.find((tag) => tag.id !== sourceId
    && tag.name.localeCompare(destination, undefined, { sensitivity: 'base' }) === 0)
  if (!target) return tags.map((tag) => tag.id === sourceId ? { ...tag, name: destination } : tag)
  return tags
    .filter((tag) => tag.id !== sourceId)
    .map((tag) => tag.id === target.id ? { ...tag, count: Math.max(tag.count, source.count) } : tag)
}

function rewriteNoteSummaryTags(
  notes: Record<string, NoteSummary>,
  from: string,
  to: string | null,
): Record<string, NoteSummary> {
  const next = { ...notes }
  for (const [id, note] of Object.entries(notes)) {
    if (!note.tags.includes(from)) continue
    const names = note.tags.flatMap((name) => name === from ? (to ? [to] : []) : [name])
    const unique = new Map(names.map((name) => [name.normalize('NFKC').toLocaleLowerCase(), name]))
    next[id] = { ...note, tags: sortTagNames(unique.values()) }
  }
  return next
}

function rewriteLoadedNoteContents(from: string, to: string | null): void {
  const state = useNotes.getState()
  for (const [id, content] of Object.entries(state.contents)) {
    const rewritten = replaceTagInContent(content, from, to)
    if (rewritten !== content) state.editContent(id, rewritten)
  }
}

function newTagId(): string {
  let timestamp = ''
  let value = Date.now()
  for (let index = 0; index < 10; index++) {
    timestamp = TAG_ID_ALPHABET[value % 32] + timestamp
    value = Math.floor(value / 32)
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let random = ''
  for (const byte of bytes) random += TAG_ID_ALPHABET[byte & 31]
  return timestamp + random
}
