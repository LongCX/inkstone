import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import { countText, deriveExcerpt, deriveTitle, splitFrontMatter } from '@shared/markdown-utils'
import { truncateText, utf8ByteLength } from '@shared/text-utils'
import { organizerColorOrNull } from '@shared/organizer-colors'
import type { ExportBundle, ImportResult } from '@shared/types'
import {
  persistAttachment,
  rollbackPersistedAttachments,
  type PersistedAttachment,
} from '../attachments/storage'
import {
  hasAttachmentStorage,
  readAttachmentObject,
  selectAttachmentStorage,
} from '../attachments/backend'
import { attachmentObjectKey, type AttachmentObjectStorage } from '../attachments/keys'
import type { AppBindings } from '../env'
import {
  buildNoteDerivedStatements,
  pruneOrphanTags,
  runBatched,
} from '../db/writes'
import { enqueueNoteIndex } from '../mcp/ai-search'
import {
  assertArchiveCanBeRestored,
  assertBundleCanBeRestored,
  buildSnapshot,
} from '../backup/snapshot'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { acquireLease } from '../lib/lease'
import { broadcastCursor, scheduleFtsDrain } from '../lib/notify'
import { assertContentSize, FORM_BODY_LIMITS, readFormDataWithinLimit } from '../lib/request'
import { createZip, readZip, type UnzippedEntry } from '@shared/zip'
import {
  buildObsidianAssetIndex,
  collectObsidianReferences,
  findObsidianAsset,
  mimeForAttachmentName,
  rewriteObsidianReferences,
  stripObsidianComments,
  type ObsidianAssetIndex,
} from '../lib/obsidian-import'
import { requireAuth } from '../middleware/auth'

export const transferRoutes = new Hono<AppBindings>()
const EXPORT_FILE = 'inkstone-export.json'
const EXPORT_FORMAT = 'inkstone-export'
type ImportConflict = 'skip' | 'newer' | 'duplicate'
const IMPORT_CONFLICTS = new Set<ImportConflict>(['skip', 'newer', 'duplicate'])
const MAX_IMPORT_WARNINGS = 100

transferRoutes.use('/export', requireAuth)
transferRoutes.use('/import', requireAuth)
transferRoutes.use('/import', async (c, next) => {
  const release = await acquireLease(
    c.env.DB,
    `import_lock:${c.get('userId')}`,
    15 * 60 * 1000,
    'An import is already running. Try again later',
  )

  try {
    await next()
  } finally {
    await release()
  }
})


transferRoutes.get('/export', async (c) => {
  const userId = c.get('userId')
  const release = await acquireLease(
    c.env.DB,
    `snapshot_lock:${userId}`,
    15 * 60 * 1000,
    'A backup or export is already running. Try again later',
  )
  try {
    const format = c.req.query('format') === 'json' ? 'json' : 'zip'
    const snapshot = await buildSnapshot(c.env, userId, { includeAttachments: format !== 'json' })

    if (format === 'json') {
      const bundle = snapshot.files.find((f) => f.path === EXPORT_FILE)
      if (!bundle) throw new Error('Failed to generate the export file')
      assertBundleCanBeRestored(bundle.body)
      return new Response(bundle.body as BodyInit, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="inkstone-export-${snapshot.stamp}.json"`,
          'Cache-Control': 'private, no-store',
        },
      })
    }

    assertArchiveCanBeRestored(snapshot.files)
    const zip = createZip(snapshot.files.map((f) => ({ path: f.path, data: f.body })))
    return new Response(zip as BodyInit, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="inkstone-backup-${snapshot.stamp}.zip"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } finally {
    await release()
  }
})


transferRoutes.post('/import', async (c) => {
  const userId = c.get('userId')
  const { ftsEnabled } = c.get('database')
  const form = await readFormDataWithinLimit(c.req, FORM_BODY_LIMITS.import)

  const conflict = parseImportConflict(form.get('conflict'))
  const files = form.getAll('file').filter((f): f is File => f instanceof File)
  if (!files.length) throw ApiError.badRequest('No files were selected')
  if (files.length > LIMITS.importFilesMax) {
    throw ApiError.badRequest(`Import at most ${LIMITS.importFilesMax} files`)
  }
  const uploadBytes = files.reduce((sum, file) => sum + file.size, 0)
  if (
    !Number.isSafeInteger(uploadBytes) ||
    uploadBytes > LIMITS.importUploadMaxBytes ||
    files.some((file) => file.size > LIMITS.importUploadMaxBytes)
  ) {
    throw ApiError.tooLarge(`A single import cannot exceed ${formatBytes(LIMITS.importUploadMaxBytes)}`)
  }

  const result: ImportResult = {
    createdNotes: 0,
    updatedNotes: 0,
    skippedNotes: 0,
    createdFolders: 0,
    createdAttachments: 0,
    skippedAttachments: 0,
    warnings: [],
  }

  const byId = new Map<string, ExistingNoteIndex | null>()

  const folderCache = new Map<string, string>()
  await primeFolderCache(c.env.DB, userId, folderCache)

  for (const file of files) {
    const name = file.name.toLowerCase()
    try {
      if (name.endsWith('.zip')) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const zipOptions = {
          maxEntries: LIMITS.importArchiveEntriesMax,
          maxEntryBytes: LIMITS.importArchiveExpandedMaxBytes,
          maxTotalBytes: LIMITS.importArchiveExpandedMaxBytes,
        }
        const bundles = await readZip(bytes, {
          ...zipOptions,
          maxEntryBytes: LIMITS.importBundleMaxBytes,
          maxTotalBytes: LIMITS.importBundleMaxBytes,
          include: isExportBundlePath,
        })
        const bundleEntry = bundles[0]
        if (bundles.length > 1) {
          throw new Error('The ZIP contains multiple inkstone-export.json files and is ambiguous')
        }
        if (bundleEntry) {
          const rawBundle = JSON.parse(new TextDecoder().decode(bundleEntry.data)) as unknown
          const expectedAttachmentPaths = collectAttachmentArchivePaths(rawBundle, bundleEntry.path)
          const attachmentEntries = expectedAttachmentPaths.size
            ? await readZip(bytes, {
                ...zipOptions,
                maxEntryBytes: LIMITS.attachmentMaxBytes,
                include: (path) => expectedAttachmentPaths.has(path.toLowerCase()),
              })
            : []
          await importBundle(c, userId, rawBundle, {
            conflict,
            byId,
            folderCache,
            result,
            ftsEnabled,
            attachmentEntries: mapBundleAttachmentEntries(
              attachmentEntries,
              bundleEntry.path,
            ),
          })
        } else {
          const entries = await readZip(bytes, {
            ...zipOptions,
            maxEntryBytes: LIMITS.attachmentMaxBytes,
            include: isImportableEntryPath,
          })
          const assets = buildObsidianAssetIndex(entries.filter((entry) => !isMarkdownPath(entry.path)))
          for (const entry of entries) {
            if (!isMarkdownPath(entry.path)) continue
            await importMarkdown(c, userId, entry.path, new TextDecoder().decode(entry.data), {
              folderCache,
              result,
              ftsEnabled,
              assets,
            })
          }
        }
      } else if (name.endsWith('.json')) {
        if (file.size > LIMITS.importBundleMaxBytes) {
          throw new Error(`The export file cannot exceed ${formatBytes(LIMITS.importBundleMaxBytes)}`)
        }
        await importBundle(c, userId, JSON.parse(await file.text()), {
          conflict,
          byId,
          folderCache,
          result,
          ftsEnabled,
        })
      } else if (/\.(md|markdown|txt)$/i.test(name)) {
        if (file.size > LIMITS.contentMaxBytes) {
          throw new Error(`Note content cannot exceed ${formatBytes(LIMITS.contentMaxBytes)}`)
        }
        await importMarkdown(c, userId, file.name, await file.text(), {
          folderCache,
          result,
          ftsEnabled,
        })
      } else {
        addWarning(result, `Skipped unsupported file: ${file.name}`)
      }
    } catch (err) {
      addWarning(result, `${file.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  await pruneOrphanTags(c.env.DB, userId)
  await broadcastCursor(c)
  scheduleFtsDrain(c, 20)
  return c.json(result)
})


interface ImportContext {
  conflict?: ImportConflict
  byId?: Map<string, ExistingNoteIndex | null>
  folderCache: Map<string, string>
  result: ImportResult
  ftsEnabled: boolean
  attachmentEntries?: Map<string, Uint8Array>
  assets?: ObsidianAssetIndex
}

interface ExistingNoteIndex {
  id: string
  title: string
  rev: number
  updated_at: number
}

interface SourceFolder {
  id: string
  parentId: string | null
  name: string
  icon: string | null
  color: string | null
  position?: number
  createdAt?: number
  updatedAt?: number
}

interface FolderImportMetadata {
  icon: string | null
  color: string | null
  position?: number
  createdAt?: number
  updatedAt?: number
}

async function importBundle(
  c: { env: AppBindings['Bindings'] },
  userId: string,
  raw: unknown,
  ctx: ImportContext,
): Promise<void> {
  const bundle = raw as ExportBundle
  if (
    bundle?.format !== EXPORT_FORMAT ||
    bundle.version !== 1 ||
    !Array.isArray(bundle.notes)
  ) {
    throw new Error('This is not a valid Inkstone export')
  }
  if (bundle.notes.length > LIMITS.importArchiveEntriesMax * 4) {
    throw new Error(`A single import supports at most ${LIMITS.importArchiveEntriesMax * 4} notes`)
  }

  const rawFolders = Array.isArray(bundle.folders) ? bundle.folders : []
  if (rawFolders.length > LIMITS.importArchiveEntriesMax) {
    throw new Error(`A single import supports at most ${LIMITS.importArchiveEntriesMax} folders`)
  }
  const rawTags = Array.isArray(bundle.tags) ? bundle.tags : []
  if (rawTags.length > LIMITS.importArchiveEntriesMax * 2) {
    throw new Error(`A single import supports at most ${LIMITS.importArchiveEntriesMax * 2} tags`)
  }
  const rawAttachments = Array.isArray(bundle.attachments) ? bundle.attachments : []
  if (rawAttachments.length > LIMITS.importArchiveEntriesMax) {
    throw new Error(`A single import supports at most ${LIMITS.importArchiveEntriesMax} attachments`)
  }
  const folders: SourceFolder[] = []
  const sourceFolderIds = new Set<string>()
  for (const rawFolder of rawFolders) {
    if (!isRecord(rawFolder)) continue
    const id = sourceKey(rawFolder.id)
    const name = typeof rawFolder.name === 'string' ? normalizeFolderSegment(rawFolder.name) : ''
    if (!id || !name) continue
    if (sourceFolderIds.has(id)) {
      addWarning(ctx.result, `The export contains a duplicate folder ID: ${id}`)
      continue
    }
    sourceFolderIds.add(id)
    folders.push({
      id,
      name,
      parentId: sourceKey(rawFolder.parentId) ?? null,
      icon: typeof rawFolder.icon === 'string' ? truncateText(rawFolder.icon, 8) || null : null,
      color: organizerColorOrNull(rawFolder.color),
      position: finiteNumber(rawFolder.position),
      createdAt: validTimestamp(rawFolder.createdAt),
      updatedAt: validTimestamp(rawFolder.updatedAt),
    })
  }

  const folderIdMap = new Map<string, string>()
  const sourceFolders = new Map(folders.map((folder) => [folder.id, folder]))
  const pathCache = new Map<string, { path: string; depth: number } | null>()
  const visiting = new Set<string>()
  const pathOf = (id: string): { path: string; depth: number } | null => {
    if (pathCache.has(id)) return pathCache.get(id) ?? null
    const folder = sourceFolders.get(id)
    if (!folder) return null
    if (visiting.has(id)) {
      addWarning(ctx.result, `Skipped folder with a cyclic hierarchy: ${folder.name}`)
      pathCache.set(id, null)
      return null
    }

    visiting.add(id)
    let parent: { path: string; depth: number } | null = null
    if (folder.parentId) {
      if (sourceFolders.has(folder.parentId)) {
        parent = pathOf(folder.parentId)
        if (!parent) {
          visiting.delete(id)
          pathCache.set(id, null)
          return null
        }
      } else {
        addWarning(ctx.result, `Folder ${folder.name} has a missing parent and was moved to the root`)
      }
    }
    const depth = (parent?.depth ?? 0) + 1
    if (depth > LIMITS.folderDepthMax) {
      addWarning(ctx.result, `Skipped folder deeper than ${LIMITS.folderDepthMax} levels: ${folder.name}`)
      visiting.delete(id)
      pathCache.set(id, null)
      return null
    }
    const resolved = {
      path: parent ? `${parent.path}/${folder.name}` : folder.name,
      depth,
    }
    visiting.delete(id)
    pathCache.set(id, resolved)
    return resolved
  }
  const resolvedFolders = folders
    .map((folder) => ({ folder, resolved: pathOf(folder.id) }))
    .filter((entry): entry is { folder: SourceFolder; resolved: { path: string; depth: number } } =>
      entry.resolved !== null)
    .sort((a, b) => a.resolved.depth - b.resolved.depth)

  const importedAttachments = await prepareBundleAttachments(
    c.env,
    userId,
    rawAttachments,
    ctx,
  )

  for (const { folder, resolved } of resolvedFolders) {
    const created = await ensureFolderPath(c.env.DB, userId, resolved.path, ctx, folder)
    if (created) folderIdMap.set(folder.id, created)
  }

  const noteIdMap = new Map<string, string>()

  try {
    for (const note of bundle.notes) {
      if (typeof note?.content !== 'string') continue
      const content = rewriteAttachmentReferences(note.content, importedAttachments.idMap)
      try {
        assertContentSize(content)
      } catch (err) {
        ctx.result.skippedNotes++
        addWarning(
          ctx.result,
          `${typeof note.title === 'string' ? note.title : "Untitled note"}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        continue
      }

      const noteTitle = importedBundleTitle(note.title, content)
      const sourceId = isValidId(note.id) ? note.id : undefined
      const importedCreatedAt = validTimestamp(note.createdAt)
      const importedUpdatedAt = validTimestamp(note.updatedAt)
      const importedDeletedAt = validTimestamp(note.deletedAt)
      const effectiveUpdatedAt = Math.max(
        importedUpdatedAt || importedCreatedAt,
        importedDeletedAt,
      )
      const existing = sourceId
        ? await loadExistingNoteIndex(c.env.DB, userId, sourceId, ctx)
        : null
      const sourceFolderId = sourceKey(note.folderId)
      const input: InsertInput = {
        id: sourceId,
        content,
        title: noteTitle,
        folderId: sourceFolderId ? (folderIdMap.get(sourceFolderId) ?? null) : null,
        isStarred: note.isStarred,
        isPinned: note.isPinned,
        isArchived: note.isArchived,
        position: finiteNumber(note.position),
        createdAt: importedCreatedAt,
        updatedAt: effectiveUpdatedAt,
        deletedAt: importedDeletedAt || undefined,
      }

      if (existing) {
        if (ctx.conflict === 'skip') {
          if (sourceId) noteIdMap.set(sourceId, existing.id)
          ctx.result.skippedNotes++
          continue
        }
        if (ctx.conflict === 'duplicate') {
          const duplicatedId = await insertNote(
            c,
            userId,
            { ...input, id: undefined, title: `${noteTitle} (imported)` },
            ctx,
          )
          if (sourceId) noteIdMap.set(sourceId, duplicatedId)
          ctx.result.createdNotes++
          continue
        }

        const outcome = await updateImportedNote(
          c,
          userId,
          existing,
          input,
          effectiveUpdatedAt,
          ctx,
        )
        if (outcome === 'updated') {
          if (sourceId) noteIdMap.set(sourceId, existing.id)
          ctx.result.updatedNotes++
          continue
        }
        if (outcome === 'skipped' || outcome === 'conflict') {
          if (sourceId) noteIdMap.set(sourceId, existing.id)
          ctx.result.skippedNotes++
          if (outcome === 'conflict') {
            addWarning(ctx.result, `${noteTitle}: the note changed during import, so the current version was kept`)
          }
          continue
        }
      }

      const insertedId = await insertNote(c, userId, input, ctx)
      if (sourceId) noteIdMap.set(sourceId, insertedId)
      if (sourceId) {
        ctx.byId?.set(sourceId, {
          id: insertedId,
          title: noteTitle,
          rev: 1,
          updated_at: effectiveUpdatedAt,
        })
      }
      ctx.result.createdNotes++
    }
  } finally {
    await linkImportedAttachments(c.env.DB, userId, importedAttachments.created, noteIdMap)
  }

  await restoreTagMetadata(c.env.DB, userId, rawTags)
}

interface PreparedAttachmentCandidate {
  sourceId: string
  sourceNoteId: string | null
  filename: string
  reportedMime: string
  bytes: Uint8Array
  sha256: string
  createdAt: number
}

interface CreatedImportedAttachment {
  sourceId: string
  sourceNoteId: string | null
  persisted: PersistedAttachment
}

interface PreparedAttachmentImport {
  idMap: Map<string, string>
  created: CreatedImportedAttachment[]
}

async function prepareBundleAttachments(
  env: AppBindings['Bindings'],
  userId: string,
  rawAttachments: unknown[],
  ctx: ImportContext,
): Promise<PreparedAttachmentImport> {
  const candidates: PreparedAttachmentCandidate[] = []
  const sourceIds = new Set<string>()
  const paths = new Set<string>()

  for (const raw of rawAttachments) {
    if (!isRecord(raw)) throw new Error('The attachment manifest contains an invalid entry')
    const sourceId = typeof raw.id === 'string' && isValidId(raw.id) ? raw.id : ''
    if (!sourceId) throw new Error('The attachment manifest contains an invalid ID')
    if (sourceIds.has(sourceId)) throw new Error(`The attachment manifest contains a duplicate ID: ${sourceId}`)
    sourceIds.add(sourceId)

    const path = validateAttachmentArchivePath(raw.path, sourceId)
    const pathKey = path.toLowerCase()
    if (paths.has(pathKey)) throw new Error(`The attachment manifest contains a duplicate path: ${path}`)
    paths.add(pathKey)

    const filename = typeof raw.filename === 'string' ? raw.filename : ''
    const reportedMime = typeof raw.mime === 'string' ? raw.mime : ''
    const size = raw.size
    const expectedHash = typeof raw.sha256 === 'string' ? raw.sha256.toLowerCase() : ''
    if (!filename || filename.length > 180) throw new Error(`Invalid attachment filename: ${sourceId}`)
    if (!reportedMime || reportedMime.length > 255) throw new Error(`Invalid attachment type: ${filename}`)
    if (!Number.isSafeInteger(size) || (size as number) < 0 || (size as number) > LIMITS.attachmentMaxBytes) {
      throw new Error(`Invalid attachment size: ${filename}`)
    }
    if (!/^[0-9a-f]{64}$/.test(expectedHash)) throw new Error(`Invalid attachment checksum: ${filename}`)

    const bytes = ctx.attachmentEntries?.get(pathKey)
    if (!bytes) {
      ctx.result.skippedAttachments++
      addWarning(ctx.result, `${filename}: attachment bytes are missing from the backup and were not restored`)
      continue
    }
    if (bytes.byteLength !== size) throw new Error(`Attachment length verification failed: ${filename}`)
    if ((await sha256Hex(bytes)) !== expectedHash) throw new Error(`Attachment SHA-256 verification failed: ${filename}`)

    candidates.push({
      sourceId,
      sourceNoteId:
        typeof raw.noteId === 'string' && isValidId(raw.noteId) ? raw.noteId : null,
      filename,
      reportedMime,
      bytes,
      sha256: expectedHash,
      createdAt: validTimestamp(raw.createdAt) || Date.now(),
    })
  }

  if (!candidates.length) return { idMap: new Map(), created: [] }
  if (!selectAttachmentStorage(env)) {
    throw new Error('This instance has no R2 or Workers KV attachment binding and cannot restore attachments')
  }

  const existingAttachments = await loadExistingAttachments(
    env.DB,
    userId,
    candidates.map((candidate) => candidate.sourceId),
  )
  const idMap = new Map<string, string>()
  const created: CreatedImportedAttachment[] = []
  const reservedIds = new Set([...existingAttachments.values()].map((attachment) => attachment.id))

  try {
    for (const candidate of candidates) {
      const existing = existingAttachments.get(candidate.sourceId)
      if (existing?.user_id === userId) {
        const matches = await existingAttachmentMatches(env, existing, candidate)
        if (matches) {
          idMap.set(candidate.sourceId, existing.id)
          ctx.result.skippedAttachments++
          continue
        }
        addWarning(ctx.result, `${candidate.filename}: an existing attachment with this ID has different content, so a new attachment was restored`)
      }

      let destinationId = existing ? newId() : candidate.sourceId
      while (
        reservedIds.has(destinationId) ||
        (destinationId !== candidate.sourceId && sourceIds.has(destinationId))
      ) {
        destinationId = newId()
      }
      reservedIds.add(destinationId)
      idMap.set(candidate.sourceId, destinationId)

      const persisted = await persistAttachment(env, {
        id: destinationId,
        userId,
        noteId: null,
        filename: candidate.filename,
        reportedMime: candidate.reportedMime,
        bytes: candidate.bytes,
        createdAt: candidate.createdAt,
      })
      created.push({
        sourceId: candidate.sourceId,
        sourceNoteId: candidate.sourceNoteId,
        persisted,
      })
    }
    await upsertImportMappings(
      env.DB,
      userId,
      'attachment',
      created.map((entry) => ({ sourceId: entry.sourceId, targetId: entry.persisted.id })),
    )
  } catch (error) {
    await rollbackPersistedAttachments(
      env,
      created.map((entry) => entry.persisted),
    ).catch((rollbackError) => {
      console.warn('[inkstone] Attachment import rollback was incomplete; the cleanup queue will continue:', rollbackError)
    })
    throw error
  }

  ctx.result.createdAttachments += created.length
  return { idMap, created }
}

interface ExistingAttachmentRow {
  id: string
  user_id: string
  filename: string
  mime: string
  size: number
  sha256: string
  storage: AttachmentObjectStorage
}

async function loadExistingAttachments(
  db: D1Database,
  userId: string,
  ids: readonly string[],
): Promise<Map<string, ExistingAttachmentRow>> {
  const attachments = new Map<string, ExistingAttachmentRow>()
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80)
    const placeholders = chunk.map((_, index) => `?${index + 2}`).join(', ')
    const { results: mappedRows } = await db.prepare(
      `SELECT m.source_id, a.id, a.user_id, a.filename, a.mime, a.size, a.sha256, a.storage
         FROM import_mappings m
         JOIN attachments a ON a.id = m.target_id AND a.user_id = m.user_id
        WHERE m.user_id = ?1 AND m.entity = 'attachment'
          AND m.source_id IN (${placeholders})`,
    )
      .bind(userId, ...chunk)
      .all<ExistingAttachmentRow & { source_id: string }>()
    const mapped = new Map(mappedRows.map((row) => [row.source_id, row]))

    const directPlaceholders = chunk.map((_, index) => `?${index + 1}`).join(', ')
    const { results: directRows } = await db.prepare(
      `SELECT id, user_id, filename, mime, size, sha256, storage
         FROM attachments WHERE id IN (${directPlaceholders})`,
    )
      .bind(...chunk)
      .all<ExistingAttachmentRow>()
    const direct = new Map(directRows.map((row) => [row.id, row]))

    for (const sourceId of chunk) {
      const row = mapped.get(sourceId) ?? direct.get(sourceId)
      if (row) attachments.set(sourceId, row)
    }
  }
  return attachments
}

async function existingAttachmentMatches(
  env: AppBindings['Bindings'],
  row: ExistingAttachmentRow,
  candidate: PreparedAttachmentCandidate,
): Promise<boolean> {
  if (row.size !== candidate.bytes.byteLength || row.sha256 !== candidate.sha256) return false
  if (!hasAttachmentStorage(env, row.storage)) return false
  const bytes = await readAttachmentObject(env, row.storage, attachmentObjectKey(row))
  if (!bytes) return false
  return bytes.byteLength === candidate.bytes.byteLength &&
    (await sha256Hex(bytes)) === candidate.sha256
}

async function linkImportedAttachments(
  db: D1Database,
  userId: string,
  created: readonly CreatedImportedAttachment[],
  noteIdMap: ReadonlyMap<string, string>,
): Promise<void> {
  for (let offset = 0; offset < created.length; offset += 100) {
    await db.batch(
      created.slice(offset, offset + 100).map((entry) =>
        db.prepare(
          `UPDATE attachments SET note_id = ?1 WHERE id = ?2 AND user_id = ?3`,
        ).bind(
          entry.sourceNoteId ? noteIdMap.get(entry.sourceNoteId) ?? null : null,
          entry.persisted.id,
          userId,
        ),
      ),
    )
  }
}

function rewriteAttachmentReferences(content: string, idMap: ReadonlyMap<string, string>): string {
  if (!idMap.size) return content
  return content.replace(
    /(\/api\/files\/)([0-9a-hjkmnp-tv-z]{26})(?=$|[?#)\]>'"\s])/g,
    (match, prefix: string, sourceId: string) => {
      const destinationId = idMap.get(sourceId)
      return destinationId ? `${prefix}${destinationId}` : match
    },
  )
}

async function loadExistingNoteIndex(
  db: D1Database,
  userId: string,
  id: string,
  ctx: ImportContext,
): Promise<ExistingNoteIndex | null> {
  if (ctx.byId?.has(id)) return ctx.byId.get(id) ?? null
  const row = await db.prepare(
    `SELECT n.id, n.title, n.rev, n.updated_at
       FROM notes n
      WHERE n.user_id = ?1
        AND (
          n.id = ?2 OR n.id = (
            SELECT target_id FROM import_mappings
             WHERE user_id = ?1 AND entity = 'note' AND source_id = ?2
          )
        )
      ORDER BY CASE WHEN n.id = (
        SELECT target_id FROM import_mappings
         WHERE user_id = ?1 AND entity = 'note' AND source_id = ?2
      ) THEN 0 ELSE 1 END
      LIMIT 1`,
  ).bind(userId, id).first<ExistingNoteIndex>()
  ctx.byId?.set(id, row ?? null)
  return row ?? null
}

async function upsertImportMappings(
  db: D1Database,
  userId: string,
  entity: 'note' | 'attachment',
  mappings: readonly { sourceId: string; targetId: string }[],
): Promise<void> {
  const now = Date.now()
  await runBatched(
    db,
    mappings.map(({ sourceId, targetId }) =>
      db.prepare(
        `INSERT INTO import_mappings (user_id, entity, source_id, target_id, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(user_id, entity, source_id) DO UPDATE SET
           target_id = excluded.target_id,
           updated_at = excluded.updated_at`,
      ).bind(userId, entity, sourceId, targetId, now),
    ),
  )
}

async function restoreTagMetadata(
  db: D1Database,
  userId: string,
  rawTags: unknown[],
): Promise<void> {
  const byName = new Map<string, { id: string; name: string; color: string | null }>()
  for (const raw of rawTags) {
    if (!isRecord(raw) || typeof raw.name !== 'string') continue
    const name = raw.name.trim().replace(/^#+/, '')
    if (!name || name.length > LIMITS.tagNameMaxLength || /[\s#]/.test(name)) continue
    byName.set(name.toLocaleLowerCase(), {
      id: newId(),
      name,
      color: typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color.trim())
        ? raw.color.trim()
        : null,
    })
  }
  if (!byName.size) return

  const rows = JSON.stringify([...byName.values()])
  const now = Date.now()
  await db.batch([
    db.prepare(
      `INSERT INTO tags (id, user_id, name, color, is_manual, created_at)
       SELECT json_extract(j.value, '$.id'), ?2,
              json_extract(j.value, '$.name'), json_extract(j.value, '$.color'), 1, ?3
         FROM json_each(?1) AS j
        WHERE NOT EXISTS (
          SELECT 1 FROM tags existing
           WHERE existing.user_id = ?2
             AND existing.name = json_extract(j.value, '$.name') COLLATE NOCASE
        )`,
    ).bind(rows, userId, now),
    db.prepare(
      `UPDATE tags SET
         color = COALESCE(color, (
           SELECT json_extract(j.value, '$.color') FROM json_each(?1) AS j
            WHERE json_extract(j.value, '$.name') = tags.name COLLATE NOCASE LIMIT 1
         )),
         is_manual = 1
       WHERE user_id = ?2 AND EXISTS (
         SELECT 1 FROM json_each(?1) AS j
          WHERE json_extract(j.value, '$.name') = tags.name COLLATE NOCASE
       )`,
    ).bind(rows, userId),
    db.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'tag', t.id, 'upsert', ?2
         FROM tags t JOIN json_each(?3) AS j
           ON json_extract(j.value, '$.name') = t.name COLLATE NOCASE
        WHERE t.user_id = ?1`,
    ).bind(userId, now, rows),
  ])
}

async function importMarkdown(
  c: { env: AppBindings['Bindings'] },
  userId: string,
  path: string,
  text: string,
  ctx: ImportContext,
): Promise<void> {
  assertContentSize(text)

  const { meta } = splitFrontMatter(text)
  const normalizedPath = path.replace(/\\/g, '/')
  const dir = normalizedPath.split('/').slice(0, -1).filter(Boolean)
  if (dir[0]?.toLowerCase() === 'notes') dir.shift()
  const folderId = dir.length ? await ensureFolderPath(c.env.DB, userId, dir.join('/'), ctx) : null

  const filename = normalizedPath.split('/').pop() ?? path
  let content = stripObsidianComments(text)
  if (ctx.assets) {
    const assetDir = normalizedPath.split('/').slice(0, -1).join('/')
    const references = collectObsidianReferences(content)
    const replacements = new Map<string, string>()
    for (const reference of references) {
      if (replacements.has(reference)) continue
      const asset = findObsidianAsset(ctx.assets, reference, assetDir)
      if (!asset) continue
      try {
        const persisted = await persistAttachment(c.env, {
          id: newId(),
          userId,
          noteId: null,
          filename: asset.name,
          reportedMime: mimeForAttachmentName(asset.name),
          bytes: asset.bytes,
          createdAt: Date.now(),
        })
        replacements.set(reference, `/api/files/${persisted.id}`)
        ctx.result.createdAttachments++
      } catch (error) {
        addWarning(ctx.result, `${asset.name}: a referenced file could not be imported`)
      }
    }
    if (replacements.size) {
      content = rewriteObsidianReferences(content, (reference) => replacements.get(reference) ?? null)
    }
  }
  const title = importedMarkdownTitle(meta, content, filename.replace(/\.(md|markdown|txt)$/i, ''))

  await insertNote(
    c,
    userId,
    {
      content,
      title,
      folderId,
      isStarred: meta.starred === 'true',
      isPinned: meta.pinned === 'true',
      isArchived: meta.archived === 'true',
      createdAt: parseDate(meta.created),
      updatedAt: parseDate(meta.updated),
    },
    ctx,
  )
  ctx.result.createdNotes++
}

interface InsertInput {
  id?: string
  content: string
  title: string
  folderId: string | null
  isStarred?: boolean
  isPinned?: boolean
  isArchived?: boolean
  position?: number
  createdAt?: number
  updatedAt?: number
  deletedAt?: number
}

async function updateImportedNote(
  c: { env: AppBindings['Bindings'] },
  userId: string,
  existing: ExistingNoteIndex,
  input: InsertInput,
  importedUpdatedAt: number,
  ctx: ImportContext,
): Promise<'updated' | 'skipped' | 'conflict' | 'missing'> {
  const current = await c.env.DB.prepare(
    `SELECT id, title, content, rev, position, created_at, updated_at, deleted_at
       FROM notes WHERE id = ?1 AND user_id = ?2`,
  ).bind(existing.id, userId).first<{
    id: string
    title: string
    content: string
    rev: number
    position: number
    created_at: number
    updated_at: number
    deleted_at: number | null
  }>()
  if (!current) return 'missing'
  if (!importedUpdatedAt || current.updated_at >= importedUpdatedAt) return 'skipped'

  const title = truncateText(input.title.trim(), LIMITS.titleMaxLength)
  const { words, chars } = countText(input.content)
  const hash = await sha256Hex(input.content)
  const nextRev = current.rev + 1
  const updatedAt = validTimestamp(input.updatedAt) || importedUpdatedAt
  const createdAt = Math.min(validTimestamp(input.createdAt) || current.created_at, updatedAt)
  const deletedAt = validTimestamp(input.deletedAt) || null
  const position = finiteNumber(input.position) ?? current.position
  const mutationGuard = `EXISTS (SELECT 1 FROM notes
    WHERE id = ?1 AND user_id = ?2 AND rev = ?3
      AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
  const mutationValues = [current.id, userId, nextRev, hash, title, updatedAt] as const
  const update = c.env.DB.prepare(
    `UPDATE notes SET title = ?1, content = ?2, excerpt = ?3, word_count = ?4, char_count = ?5,
       content_hash = ?6, folder_id = ?7, is_pinned = ?8, is_starred = ?9, is_archived = ?10,
       position = ?11, created_at = ?12, updated_at = ?13, rev = ?14, deleted_at = ?15
      WHERE id = ?16 AND user_id = ?17 AND rev = ?18`,
  ).bind(
    title,
    input.content,
    deriveExcerpt(input.content),
    words,
    chars,
    hash,
    input.folderId,
    input.isPinned === true ? 1 : 0,
    input.isStarred === true ? 1 : 0,
    input.isArchived === true ? 1 : 0,
    position,
    createdAt,
    updatedAt,
    nextRev,
    deletedAt,
    current.id,
    userId,
    current.rev,
  )

  const statements: D1PreparedStatement[] = [update]
  if (current.content !== input.content || current.title !== title) {
    const snapshotAt = Date.now()
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
          WHERE ${shiftSqlPlaceholders(mutationGuard, 7)}`,
      ).bind(
        newId(),
        current.id,
        userId,
        current.title,
        current.content,
        utf8ByteLength(current.content),
        snapshotAt,
        ...mutationValues,
      ),
      c.env.DB.prepare(
        `DELETE FROM note_versions WHERE note_id = ?1
           AND ${shiftSqlPlaceholders(mutationGuard, 1)}
           AND id NOT IN (
             SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC LIMIT ?8
           )`,
      ).bind(current.id, ...mutationValues, LIMITS.versionsPerNote),
    )
  }
  const derived = buildNoteDerivedStatements({
    db: c.env.DB,
    userId,
    noteId: current.id,
    title,
    content: input.content,
    ftsEnabled: ctx.ftsEnabled,
    previousTitle: current.title,
    expectedRev: nextRev,
    expectedContentHash: hash,
    expectedTitle: title,
    expectedUpdatedAt: updatedAt,
    deleted: Boolean(deletedAt),
  }).statements
  statements.push(
    ...derived,
    c.env.DB.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'note', ?2, 'upsert', ?3
        WHERE ${shiftSqlPlaceholders(mutationGuard, 3)}`,
    ).bind(userId, current.id, Date.now(), ...mutationValues),
  )

  const [result] = await c.env.DB.batch(statements)
  if (!result?.meta.changes) return 'conflict'
  existing.title = title
  existing.rev = nextRev
  existing.updated_at = updatedAt
  await enqueueNoteIndex(c.env.DB, userId, current.id, 'embed')
  return 'updated'
}

async function insertNote(
  c: { env: AppBindings['Bindings'] },
  userId: string,
  input: InsertInput,
  ctx: ImportContext,
): Promise<string> {
  assertContentSize(input.content)

  let id = input.id ?? newId()
  const now = Date.now()
  const created = validTimestamp(input.createdAt) || now
  const updated = Math.max(validTimestamp(input.updatedAt) || created, created)
  const deleted = validTimestamp(input.deletedAt) || null
  const position = finiteNumber(input.position) ?? created
  const { words, chars } = countText(input.content)
  const title = truncateText(input.title.trim(), LIMITS.titleMaxLength)

  const hash = await sha256Hex(input.content)
  let inserted = false
  for (let attempt = 0; attempt < 2; attempt++) {
    const insert = c.env.DB.prepare(
      `INSERT INTO notes (id, user_id, folder_id, title, content, excerpt, rev, word_count, char_count,
         is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at, deleted_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
       ON CONFLICT(id) DO NOTHING`,
    )
      .bind(
        id,
        userId,
        input.folderId,
        title,
        input.content,
        deriveExcerpt(input.content),
        words,
        chars,
        input.isPinned === true ? 1 : 0,
        input.isStarred === true ? 1 : 0,
        input.isArchived === true ? 1 : 0,
        position,
        hash,
        created,
        updated,
        deleted,
      )
    const derived = buildNoteDerivedStatements({
      db: c.env.DB,
      userId,
      noteId: id,
      title,
      content: input.content,
      ftsEnabled: ctx.ftsEnabled,
      expectedRev: 1,
      expectedContentHash: hash,
      expectedTitle: title,
      expectedUpdatedAt: updated,
      deleted: Boolean(deleted),
    }).statements
    const change = c.env.DB.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'note', ?2, 'upsert', ?3
        WHERE EXISTS (SELECT 1 FROM notes
          WHERE id = ?2 AND user_id = ?1 AND rev = 1 AND content_hash = ?4 AND updated_at = ?5)`,
    ).bind(userId, id, Date.now(), hash, updated)
    const mapping = input.id
      ? c.env.DB.prepare(
          `INSERT INTO import_mappings (user_id, entity, source_id, target_id, updated_at)
           SELECT ?1, 'note', ?2, ?3, ?4
            WHERE EXISTS (SELECT 1 FROM notes
              WHERE id = ?3 AND user_id = ?1 AND rev = 1
                AND content_hash = ?5 AND updated_at = ?6)
           ON CONFLICT(user_id, entity, source_id) DO UPDATE SET
             target_id = excluded.target_id,
             updated_at = excluded.updated_at`,
        ).bind(userId, input.id, id, Date.now(), hash, updated)
      : null
    const [result] = await c.env.DB.batch([
      insert,
      ...derived,
      change,
      ...(mapping ? [mapping] : []),
    ])
    if (result?.meta.changes) {
      inserted = true
      break
    }
    id = newId()
  }
  if (!inserted) throw new Error('Could not generate a unique note ID')

  if (!deleted) await enqueueNoteIndex(c.env.DB, userId, id, 'embed')
  return id
}

async function primeFolderCache(
  db: D1Database,
  userId: string,
  cache: Map<string, string>,
): Promise<void> {
  const { results } = await db
    .prepare(`SELECT id, parent_id, name FROM folders WHERE user_id = ?1 AND deleted_at IS NULL`)
    .bind(userId)
    .all<{ id: string; parent_id: string | null; name: string }>()

  const byId = new Map(results.map((r) => [r.id, r]))
  const pathOf = (id: string, guard = 0): string => {
    const folder = byId.get(id)
    if (!folder || guard > 16) return ''
    const parent = folder.parent_id ? pathOf(folder.parent_id, guard + 1) : ''
    return parent ? `${parent}/${folder.name}` : folder.name
  }
  for (const row of results) {
    const path = pathOf(row.id)
    if (path) cache.set(path.toLowerCase(), row.id)
  }
}

async function ensureFolderPath(
  db: D1Database,
  userId: string,
  path: string,
  ctx: ImportContext,
  finalMetadata?: FolderImportMetadata,
): Promise<string | null> {
  const rawSegments = path
    .split('/')
    .map((segment) => normalizeFolderSegment(segment))
    .filter(Boolean)
  if (rawSegments.length > LIMITS.folderDepthMax) {
    addWarning(ctx.result, `Folder path exceeds ${LIMITS.folderDepthMax} levels and was truncated: ${path}`)
  }
  const segments = rawSegments.slice(0, LIMITS.folderDepthMax)
  if (!segments.length) return null

  let parentId: string | null = null
  let accumulated = ''

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex]!
    accumulated = accumulated ? `${accumulated}/${segment}` : segment
    const key = accumulated.toLowerCase()
    const cached = ctx.folderCache.get(key)
    if (cached) {
      parentId = cached
      continue
    }

    const id = newId()
    const now = Date.now()
    const isFinal = segmentIndex === segments.length - 1
    const createdAt = isFinal ? validTimestamp(finalMetadata?.createdAt) || now : now
    const updatedAt = isFinal
      ? Math.max(createdAt, validTimestamp(finalMetadata?.updatedAt) || createdAt)
      : now
    const position = isFinal ? finiteNumber(finalMetadata?.position) ?? now : now
    const icon = isFinal ? finalMetadata?.icon ?? null : null
    const color = isFinal ? finalMetadata?.color ?? null : null
    const insert = db.prepare(
      `INSERT OR IGNORE INTO folders
         (id, user_id, parent_id, name, icon, color, position, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(id, userId, parentId, segment, icon, color, position, createdAt, updatedAt)
    const [created] = await db.batch([
      insert,
      db.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?1, 'folder', ?2, 'upsert', ?3
          WHERE EXISTS (SELECT 1 FROM folders WHERE id = ?2 AND user_id = ?1)`,
      ).bind(userId, id, updatedAt),
    ])

    let resolvedId = id
    if (created?.meta.changes) {
      ctx.result.createdFolders++
    } else {
      const existing = await db.prepare(
        `SELECT id FROM folders
          WHERE user_id = ?1 AND parent_id IS ?2 AND lower(name) = lower(?3)
            AND deleted_at IS NULL LIMIT 1`,
      ).bind(userId, parentId, segment).first<{ id: string }>()
      if (!existing) throw new Error(`Could not create folder: ${segment}`)
      resolvedId = existing.id
    }

    ctx.folderCache.set(key, resolvedId)
    parentId = resolvedId
  }
  return parentId
}

function parseDate(value: string | undefined): number {
  if (!value) return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

function validTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.trunc(value), Date.now() + 5 * 60 * 1000)
    : 0
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000_000
    ? value
    : undefined
}

function normalizeFolderSegment(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f/\\]/g, '-')
    .trim()
  return truncateText(normalized, LIMITS.folderNameMaxLength).trim()
}

function isExportBundlePath(path: string): boolean {
  const lower = path.toLowerCase()
  return lower === EXPORT_FILE || lower.endsWith(`/${EXPORT_FILE}`)
}

function collectAttachmentArchivePaths(raw: unknown, bundlePath: string): Set<string> {
  const expected = new Set<string>()
  if (!isRecord(raw) || !Array.isArray(raw.attachments)) return expected
  const base = bundleDirectory(bundlePath)
  for (const attachment of raw.attachments) {
    if (!isRecord(attachment) || typeof attachment.id !== 'string') {
      throw new Error('The attachment manifest contains an invalid entry')
    }
    const path = validateAttachmentArchivePath(attachment.path, attachment.id)
    expected.add(`${base}${path}`.toLowerCase())
  }
  return expected
}

function mapBundleAttachmentEntries(
  entries: readonly UnzippedEntry[],
  bundlePath: string,
): Map<string, Uint8Array> {
  const base = bundleDirectory(bundlePath)
  const baseLower = base.toLowerCase()
  const mapped = new Map<string, Uint8Array>()
  for (const entry of entries) {
    if (!entry.path.toLowerCase().startsWith(baseLower)) continue
    mapped.set(entry.path.slice(base.length).toLowerCase(), entry.data)
  }
  return mapped
}

function bundleDirectory(bundlePath: string): string {
  const slash = bundlePath.lastIndexOf('/')
  return slash >= 0 ? bundlePath.slice(0, slash + 1) : ''
}

function validateAttachmentArchivePath(value: unknown, sourceId: string): string {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\\')) {
    throw new Error(`Invalid attachment path: ${sourceId}`)
  }
  const segments = value.split('/')
  if (
    segments.length !== 3 ||
    segments[0] !== 'attachments' ||
    segments[1] !== sourceId ||
    !segments[2] ||
    segments[2] === '.' ||
    segments[2] === '..' ||
    /[\u0000-\u001f]/.test(segments[2])
  ) {
    throw new Error(`Invalid attachment path: ${sourceId}`)
  }
  return value
}

function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|txt)$/i.test(path)
}

function isImportableEntryPath(path: string): boolean {
  return isMarkdownPath(path) || /\.(png|jpe?g|gif|webp|avif|svg|pdf)$/i.test(path)
}

function isImportConflict(value: unknown): value is ImportConflict {
  return typeof value === 'string' && IMPORT_CONFLICTS.has(value as ImportConflict)
}

export function parseImportConflict(value: unknown): ImportConflict {
  if (value === null || value === undefined) return 'newer'
  if (isImportConflict(value)) return value
  throw ApiError.badRequest('conflict must be skip, newer, or duplicate')
}

export function importedBundleTitle(title: unknown, content: string): string {
  return typeof title === 'string'
    ? truncateText(title.trim(), LIMITS.titleMaxLength)
    : deriveTitle(content)
}

export function importedMarkdownTitle(
  meta: Record<string, string>,
  content: string,
  filenameFallback: string,
): string {
  return Object.prototype.hasOwnProperty.call(meta, 'title')
    ? truncateText(meta.title!.trim(), LIMITS.titleMaxLength)
    : deriveTitle(content, filenameFallback)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sourceKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const key = value.trim()
  return key && key.length <= 128 ? key : undefined
}

function addWarning(result: ImportResult, message: string): void {
  if (result.warnings.length < MAX_IMPORT_WARNINGS - 1) {
    result.warnings.push(truncateText(message, 600))
  } else if (result.warnings.length === MAX_IMPORT_WARNINGS - 1) {
    result.warnings.push('Additional import warnings were omitted')
  }
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.ceil(bytes / (1024 * 1024))} MB`
    : `${Math.ceil(bytes / 1024)} KB`
}

function shiftSqlPlaceholders(sql: string, offset: number): string {
  return sql.replace(/\?(\d+)/g, (_match, value: string) => `?${Number(value) + offset}`)
}

export { runBatched }
