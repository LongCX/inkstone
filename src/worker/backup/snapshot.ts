/** Produces restorable JSON, readable Markdown, and attachment files for every backup target. */
import { APP_VERSION, LIMITS } from '@shared/constants'
import { splitFrontMatter } from '@shared/markdown-utils'
import { truncateText } from '@shared/text-utils'
import type { ExportAttachment, ExportBundle } from '@shared/types'
import {
  hasAttachmentStorage,
  isAttachmentObjectStorage,
  readAttachmentObject,
} from '../attachments/backend'
import { attachmentObjectKey } from '../attachments/keys'
import type { Env } from '../env'
import { NOTE_COLUMNS_FULL, toFolder, toNote, toTag, type FolderRow, type NoteRow, type TagRow } from '../db/rows'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { safeAttachmentMime } from '../lib/image'
import { estimateZipSizeFromSizes } from '@shared/zip'

export interface BackupFile {
  path: string
  body: Uint8Array
  contentType: string
}

export interface Snapshot {
  files: BackupFile[]
  noteCount: number
  attachmentCount: number
  bytes: number
  stamp: string
  rootDir: string
}

export interface SnapshotOptions {

  includeAttachments?: boolean
}

interface AttachmentSnapshotRow {
  id: string
  user_id: string
  note_id: string | null
  filename: string
  mime: string
  size: number
  sha256: string
  width: number | null
  height: number | null
  storage: string
  created_at: number
}

interface PlannedAttachment {
  row: AttachmentSnapshotRow
  path: string
  metadata: ExportAttachment
}

interface ArchiveEntrySize {
  path: string
  byteLength: number
}

const encoder = new TextEncoder()


export async function buildSnapshot(
  env: Env,
  userId: string,
  options: SnapshotOptions = {},
): Promise<Snapshot> {
  const includeAttachments = options.includeAttachments !== false
  if (includeAttachments) {


    const capacity = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM notes WHERE user_id = ?1) +
         (SELECT COUNT(*) FROM attachments WHERE user_id = ?1) + 3 AS file_count,
         COALESCE((SELECT SUM(size) FROM attachments WHERE user_id = ?1), 0) AS attachment_bytes`,
    ).bind(userId).first<{ file_count: number; attachment_bytes: number }>()
    if ((capacity?.file_count ?? 0) > LIMITS.importArchiveEntriesMax) {
      throw ApiError.tooLarge(
        `The complete backup exceeds the restore limit of ${LIMITS.importArchiveEntriesMax} files`,
      )
    }
    if ((capacity?.attachment_bytes ?? 0) > LIMITS.importUploadMaxBytes) {
      throw ApiError.tooLarge(
        `Total attachment size exceeds ${formatBytes(LIMITS.importUploadMaxBytes)} restore limit`,
      )
    }
  }
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `SELECT ${NOTE_COLUMNS_FULL} FROM notes n
        WHERE n.user_id = ?1 ORDER BY n.created_at ASC`,
    ).bind(userId),
    env.DB.prepare(
      `SELECT f.id, f.parent_id, f.name, f.icon, f.color, f.position, f.created_at, f.updated_at
         FROM folders f WHERE f.user_id = ?1 AND f.deleted_at IS NULL ORDER BY f.position ASC`,
    ).bind(userId),
    env.DB.prepare(`SELECT t.id, t.name, t.color, t.created_at FROM tags t WHERE t.user_id = ?1`).bind(
      userId,
    ),
    env.DB.prepare(`SELECT login, name FROM users WHERE id = ?1`).bind(userId),
  ]
  if (includeAttachments) {
    statements.push(
      env.DB.prepare(
        `SELECT id, user_id, note_id, filename, mime, size, sha256, width, height, storage, created_at
           FROM attachments WHERE user_id = ?1 ORDER BY created_at ASC, id ASC`,
      ).bind(userId),
    )
  }

  const snapshotRows = await env.DB.batch(statements)
  const noteRows = snapshotRows[0] as D1Result<NoteRow>
  const folderRows = snapshotRows[1] as D1Result<FolderRow>
  const tagRows = snapshotRows[2] as D1Result<TagRow>
  const userRow = (snapshotRows[3]?.results?.[0] as { login: string; name: string } | undefined) ?? null
  const attachmentRows = includeAttachments
    ? (snapshotRows[4] as D1Result<AttachmentSnapshotRow>)
    : ({ results: [] } as unknown as D1Result<AttachmentSnapshotRow>)

  const notes = noteRows.results.map(toNote)
  const folders = folderRows.results.map(toFolder)
  const tags = tagRows.results.map(toTag)

  const now = new Date()
  const stamp = formatStamp(now)
  const rootDir = `inkstone-backup-${stamp}`

  const folderPath = buildFolderPaths(folders)
  const files: BackupFile[] = []
  const usedPaths = new Set<string>()

  for (const note of notes) {
    const dir = note.folderId ? folderPath.get(note.folderId) ?? '' : ''
    const base = safeSegment(note.title || "Untitled note")
    const root = note.deletedAt ? 'trash' : 'notes'
    let path = `${root}/${dir ? `${dir}/` : ''}${base}.md`
    let n = 2
    while (usedPaths.has(path.toLowerCase())) {
      path = `${root}/${dir ? `${dir}/` : ''}${base} (${n++}).md`
    }
    usedPaths.add(path.toLowerCase())

    files.push({
      path,
      body: encoder.encode(renderMarkdownFile(note, dir)),
      contentType: 'text/markdown; charset=utf-8',
    })
  }

  const plannedAttachments: PlannedAttachment[] = attachmentRows.results.map((row) => {
    if (!/^[0-9a-hjkmnp-tv-z]{26}$/.test(row.id)) throw new Error('Attachment metadata contains an invalid ID')
    if (!row.filename || row.filename.length > 180) throw new Error(`Invalid attachment filename: ${row.id}`)
    if (
      !Number.isSafeInteger(row.size) ||
      row.size < 0 ||
      row.size > LIMITS.attachmentMaxBytes
    ) {
      throw new Error(`Invalid attachment size: ${row.filename}`)
    }
    if (!/^[0-9a-f]{64}$/.test(row.sha256)) throw new Error(`Invalid attachment checksum: ${row.filename}`)
    if (!isAttachmentObjectStorage(row.storage)) {
      throw new Error(`Invalid attachment storage type: ${row.filename}`)
    }
    const path = `attachments/${row.id}/${safeSegment(row.filename)}`
    return {
      row,
      path,
      metadata: {
        id: row.id,
        noteId: row.note_id,
        filename: row.filename,
        mime: row.mime,
        size: row.size,
        width: row.width,
        height: row.height,
        createdAt: row.created_at,
        path,
        sha256: row.sha256,
      },
    }
  })
  const attachments = plannedAttachments.map((attachment) => attachment.metadata)

  const bundle: ExportBundle = {
    format: 'inkstone-export',
    version: 1,
    exportedAt: now.getTime(),
    user: { login: userRow?.login ?? 'unknown', name: userRow?.name ?? '' },
    folders,
    tags,
    notes,
    attachments,
  }
  const bundleBytes = encoder.encode(JSON.stringify(bundle, null, 2))
  const bundleFile: BackupFile = {
    path: 'inkstone-export.json',
    body: bundleBytes,
    contentType: 'application/json; charset=utf-8',
  }

  const readmeFile: BackupFile = {
    path: 'README.txt',
    body: encoder.encode(readme(stamp, notes.length, folders.length, attachments.length)),
    contentType: 'text/plain; charset=utf-8',
  }

  const plannedFiles: ArchiveEntrySize[] = [
    ...files.map((file) => ({ path: file.path, byteLength: file.body.byteLength })),
    ...plannedAttachments.map((attachment) => ({
      path: attachment.path,
      byteLength: attachment.row.size,
    })),
    { path: bundleFile.path, byteLength: bundleFile.body.byteLength },
    { path: readmeFile.path, byteLength: readmeFile.body.byteLength },
  ]
  const manifestTemplate = buildManifest(
    now,
    notes.length,
    folders.length,
    tags.length,
    attachments.length,
    plannedFiles.map((file) => ({
      path: file.path,
      bytes: file.byteLength,
      sha256: '0'.repeat(64),
    })),
  )
  const manifestTemplateBody = encoder.encode(JSON.stringify(manifestTemplate, null, 2))
  if (includeAttachments) {
    assertArchiveSizesCanBeRestored([
      ...plannedFiles,
      { path: 'manifest.json', byteLength: manifestTemplateBody.byteLength },
    ])
  }

  for (const attachment of plannedAttachments) {
    const body = await readAttachmentBody(env, attachment.row)
    if (body.byteLength !== attachment.row.size) {
      throw new Error(`Attachment data length does not match: ${attachment.row.filename}`)
    }
    const sha256 = await sha256Hex(body)
    if (sha256 !== attachment.row.sha256) {
      throw new Error(`Attachment checksum does not match: ${attachment.row.filename}`)
    }
    const mime = safeAttachmentMime(body, attachment.row.mime)
    if (mime !== attachment.row.mime) {
      throw new Error(`Attachment type metadata does not match: ${attachment.row.filename}`)
    }
    files.push({ path: attachment.path, body, contentType: mime })
  }

  files.push(bundleFile, readmeFile)

  const manifest = buildManifest(
    now,
    notes.length,
    folders.length,
    tags.length,
    attachments.length,
    await Promise.all(
      files.map(async (f) => ({
        path: f.path,
        bytes: f.body.byteLength,
        sha256: await sha256Hex(f.body),
      })),
    ),
  )
  const manifestBody = encoder.encode(JSON.stringify(manifest, null, 2))
  if (manifestBody.byteLength !== manifestTemplateBody.byteLength) {
    throw new Error('Backup manifest size preflight did not match')
  }
  files.push({
    path: 'manifest.json',
    body: manifestBody,
    contentType: 'application/json; charset=utf-8',
  })
  if (includeAttachments) assertArchiveCanBeRestored(files)

  return {
    files,
    noteCount: notes.length,
    attachmentCount: attachments.length,
    bytes: files.reduce((sum, f) => sum + f.body.byteLength, 0),
    stamp,
    rootDir,
  }
}


function buildManifest(
  now: Date,
  notes: number,
  folders: number,
  tags: number,
  attachments: number,
  files: Array<{ path: string; bytes: number; sha256: string }>,
) {
  return {
    app: 'Inkstone',
    version: APP_VERSION,
    createdAt: now.toISOString(),
    counts: { notes, folders, tags, attachments },
    files,
  }
}

function renderMarkdownFile(note: ReturnType<typeof toNote>, folderPath: string): string {
  const meta: string[] = ['---']
  meta.push(`id: ${note.id}`)
  meta.push(`title: ${yamlString(note.title)}`)
  if (folderPath) meta.push(`folder: ${yamlString(folderPath)}`)
  if (note.tags.length) meta.push(`tags: [${note.tags.map(yamlString).join(', ')}]`)
  if (note.isStarred) meta.push('starred: true')
  if (note.isPinned) meta.push('pinned: true')
  if (note.isArchived) meta.push('archived: true')
  if (note.deletedAt) meta.push(`deleted: ${new Date(note.deletedAt).toISOString()}`)
  meta.push(`created: ${new Date(note.createdAt).toISOString()}`)
  meta.push(`updated: ${new Date(note.updatedAt).toISOString()}`)
  meta.push('---', '')
  return meta.join('\n') + splitFrontMatter(note.content).body
}

export function assertArchiveCanBeRestored(files: readonly BackupFile[]): void {
  assertArchiveSizesCanBeRestored(
    files.map((file) => ({ path: file.path, byteLength: file.body.byteLength })),
  )
}

function assertArchiveSizesCanBeRestored(files: readonly ArchiveEntrySize[]): void {
  if (files.length > LIMITS.importArchiveEntriesMax) {
    throw ApiError.tooLarge(
      `The complete backup contains ${files.length} files, exceeding the restore limit of ${LIMITS.importArchiveEntriesMax}`,
    )
  }
  const expandedBytes = files.reduce((sum, file) => sum + file.byteLength, 0)
  if (!Number.isSafeInteger(expandedBytes) || expandedBytes > LIMITS.importArchiveExpandedMaxBytes) {
    throw ApiError.tooLarge(
      `The expanded backup exceeds ${formatBytes(LIMITS.importArchiveExpandedMaxBytes)} restore limit`,
    )
  }
  const zipBytes = estimateZipSizeFromSizes(files)
  if (zipBytes > LIMITS.importUploadMaxBytes) {
    throw ApiError.tooLarge(
      `The complete backup exceeds ${formatBytes(LIMITS.importUploadMaxBytes)} restore limit`,
    )
  }
}

export function assertBundleCanBeRestored(bundle: Uint8Array): void {
  if (bundle.byteLength > LIMITS.importBundleMaxBytes) {
    throw ApiError.tooLarge(
      `The JSON export exceeds ${formatBytes(LIMITS.importBundleMaxBytes)} restore limit`,
    )
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function buildFolderPaths(folders: { id: string; parentId: string | null; name: string }[]) {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const cache = new Map<string, string>()

  const resolve = (id: string, guard = 0): string => {
    if (cache.has(id)) return cache.get(id)!
    const folder = byId.get(id)
    if (!folder || guard > 16) return ''
    const parent = folder.parentId ? resolve(folder.parentId, guard + 1) : ''
    const path = parent ? `${parent}/${safeSegment(folder.name)}` : safeSegment(folder.name)
    cache.set(id, path)
    return path
  }

  for (const folder of folders) resolve(folder.id)
  return cache
}

export function safeSegment(name: string): string {
  const normalized = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
  const cleaned = truncateText(normalized, 80).replace(/[\s.]+$/g, '')
  if (!cleaned) return 'Untitled'
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)
    ? `_${cleaned}`
    : cleaned
}

function formatStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${ms}`
}

function readme(stamp: string, notes: number, folders: number, attachments: number): string {
  return `Inkstone backup
================================================================

Created at (UTC): ${stamp}
Notes: ${notes}
Folders: ${folders}
Attachments: ${attachments}

Contents
----------------------------------------------------------------
notes/                One .md file per note, preserving the folder structure.
                      The YAML front matter records the title, tags,
                      timestamps, and other metadata. Any Markdown editor can open it.

trash/                Trashed notes; structured restore preserves their deleted state.

inkstone-export.json  Structured notes, folders, tags, and attachment metadata.

attachments/          Raw attachment bytes, verified against the manifest and relinked during restore.

Full restore: open Inkstone, go to Settings > Data > Import, and select the complete ZIP backup.

manifest.json         Byte length and SHA-256 for every file, used to verify backup integrity.

The files under notes/ remain readable plain text even without Inkstone.
`
}

async function readAttachmentBody(env: Env, row: AttachmentSnapshotRow): Promise<Uint8Array> {
  if (!isAttachmentObjectStorage(row.storage)) {
    throw new Error(`Invalid attachment storage type: ${row.filename}`)
  }
  if (!hasAttachmentStorage(env, row.storage)) {
    throw new Error(
      `${row.storage === 'r2' ? 'R2' : 'Workers KV'} is not bound; cannot back up attachment: ${row.filename}`,
    )
  }
  const body = await readAttachmentObject(env, row.storage, attachmentObjectKey(row))
  if (!body) throw new Error(`Attachment data is missing: ${row.filename}`)
  return body
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.ceil(bytes / (1024 * 1024))} MB`
    : `${Math.ceil(bytes / 1024)} KB`
}
