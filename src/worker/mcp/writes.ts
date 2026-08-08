import { LIMITS } from '@shared/constants'
import { countText, deriveExcerpt, deriveTitle } from '@shared/markdown-utils'
import { truncateText, utf8ByteLength } from '@shared/text-utils'
import type { Note } from '@shared/types'
import { NOTE_COLUMNS_FULL, toNote, type NoteRow } from '../db/rows'
import { buildNoteDerivedStatements, LINK_TARGET_SUBQUERY } from '../db/writes'
import type { Env } from '../env'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { broadcastUserCursor } from '../lib/notify'
import { assertContentSize } from '../lib/request'
import { enqueueNoteIndex } from './ai-search'
import { runIdempotent } from './operations'
import { buildOutline } from './retrieval'

export type NoteEditOperation = 'replace' | 'replace_section' | 'append' | 'prepend' | 'replace_all'

export interface McpWriteContext {
  env: Env
  userId: string
  ftsEnabled: boolean
  executionCtx: ExecutionContext
}

export async function createMcpNote(
  context: McpWriteContext,
  input: {
    operationId: string
    noteId?: string
    title?: string
    content?: string
    folderId?: string | null
  },
): Promise<Note> {
  const id = input.noteId ?? newId()
  if (!isValidId(id)) throw ApiError.badRequest('note_id must be a valid Inkstone note id')
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'create_note',
    request: input,
    recovery: { noteId: id },
    recover: async (recovery) => {
      const noteId = typeof recovery?.noteId === 'string' ? recovery.noteId : ''
      return noteId ? loadNoteOrNull(context.env.DB, context.userId, noteId) : null
    },
    execute: async () => {
      const content = input.content ?? ''
      assertContentSize(content)
      const title = resolveTitle(input.title ?? deriveTitle(content))
      const folderId = await resolveFolderId(context.env.DB, context.userId, input.folderId ?? null)
      const now = Date.now()
      const excerpt = deriveExcerpt(content)
      const { words, chars } = countText(content)
      const hash = await sha256Hex(content)
      const collision = await context.env.DB.prepare(`SELECT user_id FROM notes WHERE id = ?1`)
        .bind(id)
        .first<{ user_id: string }>()
      if (collision) throw ApiError.conflict('This note id is already in use')

      const insert = context.env.DB.prepare(
        `INSERT INTO notes (id, user_id, folder_id, title, content, excerpt, rev, word_count, char_count,
           is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, 0, 0, 0, ?9, ?10, ?11, ?11)`,
      ).bind(id, context.userId, folderId, title, content, excerpt, words, chars, now, hash, now)
      const derived = buildNoteDerivedStatements({
        db: context.env.DB,
        userId: context.userId,
        noteId: id,
        title,
        content,
        ftsEnabled: context.ftsEnabled,
        expectedRev: 1,
        expectedContentHash: hash,
        expectedTitle: title,
        expectedUpdatedAt: now,
      }).statements
      const change = context.env.DB.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?1, 'note', ?2, 'upsert', ?3
          WHERE EXISTS (SELECT 1 FROM notes
            WHERE id = ?2 AND user_id = ?1 AND rev = 1 AND content_hash = ?4)`,
      ).bind(context.userId, id, now, hash)
      await context.env.DB.batch([insert, ...derived, change])
      const note = await loadNote(context.env.DB, context.userId, id)
      await enqueueNoteIndex(context.env.DB, context.userId, id, 'embed')
      await afterMutation(context)
      return note
    },
  })
}

export async function editMcpNote(
  context: McpWriteContext,
  input: {
    operationId: string
    noteId: string
    expectedRev: number
    operation: NoteEditOperation
    text: string
    oldText?: string
    section?: string
    title?: string
  },
): Promise<Note> {
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'edit_note',
    request: input,
    recovery: { noteId: input.noteId, expectedRev: input.expectedRev },
    execute: async () => {
      const current = await loadNoteRow(context.env.DB, context.userId, input.noteId)
      assertExpectedRevision(current, input.expectedRev)
      if (current.deleted_at !== null) throw ApiError.notFound('The note is in the trash')
      const content = applyEdit(current.content, input)
      return patchNote(context, current, {
        content,
        ...(input.title !== undefined ? { title: input.title } : {}),
      })
    },
  })
}

export async function organizeMcpNote(
  context: McpWriteContext,
  input: {
    operationId: string
    noteId: string
    expectedRev: number
    folderId?: string | null
    starred?: boolean
    archived?: boolean
    pinned?: boolean
  },
): Promise<Note> {
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'organize_note',
    request: input,
    recovery: { noteId: input.noteId, expectedRev: input.expectedRev },
    execute: async () => {
      const current = await loadNoteRow(context.env.DB, context.userId, input.noteId)
      assertExpectedRevision(current, input.expectedRev)
      if (current.deleted_at !== null) throw ApiError.notFound('The note is in the trash')
      return patchNote(context, current, {
        ...(Object.prototype.hasOwnProperty.call(input, 'folderId') ? { folderId: input.folderId } : {}),
        ...(input.starred !== undefined ? { isStarred: input.starred } : {}),
        ...(input.archived !== undefined ? { isArchived: input.archived } : {}),
        ...(input.pinned !== undefined ? { isPinned: input.pinned } : {}),
      })
    },
  })
}

export async function trashMcpNote(
  context: McpWriteContext,
  input: { operationId: string; noteId: string; expectedRev: number },
): Promise<Note> {
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'trash_note',
    request: input,
    recovery: { noteId: input.noteId, expectedRev: input.expectedRev },
    execute: async () => {
      const row = await loadNoteRow(context.env.DB, context.userId, input.noteId)
      assertExpectedRevision(row, input.expectedRev)
      if (row.deleted_at !== null) throw ApiError.notFound('The note is already in the trash')
      const now = Math.max(Date.now(), row.updated_at + 1)
      const nextRev = row.rev + 1
      const guard = `EXISTS (SELECT 1 FROM notes
        WHERE id = ?1 AND user_id = ?2 AND rev = ?3 AND deleted_at IS NOT NULL)`
      const statements: D1PreparedStatement[] = [
        context.env.DB.prepare(
          `UPDATE notes SET deleted_at = ?1, updated_at = ?1, rev = ?2
            WHERE id = ?3 AND user_id = ?4 AND rev = ?5 AND deleted_at IS NULL`,
        ).bind(now, nextRev, row.id, context.userId, row.rev),
        context.env.DB.prepare(
          `DELETE FROM links WHERE source_note_id = ?1 AND ${shiftSqlPlaceholders(guard, 1)}`,
        ).bind(row.id, row.id, context.userId, nextRev),
        context.env.DB.prepare(
          `UPDATE links SET target_note_id = ${LINK_TARGET_SUBQUERY}
            WHERE target_note_id = ?1 AND user_id = ?2 AND ${shiftSqlPlaceholders(guard, 2)}`,
        ).bind(row.id, context.userId, row.id, context.userId, nextRev),
      ]
      if (context.ftsEnabled) {
        statements.push(
          context.env.DB.prepare(
            `DELETE FROM notes_fts WHERE note_id = ?1 AND ${shiftSqlPlaceholders(guard, 1)}`,
          ).bind(row.id, row.id, context.userId, nextRev),
        )
      }
      statements.push(
        context.env.DB.prepare(
          `INSERT INTO changes (user_id, entity, entity_id, op, at)
           SELECT ?1, 'note', ?2, 'upsert', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}`,
        ).bind(context.userId, row.id, now, row.id, context.userId, nextRev),
      )
      const [updated] = await context.env.DB.batch(statements)
      if (!updated?.meta.changes) {
        throw ApiError.conflict('This note was modified elsewhere', {
          server: await loadNote(context.env.DB, context.userId, row.id),
        })
      }
      const note = await loadNote(context.env.DB, context.userId, row.id)
      await afterMutation(context)
      return note
    },
  })
}

export async function restoreMcpNote(
  context: McpWriteContext,
  input: { operationId: string; noteId: string; expectedRev: number },
): Promise<Note> {
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'restore_note',
    request: input,
    recovery: { noteId: input.noteId, expectedRev: input.expectedRev },
    execute: async () => {
      const row = await loadNoteRow(context.env.DB, context.userId, input.noteId)
      assertExpectedRevision(row, input.expectedRev)
      if (row.deleted_at === null) throw ApiError.badRequest('The note is not in the trash')
      const now = Math.max(Date.now(), row.updated_at + 1)
      const nextRev = row.rev + 1
      const update = context.env.DB.prepare(
        `UPDATE notes SET deleted_at = NULL, updated_at = ?1, rev = ?2
          WHERE id = ?3 AND user_id = ?4 AND rev = ?5 AND deleted_at IS NOT NULL`,
      ).bind(now, nextRev, row.id, context.userId, row.rev)
      const derived = buildNoteDerivedStatements({
        db: context.env.DB,
        userId: context.userId,
        noteId: row.id,
        title: row.title,
        content: row.content,
        ftsEnabled: context.ftsEnabled,
        expectedRev: nextRev,
        expectedContentHash: row.content_hash,
        expectedTitle: row.title,
        expectedUpdatedAt: now,
      }).statements
      const change = context.env.DB.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?1, 'note', ?2, 'upsert', ?3
          WHERE EXISTS (SELECT 1 FROM notes
            WHERE id = ?2 AND user_id = ?1 AND rev = ?4 AND deleted_at IS NULL)`,
      ).bind(context.userId, row.id, now, nextRev)
      const [updated] = await context.env.DB.batch([update, ...derived, change])
      if (!updated?.meta.changes) {
        throw ApiError.conflict('This note was modified elsewhere', {
          server: await loadNote(context.env.DB, context.userId, row.id),
        })
      }
      const note = await loadNote(context.env.DB, context.userId, row.id)
      await enqueueNoteIndex(context.env.DB, context.userId, row.id, 'embed')
      await afterMutation(context)
      return note
    },
  })
}

async function patchNote(
  context: McpWriteContext,
  row: NoteRow,
  patch: {
    title?: string
    content?: string
    folderId?: string | null
    isPinned?: boolean
    isStarred?: boolean
    isArchived?: boolean
  },
): Promise<Note> {
  const now = Math.max(Date.now(), row.updated_at + 1)
  const sets: string[] = []
  const binds: unknown[] = []
  let contentChanged = false
  let newTitle = row.title
  let newContent = row.content
  let newHash = row.content_hash

  if (patch.content !== undefined && patch.content !== row.content) {
    assertContentSize(patch.content)
    const hash = await sha256Hex(patch.content)
    if (hash !== row.content_hash) {
      contentChanged = true
      newHash = hash
      newContent = patch.content
      newTitle = patch.title === undefined ? row.title : resolveTitle(patch.title)
      const { words, chars } = countText(patch.content)
      push(sets, binds, 'content', patch.content)
      push(sets, binds, 'content_hash', hash)
      push(sets, binds, 'title', newTitle)
      push(sets, binds, 'excerpt', deriveExcerpt(patch.content))
      push(sets, binds, 'word_count', words)
      push(sets, binds, 'char_count', chars)
    }
  } else if (patch.title !== undefined && resolveTitle(patch.title) !== row.title) {
    newTitle = resolveTitle(patch.title)
    push(sets, binds, 'title', newTitle)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'folderId')) {
    push(sets, binds, 'folder_id', await resolveFolderId(context.env.DB, context.userId, patch.folderId))
  }
  if (patch.isPinned !== undefined) push(sets, binds, 'is_pinned', patch.isPinned ? 1 : 0)
  if (patch.isStarred !== undefined) push(sets, binds, 'is_starred', patch.isStarred ? 1 : 0)
  if (patch.isArchived !== undefined) push(sets, binds, 'is_archived', patch.isArchived ? 1 : 0)
  if (!sets.length) return toNote(row)

  push(sets, binds, 'updated_at', now)
  const nextRev = row.rev + 1
  push(sets, binds, 'rev', nextRev)
  binds.push(row.id, context.userId, row.rev)
  const update = context.env.DB.prepare(
    `UPDATE notes SET ${sets.join(', ')}
      WHERE id = ?${binds.length - 2} AND user_id = ?${binds.length - 1} AND rev = ?${binds.length}`,
  ).bind(...binds)
  const mutationGuard = `EXISTS (SELECT 1 FROM notes
    WHERE id = ?1 AND user_id = ?2 AND rev = ?3
      AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
  const mutationValues = [row.id, context.userId, nextRev, newHash, newTitle, now] as const
  const statements: D1PreparedStatement[] = [update]

  if (contentChanged && row.content) {
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
          WHERE ${shiftSqlPlaceholders(mutationGuard, 7)}`,
      ).bind(
        newId(), row.id, context.userId, row.title, row.content,
        utf8ByteLength(row.content), now, ...mutationValues,
      ),
      context.env.DB.prepare(
        `DELETE FROM note_versions WHERE note_id = ?1
           AND ${shiftSqlPlaceholders(mutationGuard, 1)}
           AND id NOT IN (
             SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC LIMIT ?8
           )`,
      ).bind(row.id, ...mutationValues, LIMITS.versionsPerNote),
    )
  }

  if (contentChanged || newTitle !== row.title) {
    statements.push(...buildNoteDerivedStatements({
      db: context.env.DB,
      userId: context.userId,
      noteId: row.id,
      title: newTitle,
      content: newContent,
      ftsEnabled: context.ftsEnabled,
      titleChanged: newTitle !== row.title,
      previousTitle: row.title,
      expectedRev: nextRev,
      expectedContentHash: newHash,
      expectedTitle: newTitle,
      expectedUpdatedAt: now,
    }).statements)
    if (contentChanged) {
      statements.push(
        context.env.DB.prepare(
          `DELETE FROM tags WHERE user_id = ?1 AND is_manual = 0
             AND ${shiftSqlPlaceholders(mutationGuard, 1)}
             AND id NOT IN (SELECT tag_id FROM note_tags)`,
        ).bind(context.userId, ...mutationValues),
      )
    }
  }
  statements.push(
    context.env.DB.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'note', ?2, 'upsert', ?3
        WHERE ${shiftSqlPlaceholders(mutationGuard, 3)}`,
    ).bind(context.userId, row.id, now, ...mutationValues),
  )
  const [updated] = await context.env.DB.batch(statements)
  if (!updated?.meta.changes) {
    throw ApiError.conflict('This note was modified elsewhere', {
      server: await loadNote(context.env.DB, context.userId, row.id),
    })
  }
  const note = await loadNote(context.env.DB, context.userId, row.id)
  if (contentChanged || newTitle !== row.title) {
    await enqueueNoteIndex(context.env.DB, context.userId, row.id, 'embed')
  }
  await afterMutation(context)
  return note
}

function applyEdit(
  content: string,
  input: { operation: NoteEditOperation; text: string; oldText?: string; section?: string },
): string {
  if (input.operation === 'replace_all') return input.text
  if (input.operation === 'append') {
    if (!content) return input.text
    return `${content.replace(/\s*$/, '')}\n\n${input.text}`
  }
  if (input.operation === 'prepend') {
    if (!content) return input.text
    return `${input.text}\n\n${content.replace(/^\s*/, '')}`
  }
  if (input.operation === 'replace') {
    const oldText = input.oldText ?? ''
    if (!oldText) throw ApiError.badRequest('old_text is required for replace')
    const first = content.indexOf(oldText)
    if (first < 0) throw ApiError.conflict('old_text was not found; read the current note and retry')
    if (content.indexOf(oldText, first + oldText.length) >= 0) {
      throw ApiError.conflict('old_text occurs more than once; provide a larger unique passage')
    }
    return `${content.slice(0, first)}${input.text}${content.slice(first + oldText.length)}`
  }

  const section = input.section?.trim().toLowerCase()
  if (!section) throw ApiError.badRequest('section is required for replace_section')
  const outline = buildOutline(content)
  const index = outline.findIndex((item) => item.slug === section || item.title.toLowerCase() === section)
  if (index < 0) throw ApiError.notFound(`Section not found: ${input.section}`)
  const heading = outline[index]!
  const offsets = lineOffsets(content)
  const headingEnd = offsets[heading.line] ?? content.length
  const next = outline.slice(index + 1).find((item) => item.level <= heading.level)
  const sectionEnd = next ? (offsets[next.line - 1] ?? content.length) : content.length
  const replacement = input.text.trim()
  const middle = replacement ? `${replacement}\n\n` : ''
  return `${content.slice(0, headingEnd)}${middle}${content.slice(sectionEnd)}`
}

async function afterMutation(context: McpWriteContext): Promise<void> {
  await broadcastUserCursor(
    context.env,
    context.userId,
    null,
    undefined,
    (task) => context.executionCtx.waitUntil(task),
  )
}

async function loadNote(db: D1Database, userId: string, id: string): Promise<Note> {
  return toNote(await loadNoteRow(db, userId, id))
}

async function loadNoteOrNull(db: D1Database, userId: string, id: string): Promise<Note | null> {
  const row = await db.prepare(
    `SELECT ${NOTE_COLUMNS_FULL} FROM notes n WHERE n.id = ?1 AND n.user_id = ?2`,
  ).bind(id, userId).first<NoteRow>()
  return row ? toNote(row) : null
}

async function loadNoteRow(db: D1Database, userId: string, id: string): Promise<NoteRow> {
  const row = await db.prepare(
    `SELECT ${NOTE_COLUMNS_FULL} FROM notes n WHERE n.id = ?1 AND n.user_id = ?2`,
  ).bind(id, userId).first<NoteRow>()
  if (!row) throw ApiError.notFound('Note not found')
  return row
}

function assertExpectedRevision(row: NoteRow, expectedRev: number): void {
  if (!Number.isInteger(expectedRev) || expectedRev < 1) {
    throw ApiError.badRequest('expected_rev must be a positive integer')
  }
  if (row.rev !== expectedRev) {
    throw ApiError.conflict('This note was modified elsewhere', { server: toNote(row) })
  }
}

async function resolveFolderId(
  db: D1Database,
  userId: string,
  folderId: string | null | undefined,
): Promise<string | null> {
  if (!folderId) return null
  const row = await db.prepare(
    `SELECT id FROM folders WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
  ).bind(folderId, userId).first<{ id: string }>()
  if (!row) throw ApiError.badRequest('Folder not found')
  return row.id
}

function resolveTitle(value: string): string {
  return truncateText(value.trim(), LIMITS.titleMaxLength)
}

function push(sets: string[], binds: unknown[], column: string, value: unknown): void {
  binds.push(value)
  sets.push(`${column} = ?${binds.length}`)
}

function shiftSqlPlaceholders(sql: string, offset: number): string {
  return sql.replace(/\?(\d+)/g, (_match, value: string) => `?${Number(value) + offset}`)
}

function lineOffsets(content: string): number[] {
  const offsets = [0]
  for (let index = 0; index < content.length; index++) {
    if (content[index] === '\n') offsets.push(index + 1)
  }
  return offsets
}
