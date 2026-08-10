import { LIMITS } from '@shared/constants'
import { segmentCJK } from '@shared/markdown-utils'
import { truncateText } from '@shared/text-utils'
import { selectQueueUsersRoundRobin } from './metadata'

interface IndexableNote {
  id: string
  title: string
  content: string
  rev: number
  content_hash: string
  updated_at: number
}

const FTS_DRAIN_CURSOR_META_KEY = 'fts-index-drain-user-v1'


export async function rebuildFtsIndex(db: D1Database, userId: string): Promise<number> {
  const boundary = await db
    .prepare(`SELECT MAX(id) AS id FROM notes WHERE user_id = ?1 AND deleted_at IS NULL`)
    .bind(userId)
    .first<{ id: string | null }>()
  const lastId = boundary?.id
  if (!lastId) {
    await db.prepare(`DELETE FROM notes_fts WHERE user_id = ?1`).bind(userId).run()
    return 0
  }

  let cursor = ''
  let indexed = 0
  while (cursor < lastId) {
    const { results } = await db
      .prepare(
        `SELECT id, title, content, rev, content_hash, updated_at FROM notes
          WHERE user_id = ?1 AND deleted_at IS NULL AND id > ?2 AND id <= ?3
          ORDER BY id ASC LIMIT 25`,
      )
      .bind(userId, cursor, lastId)
      .all<IndexableNote>()
    if (!results.length) break

    const statements: D1PreparedStatement[] = []
    for (const row of results) {
      const guard = `EXISTS (SELECT 1 FROM notes WHERE id = ?1 AND user_id = ?2
        AND deleted_at IS NULL AND rev = ?3 AND content_hash = ?4
        AND title = ?5 AND updated_at = ?6)`
      statements.push(
        db
          .prepare(
            `DELETE FROM notes_fts WHERE note_id = ?1 AND user_id = ?2
              AND ${shiftPlaceholders(guard, 2)}`,
          )
          .bind(row.id, userId, row.id, userId, row.rev, row.content_hash, row.title, row.updated_at),
        db
          .prepare(
            `INSERT INTO notes_fts (note_id, user_id, title, body)
             SELECT ?1, ?2, ?3, ?4 WHERE ${shiftPlaceholders(guard, 4)}`,
          )
          .bind(
            row.id,
            userId,
            segmentCJK(row.title),
            segmentCJK(truncateText(row.content, LIMITS.ftsContentChars)),
            row.id,
            userId,
            row.rev,
            row.content_hash,
            row.title,
            row.updated_at,
          ),
      )
    }
    const batch = await db.batch(statements)
    for (let index = 1; index < batch.length; index += 2) {
      indexed += batch[index]?.meta.changes ?? 0
    }
    cursor = results[results.length - 1]!.id
  }

  await db
    .prepare(
      `DELETE FROM notes_fts WHERE user_id = ?1 AND NOT EXISTS (
         SELECT 1 FROM notes n WHERE n.id = notes_fts.note_id
           AND n.user_id = ?1 AND n.deleted_at IS NULL
       )`,
    )
    .bind(userId)
    .run()
  return indexed
}


export const FTS_DRAIN_DELAY_MS = 10_000
const FTS_DRAIN_BATCH = 5
const FTS_DRAIN_ALL_BATCH = 250
const FTS_STATEMENT_BATCH = 75

interface FtsQueueRow {
  note_id: string
  kind: 'upsert' | 'delete'
  created_at: number
}

function buildFtsQueueItemStatements(
  db: D1Database,
  userId: string,
  item: FtsQueueRow,
  note: IndexableNote | undefined,
): D1PreparedStatement[] {
  const noteId = item.note_id
  const { kind, created_at: queueVersion } = item
  if (kind === 'delete' || !note) {
    const queueGuard = `EXISTS (SELECT 1 FROM fts_index_queue
      WHERE user_id = ?3 AND note_id = ?4 AND kind = ?5 AND created_at = ?6)`
    return [
      db.prepare(
        `DELETE FROM notes_fts WHERE note_id = ?1 AND user_id = ?2 AND ${queueGuard}`,
      ).bind(noteId, userId, userId, noteId, kind, queueVersion),
      db.prepare(
        `DELETE FROM fts_index_queue
          WHERE user_id = ?1 AND note_id = ?2 AND kind = ?3 AND created_at = ?4`,
      ).bind(userId, noteId, kind, queueVersion),
    ]
  }
  const guard = `EXISTS (SELECT 1 FROM notes
    WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL
      AND rev = ?3 AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
  const guardValues = [noteId, userId, note.rev, note.content_hash, note.title, note.updated_at] as const
  const queueGuard = `EXISTS (SELECT 1 FROM fts_index_queue
    WHERE user_id = ?7 AND note_id = ?8 AND kind = ?9 AND created_at = ?10)`
  const processGuard = `${guard} AND ${queueGuard}`
  const processGuardValues = [...guardValues, userId, noteId, kind, queueVersion] as const
  return [
    db
      .prepare(`DELETE FROM notes_fts WHERE note_id = ?1 AND user_id = ?2 AND ${shiftPlaceholders(processGuard, 2)}`)
      .bind(noteId, userId, ...processGuardValues),
    db
      .prepare(
        `INSERT INTO notes_fts (note_id, user_id, title, body)
         SELECT ?1, ?2, ?3, ?4 WHERE ${shiftPlaceholders(processGuard, 4)}`,
      )
      .bind(
        noteId,
        userId,
        segmentCJK(note.title),
        segmentCJK(truncateText(note.content, LIMITS.ftsContentChars)),
        ...processGuardValues,
      ),
    db.prepare(
      `DELETE FROM fts_index_queue
        WHERE user_id = ?1 AND note_id = ?2 AND kind = ?3 AND created_at = ?4
          AND ${shiftPlaceholders(guard, 4)}`,
    ).bind(userId, noteId, kind, queueVersion, ...guardValues),
  ]
}

export async function drainFtsQueue(
  db: D1Database,
  userId: string,
  max = FTS_DRAIN_BATCH,
  ignoreDelay = false,
): Promise<number> {
  const cutoff = ignoreDelay ? Date.now() : Date.now() - FTS_DRAIN_DELAY_MS
  const { results } = await db
    .prepare(
      `SELECT note_id, kind, created_at FROM fts_index_queue
        WHERE user_id = ?1 AND created_at <= ?2
        ORDER BY created_at ASC LIMIT ?3`,
    )
    .bind(userId, cutoff, max)
    .all<FtsQueueRow>()
  if (!results.length) return 0

  const upsertIds = results
    .filter((item) => item.kind === 'upsert')
    .map((item) => item.note_id)
  const notes = new Map<string, IndexableNote>()
  if (upsertIds.length) {
    const { results: noteRows } = await db
      .prepare(
        `SELECT id, title, content, rev, content_hash, updated_at FROM notes
          WHERE user_id = ?1 AND deleted_at IS NULL
            AND id IN (SELECT value FROM json_each(?2))`,
      )
      .bind(userId, JSON.stringify(upsertIds))
      .all<IndexableNote>()
    for (const note of noteRows) notes.set(note.id, note)
  }

  let statements: D1PreparedStatement[] = []
  for (const item of results) {
    const itemStatements = buildFtsQueueItemStatements(db, userId, item, notes.get(item.note_id))
    if (statements.length && statements.length + itemStatements.length > FTS_STATEMENT_BATCH) {
      await db.batch(statements)
      statements = []
    }
    statements.push(...itemStatements)
  }
  if (statements.length) await db.batch(statements)
  return results.length
}

export async function hasPendingFtsWork(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS pending FROM fts_index_queue WHERE user_id = ?1 LIMIT 1`)
    .bind(userId)
    .first<{ pending: number }>()
  return row?.pending === 1
}

export async function drainAllFtsQueues(db: D1Database, maxUsers = 20): Promise<number> {
  const users = await selectQueueUsersRoundRobin(
    db,
    'fts_index_queue',
    FTS_DRAIN_CURSOR_META_KEY,
    maxUsers,
  )
  let processed = 0
  for (const user_id of users) {
    processed += await drainFtsQueue(db, user_id, FTS_DRAIN_ALL_BATCH)
  }
  return processed
}

function shiftPlaceholders(sql: string, offset: number): string {
  return sql.replace(/\?(\d+)/g, (_match, value: string) => `?${Number(value) + offset}`)
}
