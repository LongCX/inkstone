import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { LIMITS } from '@shared/constants'
import { extractAttachmentIds } from '@shared/markdown-utils'
import type { Attachment } from '@shared/types'
import {
  hasAttachmentStorage,
  readAttachmentObject,
} from '../attachments/backend'
import { drainAttachmentCleanup } from '../attachments/cleanup'
import {
  attachmentCleanupTarget,
  attachmentObjectKey,
  type AttachmentObjectStorage,
} from '../attachments/keys'
import { persistAttachment } from '../attachments/storage'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId, isValidSlug, newId } from '../lib/id'
import { isInlineSafe } from '../lib/image'
import { acquireLease } from '../lib/lease'
import { FORM_BODY_LIMITS, readFormDataWithinLimit } from '../lib/request'
import { consumeAttemptBudget, ThrottleError } from '../lib/throttle'
import { shareAssetCookieName, verifyShareAssetSession } from '../lib/share-asset-session'
import { requireAuth } from '../middleware/auth'

export const filesRoutes = new Hono<AppBindings>()

interface AttachmentRow {
  id: string
  user_id: string
  note_id: string | null
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  storage: AttachmentObjectStorage
  created_at: number
}

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    noteId: row.note_id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    url: `/api/files/${row.id}`,
    createdAt: row.created_at,
  }
}


filesRoutes.post('/', requireAuth, async (c) => {
  const userId = c.get('userId')
  try {
    await consumeAttemptBudget(c.env.DB, [{
      key: `attachment-upload:${userId}`,
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

  const form = await readFormDataWithinLimit(c.req, FORM_BODY_LIMITS.attachment)

  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('Missing file field')

  if (file.size > LIMITS.attachmentMaxBytes) {
    throw ApiError.tooLarge('The file exceeds the 10 MB limit')
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const id = newId()
  const rawNoteId = form.get('noteId')
  const noteId = typeof rawNoteId === 'string' && rawNoteId ? rawNoteId.slice(0, 128) : null
  if (noteId) {
    const owned = await c.env.DB.prepare(
      `SELECT id FROM notes WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
    )
      .bind(noteId, userId)
      .first<{ id: string }>()
    if (!owned) throw ApiError.badRequest('The associated note does not exist')
  }
  const release = await acquireLease(
    c.env.DB,
    `attachment-quota:${userId}`,
    2 * 60 * 1000,
    'Another attachment upload is being finalized. Try again shortly',
  )
  let stored: Awaited<ReturnType<typeof persistAttachment>>
  const now = Date.now()
  try {
    const usage = await c.env.DB.prepare(
      `SELECT COALESCE(SUM(size), 0) AS bytes FROM attachments WHERE user_id = ?1`,
    ).bind(userId).first<{ bytes: number }>()
    if ((usage?.bytes ?? 0) + bytes.byteLength > LIMITS.attachmentQuotaBytes) {
      throw ApiError.tooLarge('The account attachment quota has been reached')
    }
    stored = await persistAttachment(c.env, {
      id,
      userId,
      noteId,
      filename: file.name || 'file',
      reportedMime: file.type,
      bytes,
      createdAt: now,
    })
  } finally {
    await release()
  }

  const attachment: Attachment = {
    id,
    noteId,
    filename: stored.filename,
    mime: stored.mime,
    size: bytes.byteLength,
    width: stored.width,
    height: stored.height,
    url: `/api/files/${id}`,
    createdAt: now,
  }
  return c.json(attachment, 201)
})


filesRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Attachment not found')
  const shareSlug = c.req.query('share')

  const row = await c.env.DB.prepare(
    `SELECT id, user_id, note_id, filename, mime, size, width, height, storage, created_at
       FROM attachments WHERE id = ?1`,
  )
    .bind(id)
    .first<AttachmentRow>()
  if (!row) throw ApiError.notFound('Attachment not found')

  const userId = c.get('userId')
  let allowed = Boolean(userId && userId === row.user_id)
  if (!allowed && isValidSlug(shareSlug)) {
    const share = await c.env.DB.prepare(
      `SELECT s.slug, s.password_hash, n.content
         FROM shares s
         JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
        WHERE s.slug = ?1 AND s.user_id = ?2 AND n.deleted_at IS NULL
          AND (s.expires_at IS NULL OR s.expires_at > ?3)`,
    )
      .bind(shareSlug, row.user_id, Date.now())
      .first<{ slug: string; password_hash: string | null; content: string }>()
    allowed = Boolean(
      share &&
        extractAttachmentIds(share.content).includes(row.id) &&
        (!share.password_hash ||
          (await verifyShareAssetSession(
            c.env.DB,
            getCookie(c, shareAssetCookieName(shareSlug)),
            share.slug,
            share.password_hash,
          ))),
    )
  }
  if (!allowed) throw ApiError.unauthenticated('You do not have access to this attachment')

  const headers = new Headers({
    'Content-Type': row.mime,
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `${isInlineSafe(row.mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
    'X-Content-Type-Options': 'nosniff',
  })

  if (!hasAttachmentStorage(c.env, row.storage)) {
    throw new ApiError(
      503,
      'storage_unavailable',
      `${row.storage === 'r2' ? 'R2' : 'Workers KV'} attachment storage is not bound, so the attachment cannot be read`,
    )
  }
  const bytes = await readAttachmentObject(c.env, row.storage, attachmentObjectKey(row))
  if (!bytes) throw ApiError.notFound('Attachment data is missing')
  return new Response(bytes as BodyInit, { headers })
})


filesRoutes.get('/', requireAuth, async (c) => {
  const userId = c.get('userId')
  const { results } = await c.env.DB.prepare(
    `SELECT id, user_id, note_id, filename, mime, size, width, height, storage, created_at
       FROM attachments WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 500`,
  )
    .bind(userId)
    .all<AttachmentRow>()
  const { results: notes } = await c.env.DB.prepare(
    `SELECT content FROM notes WHERE user_id = ?1 AND deleted_at IS NULL`,
  )
    .bind(userId)
    .all<{ content: string }>()
  const references = new Map<string, number>()
  for (const note of notes) {
    for (const id of extractAttachmentIds(note.content)) {
      references.set(id, (references.get(id) ?? 0) + 1)
    }
  }
  return c.json({
    files: results.map((row) => ({
      ...toAttachment(row),
      references: references.get(row.id) ?? 0,
    })),
  })
})

filesRoutes.delete('/:id', requireAuth, async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const row = await c.env.DB.prepare(
    `SELECT id, user_id, filename, mime, storage FROM attachments WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(id, userId)
    .first<AttachmentRow>()
  if (!row) throw ApiError.notFound('Attachment not found')

  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at)
       SELECT ?1, user_id, ?2 FROM attachments WHERE id = ?3 AND user_id = ?4`,
    ).bind(
      attachmentCleanupTarget(row.storage, attachmentObjectKey(row)),
      Date.now(),
      id,
      userId,
    ),
  ]
  statements.push(
    c.env.DB.prepare(
      `DELETE FROM import_mappings
        WHERE user_id = ?1 AND entity = 'attachment' AND target_id = ?2`,
    ).bind(userId, id),
  )
  statements.push(
    c.env.DB.prepare(`DELETE FROM attachments WHERE id = ?1 AND user_id = ?2`).bind(id, userId),
  )
  const results = await c.env.DB.batch(statements)
  if (!results.at(-1)?.meta.changes) throw ApiError.notFound('Attachment not found')

  const cleanup = await drainAttachmentCleanup(c.env, userId).catch((error) => {
    console.warn('[inkstone] Attachment deletion will retry later:', error)
    return { processed: 0, pending: true }
  })
  return c.json({ ok: true, cleanupPending: cleanup.pending })
})

filesRoutes.post('/prune', requireAuth, async (c) => {
  const userId = c.get('userId')

  const { results: files } = await c.env.DB.prepare(
    `SELECT id, user_id, note_id, filename, mime, size, width, height, storage, created_at
       FROM attachments WHERE user_id = ?1`,
  )
    .bind(userId)
    .all<AttachmentRow>()
  if (!files.length) return c.json({ removed: 0, freedBytes: 0 })

  const { results: notes } = await c.env.DB.prepare(
    `SELECT content FROM notes WHERE user_id = ?1`,
  )
    .bind(userId)
    .all<{ content: string }>()

  const referenced = new Set<string>()
  for (const note of notes) {
    for (const id of extractAttachmentIds(note.content)) referenced.add(id)
  }
  const orphans = files.filter((file) => !referenced.has(file.id))
  if (!orphans.length) return c.json({ removed: 0, freedBytes: 0 })

  const removed: AttachmentRow[] = []
  let statements: D1PreparedStatement[] = []
  const operations: Array<
    { kind: 'queue' | 'mapping' } | { kind: 'delete'; file: AttachmentRow }
  > = []

  const flush = async () => {
    if (!statements.length) return
    const results = await c.env.DB.batch(statements)
    results.forEach((result, index) => {
      const operation = operations[index]
      if (operation?.kind === 'delete' && result.meta.changes) removed.push(operation.file)
    })
    statements = []
    operations.length = 0
  }

  for (const file of orphans) {
    const guard = `id = ?1 AND user_id = ?2 AND NOT EXISTS (
      SELECT 1 FROM notes n
       WHERE n.user_id = ?2 AND instr(n.content, attachments.id) > 0
    )`
    const needed = 3
    if (statements.length + needed > 100) await flush()
    statements.push(
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at)
         SELECT ?3, user_id, ?4 FROM attachments WHERE ${guard}`,
      ).bind(
        file.id,
        userId,
        attachmentCleanupTarget(file.storage, attachmentObjectKey(file)),
        Date.now(),
      ),
    )
    operations.push({ kind: 'queue' })
    statements.push(
      c.env.DB.prepare(
        `DELETE FROM import_mappings
          WHERE user_id = ?1 AND entity = 'attachment' AND target_id = ?2
            AND EXISTS (
              SELECT 1 FROM attachments a
               WHERE a.id = ?2 AND a.user_id = ?1 AND NOT EXISTS (
                 SELECT 1 FROM notes n
                  WHERE n.user_id = ?1 AND instr(n.content, a.id) > 0
               )
            )`,
      ).bind(userId, file.id),
    )
    operations.push({ kind: 'mapping' })
    statements.push(
      c.env.DB.prepare(`DELETE FROM attachments WHERE ${guard}`).bind(file.id, userId),
    )
    operations.push({ kind: 'delete', file })
  }
  await flush()

  const cleanup = await drainAttachmentCleanup(c.env, userId).catch((error) => {
    console.warn('[inkstone] Attachment cleanup will retry later:', error)
    return { processed: 0, pending: true }
  })
  const freed = removed.reduce((total, file) => total + file.size, 0)
  return c.json({ removed: removed.length, freedBytes: freed, cleanupPending: cleanup.pending })
})
