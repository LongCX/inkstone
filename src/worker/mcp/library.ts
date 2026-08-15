import { LIMITS } from '@shared/constants'
import { parseFrontMatter } from '@shared/markdown-utils'
import { organizerColorOrNull } from '@shared/organizer-colors'
import type { BackupRun } from '@shared/types'
import { stringify as stringifyYaml } from 'yaml'
import { readAttachmentObject } from '../attachments/backend'
import { drainAttachmentCleanup } from '../attachments/cleanup'
import { attachmentCleanupTarget, attachmentObjectKey, type AttachmentObjectStorage } from '../attachments/keys'
import { persistAttachmentWithinQuota } from '../attachments/storage'
import { runBackup } from '../backup/engine'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { fromBase64, sha256Hex, toBase64 } from '../lib/encoding'
import { isValidId, newId, newSlug } from '../lib/id'
import { broadcastUserCursor } from '../lib/notify'
import { hashPassword } from '../lib/password'
import { consumeAttemptBudget, ThrottleError } from '../lib/throttle'
import { runIdempotent } from './operations'
import { folderPromotionOrder } from '../routes/folders'
import { rewriteTagInNotes } from '../routes/tags'
import { createMcpNote, editMcpNote, organizeMcpNote, type McpWriteContext } from './writes'

interface LibraryContext extends McpWriteContext {
  origin: string
}

interface FolderRow {
  id: string
  parent_id: string | null
  name: string
  icon: string | null
  color: string | null
  position: number
  created_at: number
  updated_at: number
}

export async function duplicateMcpNote(
  context: LibraryContext,
  input: { operationId: string; noteId: string },
) {
  const source = await context.env.DB.prepare(
    `SELECT title, content, folder_id FROM notes
      WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
  ).bind(input.noteId, context.userId).first<{
    title: string
    content: string
    folder_id: string | null
  }>()
  if (!source) throw ApiError.notFound('Note not found')
  return createMcpNote(context, {
    operationId: input.operationId,
    title: duplicateTitle(source.title),
    content: source.content,
    folderId: source.folder_id,
  })
}

export async function listMcpNoteVersions(
  db: D1Database,
  userId: string,
  noteId: string,
  limit = 20,
) {
  await requireOwnedNote(db, userId, noteId)
  const { results } = await db.prepare(
    `SELECT id, title, size, created_at FROM note_versions
      WHERE note_id = ?1 AND user_id = ?2
      ORDER BY created_at DESC, id DESC LIMIT ?3`,
  ).bind(noteId, userId, Math.max(1, Math.min(50, limit))).all<{
    id: string
    title: string
    size: number
    created_at: number
  }>()
  return {
    versions: results.map((row) => ({
      id: row.id,
      note_id: noteId,
      title: row.title,
      size: row.size,
      created_at: new Date(row.created_at).toISOString(),
    })),
  }
}

export async function readMcpNoteVersion(
  db: D1Database,
  userId: string,
  noteId: string,
  versionId: string,
) {
  const row = await db.prepare(
    `SELECT v.id, v.title, v.content, v.size, v.created_at
       FROM note_versions v JOIN notes n ON n.id = v.note_id
      WHERE v.id = ?1 AND v.note_id = ?2 AND v.user_id = ?3 AND n.user_id = ?3`,
  ).bind(versionId, noteId, userId).first<{
    id: string
    title: string
    content: string
    size: number
    created_at: number
  }>()
  if (!row) throw ApiError.notFound('Note version not found')
  return {
    id: row.id,
    note_id: noteId,
    title: row.title,
    content: row.content,
    size: row.size,
    created_at: new Date(row.created_at).toISOString(),
  }
}

export async function restoreMcpNoteVersion(
  context: LibraryContext,
  input: { operationId: string; noteId: string; versionId: string; expectedRev: number },
) {
  const version = await readMcpNoteVersion(
    context.env.DB,
    context.userId,
    input.noteId,
    input.versionId,
  )
  return editMcpNote(context, {
    operationId: input.operationId,
    noteId: input.noteId,
    expectedRev: input.expectedRev,
    operation: 'replace_all',
    text: version.content,
    title: version.title,
  })
}

export async function getMcpNoteProperties(db: D1Database, userId: string, noteId: string) {
  const row = await db.prepare(
    `SELECT title, content, rev FROM notes WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
  ).bind(noteId, userId).first<{ title: string; content: string; rev: number }>()
  if (!row) throw ApiError.notFound('Note not found')
  const parsed = parseFrontMatter(row.content)
  if (parsed.errors.length) throw ApiError.conflict('The note has invalid Front Matter', { errors: parsed.errors })
  return { note_id: noteId, title: row.title, rev: row.rev, properties: parsed.data }
}

export async function updateMcpNoteProperties(
  context: LibraryContext,
  input: {
    operationId: string
    noteId: string
    expectedRev: number
    properties: Record<string, unknown>
    mode: 'merge' | 'replace'
  },
) {
  const row = await context.env.DB.prepare(
    `SELECT content FROM notes WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
  ).bind(input.noteId, context.userId).first<{ content: string }>()
  if (!row) throw ApiError.notFound('Note not found')
  const parsed = parseFrontMatter(row.content)
  if (parsed.errors.length) throw ApiError.conflict('The note has invalid Front Matter', { errors: parsed.errors })
  const properties = input.mode === 'replace' ? input.properties : { ...parsed.data, ...input.properties }
  for (const [key, value] of Object.entries(properties)) {
    if (!key.trim() || key.length > 120) throw ApiError.badRequest('Property names must be 1-120 characters')
    assertPropertyValue(value, 0)
  }
  const yaml = stringifyYaml(properties, { lineWidth: 0 }).trimEnd()
  if (new TextEncoder().encode(yaml).byteLength > 64 * 1024) {
    throw ApiError.tooLarge('Front Matter exceeds the 64 KiB limit')
  }
  const content = Object.keys(properties).length
    ? `---\n${yaml}\n---\n${parsed.body.replace(/^\n/, '')}`
    : parsed.body.replace(/^\n/, '')
  return editMcpNote(context, {
    operationId: input.operationId,
    noteId: input.noteId,
    expectedRev: input.expectedRev,
    operation: 'replace_all',
    text: content,
  })
}

export async function queryMcpNoteProperties(
  db: D1Database,
  userId: string,
  input: {
    conditions: Array<{ key: string; operator: 'exists' | 'equals' | 'contains'; value?: unknown }>
    limit?: number
  },
) {
  const { results } = await db.prepare(
    `SELECT id, title, content, rev, updated_at FROM notes
      WHERE user_id = ?1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 500`,
  ).bind(userId).all<{ id: string; title: string; content: string; rev: number; updated_at: number }>()
  const limit = Math.max(1, Math.min(50, input.limit ?? 20))
  const matches = []
  for (const note of results) {
    const parsed = parseFrontMatter(note.content)
    if (parsed.errors.length) continue
    const accepted = input.conditions.every((condition) => propertyMatches(parsed.data, condition))
    if (!accepted) continue
    matches.push({
      id: note.id,
      title: note.title,
      rev: note.rev,
      updated_at: new Date(note.updated_at).toISOString(),
      properties: parsed.data,
    })
    if (matches.length >= limit) break
  }
  return { results: matches, scanned: results.length, scan_limit: 500 }
}

export async function createMcpFolder(
  context: LibraryContext,
  input: {
    operationId: string
    folderId?: string
    name: string
    parentId?: string | null
    icon?: string | null
    color?: string | null
  },
) {
  const id = input.folderId ?? newId()
  if (!isValidId(id)) throw ApiError.badRequest('folder_id must be a valid Inkstone id')
  const request = { ...input, folderId: id }
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'create_folder',
    request,
    recovery: { folderId: id },
    recover: async () => {
      const folder = await loadFolderOrNull(context.env.DB, context.userId, id)
      if (!folder) return null
      const matches = folder.parent_id === (input.parentId ?? null)
        && folder.name.toLowerCase() === normalizeFolderName(input.name).toLowerCase()
        && folder.icon === (input.icon ?? null)
        && folder.color === (input.color ?? null)
      return matches ? folder : null
    },
    execute: async () => {
      const name = normalizeFolderName(input.name)
      await validateFolderParent(context.env.DB, context.userId, input.parentId ?? null)
      const collision = await context.env.DB.prepare(`SELECT 1 FROM folders WHERE id = ?1`)
        .bind(id).first()
      if (collision) throw ApiError.conflict('This folder id is already in use')
      const now = Date.now()
      const inserted = await context.env.DB.prepare(
        `INSERT INTO folders (id, user_id, parent_id, name, icon, color, position, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6,
           COALESCE(MAX(position), 0) + 1000, ?7, ?7 FROM folders
          WHERE user_id = ?2 AND parent_id IS ?3
            AND (?3 IS NULL OR EXISTS (SELECT 1 FROM folders
              WHERE id = ?3 AND user_id = ?2 AND deleted_at IS NULL))
            AND NOT EXISTS (SELECT 1 FROM folders
              WHERE user_id = ?2 AND parent_id IS ?3 AND lower(name) = lower(?4) AND deleted_at IS NULL)`,
      ).bind(id, context.userId, input.parentId ?? null, name, input.icon ?? null, input.color ?? null, now).run()
      if (!inserted.meta.changes) throw ApiError.conflict('A sibling folder already uses this name')
      await recordChange(context, 'folder', id, 'upsert', now)
      return (await loadFolderOrNull(context.env.DB, context.userId, id))!
    },
  })
}

export async function createMcpTag(
  context: LibraryContext,
  input: { operationId: string; tagId?: string; name: string; color?: string | null },
) {
  const id = input.tagId ?? newId()
  if (!isValidId(id)) throw ApiError.badRequest('tag_id must be a valid Inkstone id')
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'create_tag',
    request: { ...input, tagId: id },
    recovery: { tagId: id },
    recover: async () => {
      const tag = await loadTagOrNull(context.env.DB, context.userId, id)
      if (!tag) return null
      const matches = tag.name.toLowerCase() === normalizeTagName(input.name).toLowerCase()
        && tag.color === organizerColorOrNull(input.color)
      return matches ? tag : null
    },
    execute: async () => {
      const name = normalizeTagName(input.name)
      const now = Date.now()
      const inserted = await context.env.DB.prepare(
        `INSERT INTO tags (id, user_id, name, color, is_manual, created_at)
         SELECT ?1, ?2, ?3, ?4, 1, ?5
          WHERE NOT EXISTS (SELECT 1 FROM tags WHERE user_id = ?2 AND name = ?3 COLLATE NOCASE)`,
      ).bind(id, context.userId, name, organizerColorOrNull(input.color), now).run()
      if (!inserted.meta.changes) throw ApiError.conflict('A tag with this name already exists')
      await recordChange(context, 'tag', id, 'upsert', now)
      return (await loadTagOrNull(context.env.DB, context.userId, id))!
    },
  })
}

export async function updateMcpTag(
  context: LibraryContext,
  input: { operationId: string; tagId: string; name?: string; color?: string | null },
) {
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'update_tag',
    request: input,
    execute: async () => {
      const tag = await loadTagOrNull(context.env.DB, context.userId, input.tagId)
      if (!tag) throw ApiError.notFound('Tag not found')
      const color = input.color === undefined ? tag.color : organizerColorOrNull(input.color)
      if (input.name === undefined || normalizeTagName(input.name) === tag.name) {
        if (color !== tag.color) {
          const now = Date.now()
          const updated = await context.env.DB.prepare(
            `UPDATE tags SET color = ?1, is_manual = 1 WHERE id = ?2 AND user_id = ?3 AND color IS ?4`,
          ).bind(color, tag.id, context.userId, tag.color).run()
          if (!updated.meta.changes) throw ApiError.conflict('The tag changed elsewhere')
          await recordChange(context, 'tag', tag.id, 'upsert', now)
        }
        return { ok: true, affected: 0, tag: (await loadTagOrNull(context.env.DB, context.userId, tag.id))! }
      }

      const next = normalizeTagName(input.name)
      const existing = await loadTagByName(context.env.DB, context.userId, next, tag.id)
      const destinationName = existing?.name ?? next
      const rewrite = await rewriteTagInNotes(
        context.env,
        context.ftsEnabled,
        context.userId,
        tag.id,
        tag.name,
        destinationName,
      )
      try {
        const destination = await loadTagByName(context.env.DB, context.userId, destinationName)
        const now = Date.now()
        if (destination && destination.id !== tag.id) {
          const results = await context.env.DB.batch([
            context.env.DB.prepare(
              `INSERT OR IGNORE INTO note_tags (note_id, tag_id)
               SELECT note_id, ?1 FROM note_tags WHERE tag_id = ?2`,
            ).bind(destination.id, tag.id),
            context.env.DB.prepare(`DELETE FROM note_tags WHERE tag_id = ?1`).bind(tag.id),
            context.env.DB.prepare(
              `UPDATE tags SET color = COALESCE(?1, color), is_manual = 1 WHERE id = ?2 AND user_id = ?3`,
            ).bind(color, destination.id, context.userId),
            context.env.DB.prepare(`DELETE FROM tags WHERE id = ?1 AND user_id = ?2`).bind(tag.id, context.userId),
          ])
          if (!results[3]?.meta.changes) throw ApiError.conflict('The tag changed elsewhere')
          await recordChange(context, 'tag', destination.id, 'upsert', now)
          await recordChange(context, 'tag', tag.id, 'delete', now)
          return {
            ok: true,
            affected: rewrite.rewritten,
            tag: (await loadTagOrNull(context.env.DB, context.userId, destination.id))!,
          }
        }
        const updated = await context.env.DB.prepare(
          `UPDATE tags SET name = ?1, color = ?2, is_manual = 1
            WHERE id = ?3 AND user_id = ?4 AND name = ?5`,
        ).bind(destinationName, color, tag.id, context.userId, tag.name).run()
        if (!updated.meta.changes) throw ApiError.conflict('The tag changed elsewhere')
        await recordChange(context, 'tag', tag.id, 'upsert', now)
        return {
          ok: true,
          affected: rewrite.rewritten,
          tag: (await loadTagOrNull(context.env.DB, context.userId, tag.id))!,
        }
      } catch (error) {
        await rewrite.rollback()
        throw error
      }
    },
  })
}

export async function deleteMcpTag(
  context: LibraryContext,
  input: { operationId: string; tagId: string },
) {
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'delete_tag',
    request: input,
    recover: async () => {
      const existing = await loadTagOrNull(context.env.DB, context.userId, input.tagId)
      return existing ? null : { ok: true, affected: 0, tag_id: input.tagId }
    },
    execute: async () => {
      const tag = await loadTagOrNull(context.env.DB, context.userId, input.tagId)
      if (!tag) throw ApiError.notFound('Tag not found')
      const rewrite = await rewriteTagInNotes(
        context.env,
        context.ftsEnabled,
        context.userId,
        tag.id,
        tag.name,
        null,
      )
      try {
        const results = await context.env.DB.batch([
          context.env.DB.prepare(`DELETE FROM note_tags WHERE tag_id = ?1`).bind(tag.id),
          context.env.DB.prepare(`DELETE FROM tags WHERE id = ?1 AND user_id = ?2 AND name = ?3`)
            .bind(tag.id, context.userId, tag.name),
        ])
        if (!results[1]?.meta.changes) throw ApiError.conflict('The tag changed elsewhere')
        await recordChange(context, 'tag', tag.id, 'delete', Date.now())
        return { ok: true, affected: rewrite.rewritten, tag_id: tag.id }
      } catch (error) {
        await rewrite.rollback()
        throw error
      }
    },
  })
}

export async function previewMcpTagChange(
  db: D1Database,
  userId: string,
  tagId: string,
  nextName?: string | null,
) {
  const tag = await loadTagOrNull(db, userId, tagId)
  if (!tag) throw ApiError.notFound('Tag not found')
  const normalizedName = nextName == null ? null : normalizeTagName(nextName)
  const [usage, destination] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total FROM note_tags WHERE user_id = ?1 AND tag_id = ?2`,
    ).bind(userId, tagId).first<{ total: number }>(),
    normalizedName ? loadTagByName(db, userId, normalizedName, tagId) : Promise.resolve(null),
  ])
  return {
    tag,
    action: normalizedName ? 'rename' : 'delete',
    next_name: normalizedName,
    affected_notes: usage?.total ?? 0,
    merges_into: destination,
  }
}

export async function updateMcpFolder(
  context: LibraryContext,
  input: {
    operationId: string
    folderId: string
    expectedUpdatedAt: number
    name?: string
    parentId?: string | null
    icon?: string | null
    color?: string | null
  },
) {
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'update_folder',
    request: input,
    execute: async () => {
      const current = await loadFolderOrNull(context.env.DB, context.userId, input.folderId)
      if (!current) throw ApiError.notFound('Folder not found')
      if (current.updated_at !== input.expectedUpdatedAt) throw ApiError.conflict('The folder changed elsewhere')
      const parentId = input.parentId === undefined ? current.parent_id : input.parentId
      await validateFolderParent(context.env.DB, context.userId, parentId, input.folderId)
      await validateFolderMoveDepth(context.env.DB, context.userId, input.folderId, parentId)
      const name = input.name === undefined ? current.name : normalizeFolderName(input.name)
      const now = Math.max(Date.now(), current.updated_at + 1)
      const update = context.env.DB.prepare(
        `UPDATE folders SET parent_id = ?1, name = ?2, icon = ?3, color = ?4, updated_at = ?5
          WHERE id = ?6 AND user_id = ?7 AND updated_at = ?8 AND deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM folders
              WHERE user_id = ?7 AND parent_id IS ?1 AND lower(name) = lower(?2)
                AND id != ?6 AND deleted_at IS NULL)`,
      ).bind(
        parentId,
        name,
        input.icon === undefined ? current.icon : input.icon,
        input.color === undefined ? current.color : input.color,
        now,
        input.folderId,
        context.userId,
        current.updated_at,
      )
      const change = context.env.DB.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?1, 'folder', ?2, 'upsert', ?3
          WHERE EXISTS (SELECT 1 FROM folders WHERE id = ?2 AND user_id = ?1 AND updated_at = ?3)`,
      ).bind(context.userId, input.folderId, now)
      const [updated] = await context.env.DB.batch([update, change])
      if (!updated?.meta.changes) throw ApiError.conflict('The folder changed or a sibling uses this name')
      await notifyMutation(context)
      return (await loadFolderOrNull(context.env.DB, context.userId, input.folderId))!
    },
  })
}

export async function removeMcpFolderAndPromote(
  context: LibraryContext,
  input: { operationId: string; folderId: string; expectedUpdatedAt: number },
) {
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'remove_folder_and_promote_contents',
    request: input,
    recover: async () => {
      const folder = await loadFolderOrNull(context.env.DB, context.userId, input.folderId)
      return folder ? null : { ok: true, folder_id: input.folderId, promoted_to: null }
    },
    execute: async () => {
      const current = await loadFolderOrNull(context.env.DB, context.userId, input.folderId)
      if (!current) throw ApiError.notFound('Folder not found')
      if (current.updated_at !== input.expectedUpdatedAt) throw ApiError.conflict('The folder changed elsewhere')
      const conflict = await context.env.DB.prepare(
        `SELECT 1 FROM folders child JOIN folders sibling
           ON sibling.user_id = child.user_id AND sibling.parent_id IS ?1
          AND lower(sibling.name) = lower(child.name) AND sibling.id != child.id
          AND sibling.deleted_at IS NULL
          WHERE child.user_id = ?2 AND child.parent_id = ?3 AND child.deleted_at IS NULL LIMIT 1`,
      ).bind(current.parent_id, context.userId, current.id).first()
      if (conflict) throw ApiError.conflict('A promoted child would duplicate a sibling folder name')
      const now = Math.max(Date.now(), current.updated_at + 1)
      const promotionOrder = await folderPromotionOrder(context.env.DB, context.userId, current)
      const promotionJson = JSON.stringify(promotionOrder)
      const guard = `EXISTS (SELECT 1 FROM folders
        WHERE id = ?1 AND user_id = ?2 AND updated_at = ?3 AND deleted_at IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM folders child
          JOIN folders sibling
            ON sibling.user_id = child.user_id
           AND sibling.parent_id IS (
             SELECT parent_id FROM folders WHERE id = ?1 AND user_id = ?2
           )
           AND lower(sibling.name) = lower(child.name)
           AND sibling.deleted_at IS NULL
           AND sibling.id != ?1
           AND sibling.id != child.id
         WHERE child.parent_id = ?1 AND child.user_id = ?2 AND child.deleted_at IS NULL
        )`
      const results = await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO changes (user_id, entity, entity_id, op, at)
           SELECT ?2, 'folder', json_extract(item.value, '$.id'), 'upsert', ?4
             FROM json_each(?5) item WHERE ${guard}`,
        ).bind(current.id, context.userId, current.updated_at, now, promotionJson),
        context.env.DB.prepare(
          `INSERT INTO changes (user_id, entity, entity_id, op, at)
           SELECT ?2, 'note', id, 'upsert', ?4 FROM notes
            WHERE folder_id = ?1 AND user_id = ?2 AND ${guard}`,
        ).bind(current.id, context.userId, current.updated_at, now),
        context.env.DB.prepare(
          `INSERT INTO changes (user_id, entity, entity_id, op, at)
           SELECT ?2, 'folder', ?1, 'delete', ?4 WHERE ${guard}`,
        ).bind(current.id, context.userId, current.updated_at, now),
        context.env.DB.prepare(
          `UPDATE folders SET deleted_at = ?4
            WHERE id = ?1 AND user_id = ?2 AND updated_at = ?3
              AND deleted_at IS NULL AND ${guard}`,
        ).bind(current.id, context.userId, current.updated_at, now),
        context.env.DB.prepare(
          `UPDATE folders SET
             parent_id = CASE WHEN parent_id = ?1 THEN ?4 ELSE parent_id END,
             position = COALESCE((
               SELECT json_extract(item.value, '$.position') FROM json_each(?6) item
                WHERE json_extract(item.value, '$.id') = folders.id
             ), position),
             updated_at = MAX(updated_at + 1, ?5)
            WHERE id IN (SELECT json_extract(item.value, '$.id') FROM json_each(?6) item)
              AND user_id = ?2 AND deleted_at IS NULL
              AND EXISTS (SELECT 1 FROM folders
                WHERE id = ?1 AND user_id = ?2 AND updated_at = ?3 AND deleted_at = ?5)`,
        ).bind(current.id, context.userId, current.updated_at, current.parent_id, now, promotionJson),
        context.env.DB.prepare(
          `UPDATE notes SET folder_id = ?4, updated_at = MAX(updated_at + 1, ?5), rev = rev + 1
            WHERE folder_id = ?1 AND user_id = ?2
              AND EXISTS (SELECT 1 FROM folders
                WHERE id = ?1 AND user_id = ?2 AND updated_at = ?3 AND deleted_at = ?5)`,
        ).bind(current.id, context.userId, current.updated_at, current.parent_id, now),
        context.env.DB.prepare(
          `DELETE FROM folders WHERE id = ?1 AND user_id = ?2 AND updated_at = ?3 AND deleted_at = ?4`,
        ).bind(current.id, context.userId, current.updated_at, now),
      ])
      if (!results[6]?.meta.changes) throw ApiError.conflict('The folder changed elsewhere')
      await notifyMutation(context)
      return { ok: true, folder_id: current.id, promoted_to: current.parent_id }
    },
  })
}

export async function previewMcpFolderRemoval(
  db: D1Database,
  userId: string,
  folderId: string,
) {
  const folder = await loadFolderOrNull(db, userId, folderId)
  if (!folder) throw ApiError.notFound('Folder not found')
  const [childrenResult, noteCount, conflictsResult] = await Promise.all([
    db.prepare(
      `SELECT id, name, position, updated_at FROM folders
        WHERE user_id = ?1 AND parent_id = ?2 AND deleted_at IS NULL
        ORDER BY position ASC, created_at ASC, id ASC`,
    ).bind(userId, folderId).all<{ id: string; name: string; position: number; updated_at: number }>(),
    db.prepare(
      `SELECT COUNT(*) AS total FROM notes WHERE user_id = ?1 AND folder_id = ?2`,
    ).bind(userId, folderId).first<{ total: number }>(),
    db.prepare(
      `SELECT child.id, child.name FROM folders child JOIN folders sibling
         ON sibling.user_id = child.user_id AND sibling.parent_id IS ?1
        AND lower(sibling.name) = lower(child.name) AND sibling.id != child.id
        AND sibling.deleted_at IS NULL
        WHERE child.user_id = ?2 AND child.parent_id = ?3 AND child.deleted_at IS NULL`,
    ).bind(folder.parent_id, userId, folderId).all<{ id: string; name: string }>(),
  ])
  return {
    folder,
    destination_parent_id: folder.parent_id,
    notes_to_promote: noteCount?.total ?? 0,
    child_folders_to_promote: childrenResult.results,
    conflicts: conflictsResult.results,
    can_apply: conflictsResult.results.length === 0,
  }
}

export async function bulkOrganizeMcpNotes(
  context: LibraryContext,
  operationId: string,
  items: Array<{
    noteId: string
    expectedRev: number
    folderId?: string | null
    starred?: boolean
    archived?: boolean
    pinned?: boolean
  }>,
) {
  const results = []
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!
    try {
      const note = await organizeMcpNote(context, {
        operationId: `${operationId.slice(0, 88)}:${String(index).padStart(2, '0')}`,
        ...item,
      })
      results.push({ note_id: item.noteId, ok: true, rev: note.rev })
    } catch (error) {
      results.push({
        note_id: item.noteId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { results }
}

export async function exploreMcpGraph(
  db: D1Database,
  userId: string,
  origin: string,
  rootId: string,
  depth = 2,
  maxNodes = 60,
) {
  await requireOwnedNote(db, userId, rootId)
  const cappedDepth = Math.max(1, Math.min(3, depth))
  const cappedNodes = Math.max(2, Math.min(100, maxNodes))
  const nodes = new Map<string, { id: string; title: string; excerpt: string }>()
  const edges = new Map<string, { source: string; target: string }>()
  let frontier = [rootId]
  for (let level = 0; level <= cappedDepth && frontier.length && nodes.size < cappedNodes; level++) {
    const next = new Set<string>()
    for (const id of frontier) {
      const note = await db.prepare(
        `SELECT id, title, excerpt FROM notes WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
      ).bind(id, userId).first<{ id: string; title: string; excerpt: string }>()
      if (!note) continue
      nodes.set(id, note)
      if (level === cappedDepth) continue
      const { results } = await db.prepare(
        `SELECT source_note_id, target_note_id FROM links
          WHERE user_id = ?1 AND target_note_id IS NOT NULL
            AND (source_note_id = ?2 OR target_note_id = ?2) LIMIT 100`,
      ).bind(userId, id).all<{ source_note_id: string; target_note_id: string }>()
      for (const edge of results) {
        edges.set(`${edge.source_note_id}:${edge.target_note_id}`, {
          source: edge.source_note_id,
          target: edge.target_note_id,
        })
        const adjacent = edge.source_note_id === id ? edge.target_note_id : edge.source_note_id
        if (!nodes.has(adjacent) && nodes.size + next.size < cappedNodes) next.add(adjacent)
      }
    }
    frontier = [...next]
  }
  return {
    root_id: rootId,
    nodes: [...nodes.values()].map((node) => ({
      ...node,
      url: `${origin.replace(/\/$/, '')}/n/${encodeURIComponent(node.id)}`,
    })),
    edges: [...edges.values()].filter((edge) => nodes.has(edge.source) && nodes.has(edge.target)),
    truncated: frontier.length > 0 || nodes.size >= cappedNodes,
  }
}

export async function listMcpBackupRuns(db: D1Database, userId: string, limit = 10) {
  const { results } = await db.prepare(
    `SELECT id, trigger, status, started_at, finished_at, note_count, file_count, bytes, detail
       FROM backup_runs WHERE user_id = ?1 ORDER BY started_at DESC LIMIT ?2`,
  ).bind(userId, Math.max(1, Math.min(20, limit))).all<{
    id: string
    trigger: 'manual' | 'cron'
    status: BackupRun['status']
    started_at: number
    finished_at: number | null
    note_count: number
    file_count: number
    bytes: number
    detail: string
  }>()
  return {
    runs: results.map((row) => ({
      id: row.id,
      trigger: row.trigger,
      status: row.status,
      started_at: new Date(row.started_at).toISOString(),
      finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      note_count: row.note_count,
      file_count: row.file_count,
      bytes: row.bytes,
      results: parseArray(row.detail),
    })),
  }
}

export async function listMcpAttachments(
  db: D1Database,
  userId: string,
  input: { noteId?: string; limit?: number; cursor?: number },
) {
  if (input.noteId) await requireOwnedNote(db, userId, input.noteId)
  const limit = Math.max(1, Math.min(50, input.limit ?? 20))
  const cursor = Math.max(0, Math.trunc(input.cursor ?? 0))
  const { results } = await db.prepare(
    `SELECT id, note_id, filename, mime, size, width, height, created_at
       FROM attachments WHERE user_id = ?1 AND (?2 IS NULL OR note_id = ?2)
      ORDER BY created_at DESC, id DESC LIMIT ?3 OFFSET ?4`,
  ).bind(userId, input.noteId ?? null, limit + 1, cursor).all<{
    id: string
    note_id: string | null
    filename: string
    mime: string
    size: number
    width: number | null
    height: number | null
    created_at: number
  }>()
  return {
    attachments: results.slice(0, limit).map((row) => ({
      id: row.id,
      note_id: row.note_id,
      filename: row.filename,
      mime: row.mime,
      size: row.size,
      width: row.width,
      height: row.height,
      created_at: new Date(row.created_at).toISOString(),
    })),
    next_cursor: results.length > limit ? cursor + limit : null,
  }
}

export async function readMcpAttachment(
  env: Env,
  userId: string,
  input: { attachmentId: string; cursor?: number; maxBytes?: number },
) {
  const row = await env.DB.prepare(
    `SELECT id, user_id, note_id, filename, mime, size, sha256, storage, created_at
       FROM attachments WHERE id = ?1 AND user_id = ?2`,
  ).bind(input.attachmentId, userId).first<{
    id: string
    user_id: string
    note_id: string | null
    filename: string
    mime: string
    size: number
    sha256: string
    storage: AttachmentObjectStorage
    created_at: number
  }>()
  if (!row) throw ApiError.notFound('Attachment not found')
  const bytes = await readAttachmentObject(env, row.storage, attachmentObjectKey(row))
  if (!bytes) throw ApiError.notFound('Attachment data is missing')
  const start = Math.max(0, Math.min(bytes.byteLength, Math.trunc(input.cursor ?? 0)))
  const maxBytes = Math.max(1024, Math.min(1024 * 1024, Math.trunc(input.maxBytes ?? 256 * 1024)))
  const end = Math.min(bytes.byteLength, start + maxBytes)
  return {
    id: row.id,
    note_id: row.note_id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    encoding: 'base64',
    data: toBase64(bytes.slice(start, end)),
    start_offset: start,
    end_offset: end,
    has_more: end < bytes.byteLength,
    next_cursor: end < bytes.byteLength ? end : null,
  }
}

export async function uploadMcpAttachment(
  context: LibraryContext,
  input: {
    operationId: string
    attachmentId?: string
    noteId?: string | null
    filename: string
    mime: string
    base64: string
  },
) {
  const id = input.attachmentId ?? newId()
  if (!isValidId(id)) throw ApiError.badRequest('attachment_id must be a valid Inkstone id')
  if (input.noteId) await requireOwnedNote(context.env.DB, context.userId, input.noteId)
  let bytes: Uint8Array
  try {
    bytes = fromBase64(input.base64)
  } catch {
    throw ApiError.badRequest('data must be valid base64')
  }
  const digest = await sha256Hex(bytes)
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'upload_attachment',
    request: { ...input, attachmentId: id },
    recovery: { attachmentId: id },
    recover: async () => {
      const row = await loadAttachmentMeta(context.env.DB, context.userId, id)
      if (!row || row.note_id !== (input.noteId ?? null) || row.filename !== input.filename
        || row.size !== bytes.byteLength || row.sha256 !== digest) return null
      return {
        id: row.id,
        note_id: row.note_id,
        filename: row.filename,
        mime: row.mime,
        size: row.size,
        width: row.width,
        height: row.height,
        markdown: `![${row.filename}](/api/files/${row.id})`,
      }
    },
    execute: async () => {
      try {
        await consumeAttemptBudget(context.env.DB, [{
          key: `attachment-upload:${context.userId}`,
          maxAttempts: LIMITS.attachmentUploadsPerHour,
          windowMs: 60 * 60 * 1000,
          lockMs: 60 * 60 * 1000,
        }])
      } catch (error) {
        if (error instanceof ThrottleError) {
          throw new ApiError(
            429,
            'too_many_attempts',
            `Too many uploads. Try again in ${error.retryAfterSec} seconds`,
            { retryAfter: error.retryAfterSec },
          )
        }
        throw error
      }
      const collision = await context.env.DB.prepare(`SELECT 1 FROM attachments WHERE id = ?1`).bind(id).first()
      if (collision) throw ApiError.conflict('This attachment id is already in use')
      const stored = await persistAttachmentWithinQuota(context.env, {
        id,
        userId: context.userId,
        noteId: input.noteId ?? null,
        filename: input.filename,
        reportedMime: input.mime,
        bytes,
        createdAt: Date.now(),
      })
      return {
        id: stored.id,
        note_id: stored.noteId,
        filename: stored.filename,
        mime: stored.mime,
        size: stored.size,
        width: stored.width,
        height: stored.height,
        markdown: `![${stored.filename}](/api/files/${stored.id})`,
      }
    },
  })
}

export async function deleteMcpAttachment(
  context: LibraryContext,
  input: { operationId: string; attachmentId: string },
) {
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'delete_attachment',
    request: input,
    recover: async () => {
      const row = await loadAttachmentMeta(context.env.DB, context.userId, input.attachmentId)
      return row ? null : { ok: true, attachment_id: input.attachmentId, cleanup_pending: false }
    },
    execute: async () => {
      const row = await context.env.DB.prepare(
        `SELECT id, user_id, filename, mime, storage FROM attachments WHERE id = ?1 AND user_id = ?2`,
      ).bind(input.attachmentId, context.userId).first<{
        id: string
        user_id: string
        filename: string
        mime: string
        storage: AttachmentObjectStorage
      }>()
      if (!row) throw ApiError.notFound('Attachment not found')
      const results = await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at) VALUES (?1, ?2, ?3)`,
        ).bind(attachmentCleanupTarget(row.storage, attachmentObjectKey(row)), context.userId, Date.now()),
        context.env.DB.prepare(
          `DELETE FROM import_mappings WHERE user_id = ?1 AND entity = 'attachment' AND target_id = ?2`,
        ).bind(context.userId, row.id),
        context.env.DB.prepare(`DELETE FROM attachments WHERE id = ?1 AND user_id = ?2`)
          .bind(row.id, context.userId),
      ])
      if (!results[2]?.meta.changes) throw ApiError.notFound('Attachment not found')
      const cleanup = await drainAttachmentCleanup(context.env, context.userId).catch(() => ({
        processed: 0,
        pending: true,
      }))
      return { ok: true, attachment_id: row.id, cleanup_pending: cleanup.pending }
    },
  })
}

export function runMcpBackup(
  context: LibraryContext,
  operationId: string,
  targetIds?: string[],
) {
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId,
    tool: 'run_backup',
    request: { targetIds },
    execute: () => runBackup(context.env, context.userId, { trigger: 'manual', targetIds }),
  })
}

export async function getMcpShare(db: D1Database, userId: string, origin: string, noteId: string) {
  await requireOwnedNote(db, userId, noteId)
  const row = await loadShare(db, userId, noteId)
  return { share: row ? shareResult(row, origin) : null }
}

export async function createMcpShare(
  context: LibraryContext,
  input: {
    operationId: string
    noteId: string
    password?: string | null
    expiresIn?: number | null
  },
) {
  await requireOwnedNote(context.env.DB, context.userId, input.noteId)
  if (typeof input.password === 'string' && input.password.length > LIMITS.passwordMaxLength) {
    throw ApiError.badRequest(`The access password must not exceed ${LIMITS.passwordMaxLength} characters`)
  }
  if (typeof input.password === 'string' && input.password.length > 0 && input.password.length < 4) {
    throw ApiError.badRequest('The access password must be at least 4 characters')
  }
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'create_note_share',
    request: input,
    execute: async () => {
      const expiresAt = typeof input.expiresIn === 'number' && input.expiresIn > 0
        ? Date.now() + Math.min(input.expiresIn, 365 * 24 * 60 * 60 * 1000)
        : null
      const replacePassword = input.password === null || typeof input.password === 'string'
      const passwordHash = typeof input.password === 'string' && input.password
        ? await hashPassword(input.password)
        : null
      const written = await context.env.DB.prepare(
        `INSERT INTO shares (slug, note_id, user_id, password_hash, expires_at, views, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)
         ON CONFLICT(note_id) DO UPDATE SET
           password_hash = CASE WHEN ?7 = 1 THEN excluded.password_hash ELSE shares.password_hash END,
           expires_at = CASE WHEN ?8 = 1 THEN excluded.expires_at ELSE shares.expires_at END
         WHERE shares.user_id = excluded.user_id`,
      ).bind(
        newSlug(),
        input.noteId,
        context.userId,
        passwordHash,
        expiresAt,
        Date.now(),
        replacePassword ? 1 : 0,
        input.expiresIn !== undefined ? 1 : 0,
      ).run()
      if (!written.meta.changes) throw ApiError.conflict('Share state changed')
      return { share: shareResult((await loadShare(context.env.DB, context.userId, input.noteId))!, context.origin) }
    },
  })
}

export async function revokeMcpShare(
  context: LibraryContext,
  input: { operationId: string; noteId: string },
) {
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'revoke_note_share',
    request: input,
    recover: async () => {
      const row = await loadShare(context.env.DB, context.userId, input.noteId)
      return row ? null : { ok: true, note_id: input.noteId }
    },
    execute: async () => {
      await context.env.DB.prepare(`DELETE FROM shares WHERE note_id = ?1 AND user_id = ?2`)
        .bind(input.noteId, context.userId).run()
      return { ok: true, note_id: input.noteId }
    },
  })
}

function duplicateTitle(title: string): string {
  const suffix = ' copy'
  const base = title.trim() || 'Untitled note'
  return `${base.slice(0, Math.max(0, LIMITS.titleMaxLength - suffix.length))}${suffix}`
}

async function requireOwnedNote(db: D1Database, userId: string, noteId: string): Promise<void> {
  const row = await db.prepare(`SELECT 1 FROM notes WHERE id = ?1 AND user_id = ?2`)
    .bind(noteId, userId).first()
  if (!row) throw ApiError.notFound('Note not found')
}

async function loadFolderOrNull(db: D1Database, userId: string, id: string): Promise<FolderRow | null> {
  return db.prepare(
    `SELECT id, parent_id, name, icon, color, position, created_at, updated_at
       FROM folders WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
  ).bind(id, userId).first<FolderRow>()
}

async function loadTagOrNull(db: D1Database, userId: string, id: string) {
  const row = await db.prepare(
    `SELECT t.id, t.name, t.color, t.is_manual,
       (SELECT COUNT(*) FROM note_tags nt JOIN notes n ON n.id = nt.note_id
         WHERE nt.tag_id = t.id AND n.user_id = t.user_id AND n.deleted_at IS NULL) AS note_count
       FROM tags t WHERE t.id = ?1 AND t.user_id = ?2`,
  ).bind(id, userId).first<{
    id: string
    name: string
    color: string | null
    is_manual: number
    note_count: number
  }>()
  return row ? {
    id: row.id,
    name: row.name,
    color: row.color,
    manual: row.is_manual === 1,
    note_count: row.note_count,
  } : null
}

async function loadAttachmentMeta(db: D1Database, userId: string, id: string) {
  return db.prepare(
    `SELECT id, note_id, filename, mime, size, sha256, width, height, created_at
       FROM attachments WHERE id = ?1 AND user_id = ?2`,
  ).bind(id, userId).first<{
    id: string
    note_id: string | null
    filename: string
    mime: string
    size: number
    sha256: string
    width: number | null
    height: number | null
    created_at: number
  }>()
}

interface ShareRow {
  slug: string
  note_id: string
  password_hash: string | null
  expires_at: number | null
  views: number
  created_at: number
}

function loadShare(db: D1Database, userId: string, noteId: string) {
  return db.prepare(
    `SELECT slug, note_id, password_hash, expires_at, views, created_at
       FROM shares WHERE note_id = ?1 AND user_id = ?2`,
  ).bind(noteId, userId).first<ShareRow>()
}

function shareResult(row: ShareRow, origin: string) {
  return {
    slug: row.slug,
    note_id: row.note_id,
    url: `${origin.replace(/\/$/, '')}/s/${row.slug}`,
    has_password: Boolean(row.password_hash),
    expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    views: row.views,
    created_at: new Date(row.created_at).toISOString(),
  }
}

async function loadTagByName(db: D1Database, userId: string, name: string, exceptId?: string) {
  const row = await db.prepare(
    `SELECT id FROM tags WHERE user_id = ?1 AND name = ?2 COLLATE NOCASE
      AND (?3 IS NULL OR id != ?3) ORDER BY created_at ASC, id ASC LIMIT 1`,
  ).bind(userId, name, exceptId ?? null).first<{ id: string }>()
  return row ? loadTagOrNull(db, userId, row.id) : null
}

async function validateFolderParent(
  db: D1Database,
  userId: string,
  parentId: string | null,
  selfId?: string,
): Promise<void> {
  if (!parentId) return
  if (!isValidId(parentId)) throw ApiError.badRequest('Invalid parent folder id')
  const { results } = await db.prepare(
    `WITH RECURSIVE ancestors(id, parent_id, depth) AS (
       SELECT id, parent_id, 1 FROM folders
        WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL
       UNION ALL
       SELECT f.id, f.parent_id, ancestors.depth + 1 FROM folders f JOIN ancestors ON f.id = ancestors.parent_id
        WHERE f.user_id = ?2 AND f.deleted_at IS NULL AND ancestors.depth < ?3
     ) SELECT id, depth FROM ancestors`,
  ).bind(parentId, userId, LIMITS.folderDepthMax + 1).all<{ id: string; depth: number }>()
  if (!results.length) throw ApiError.badRequest('The parent folder does not exist')
  if (selfId && results.some((row) => row.id === selfId)) {
    throw ApiError.badRequest('A folder cannot be moved into its own descendant')
  }
  if (Math.max(...results.map((row) => row.depth)) >= LIMITS.folderDepthMax) {
    throw ApiError.badRequest(`Folder nesting cannot exceed ${LIMITS.folderDepthMax} levels`)
  }
}

async function validateFolderMoveDepth(
  db: D1Database,
  userId: string,
  folderId: string,
  parentId: string | null,
): Promise<void> {
  const row = await db.prepare(
    `WITH RECURSIVE
       descendants(id, depth) AS (
         SELECT id, 1 FROM folders WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL
         UNION ALL
         SELECT f.id, descendants.depth + 1 FROM folders f JOIN descendants ON f.parent_id = descendants.id
          WHERE f.user_id = ?2 AND f.deleted_at IS NULL AND descendants.depth < ?4
       ),
       ancestors(id, parent_id, depth) AS (
         SELECT id, parent_id, 1 FROM folders WHERE id = ?3 AND user_id = ?2 AND deleted_at IS NULL
         UNION ALL
         SELECT f.id, f.parent_id, ancestors.depth + 1 FROM folders f JOIN ancestors ON f.id = ancestors.parent_id
          WHERE f.user_id = ?2 AND f.deleted_at IS NULL AND ancestors.depth < ?4
       )
     SELECT COALESCE((SELECT MAX(depth) FROM descendants), 1) AS subtree_depth,
            COALESCE((SELECT MAX(depth) FROM ancestors), 0) AS parent_depth`,
  ).bind(folderId, userId, parentId, LIMITS.folderDepthMax + 1).first<{
    subtree_depth: number
    parent_depth: number
  }>()
  if (!row || row.subtree_depth + row.parent_depth > LIMITS.folderDepthMax) {
    throw ApiError.badRequest(`Folder nesting cannot exceed ${LIMITS.folderDepthMax} levels`)
  }
}

function normalizeFolderName(value: string): string {
  const name = value.trim()
  if (!name) throw ApiError.badRequest('Folder name is required')
  if (name.length > LIMITS.folderNameMaxLength) throw ApiError.badRequest('Folder name is too long')
  return name
}

function normalizeTagName(value: string): string {
  const name = value.trim().replace(/^#+/, '')
  if (!name) throw ApiError.badRequest('Tag name is required')
  if (name.length > LIMITS.tagNameMaxLength) throw ApiError.badRequest('Tag name is too long')
  if (/[\s#]/.test(name)) throw ApiError.badRequest('Tag names cannot contain spaces or #')
  return name
}

async function recordChange(
  context: LibraryContext,
  entity: string,
  id: string,
  op: 'upsert' | 'delete',
  at: number,
): Promise<void> {
  await context.env.DB.prepare(
    `INSERT INTO changes (user_id, entity, entity_id, op, at) VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(context.userId, entity, id, op, at).run()
  await notifyMutation(context)
}

async function notifyMutation(context: LibraryContext): Promise<void> {
  await broadcastUserCursor(
    context.env,
    context.userId,
    null,
    undefined,
    (task) => context.executionCtx.waitUntil(task),
  )
}

function parseArray(raw: string): unknown[] {
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function assertPropertyValue(value: unknown, depth: number): void {
  if (depth > 4) throw ApiError.badRequest('Property values cannot exceed four nested levels')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    if (value.length > 100) throw ApiError.badRequest('Property arrays cannot exceed 100 items')
    for (const item of value) assertPropertyValue(item, depth + 1)
    return
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length > 100) throw ApiError.badRequest('Property objects cannot exceed 100 fields')
    for (const [key, item] of entries) {
      if (!key || key.length > 120) throw ApiError.badRequest('Nested property names are invalid')
      assertPropertyValue(item, depth + 1)
    }
    return
  }
  throw ApiError.badRequest('Property values must be JSON-compatible')
}

function propertyMatches(
  properties: Record<string, unknown>,
  condition: { key: string; operator: 'exists' | 'equals' | 'contains'; value?: unknown },
): boolean {
  const exists = Object.prototype.hasOwnProperty.call(properties, condition.key)
  if (condition.operator === 'exists') return exists
  if (!exists) return false
  const actual = properties[condition.key]
  if (condition.operator === 'equals') return JSON.stringify(actual) === JSON.stringify(condition.value)
  if (Array.isArray(actual)) {
    return actual.some((item) => JSON.stringify(item) === JSON.stringify(condition.value))
  }
  return String(actual).toLocaleLowerCase().includes(String(condition.value ?? '').toLocaleLowerCase())
}
