import { LIMITS } from './constants'

export const MARKDOWN_BACKUP_FORMAT = 'inkstone-markdown-backup'
export const MARKDOWN_BACKUP_VERSION = 3 as const
export type MarkdownBackupVersion = 2 | typeof MARKDOWN_BACKUP_VERSION
export const BACKUP_MANIFEST_NAME = 'manifest.json'
export const BACKUP_COMPLETE_NAME = 'COMPLETE'

export type MarkdownBackupNoteState = 'notes' | 'archived' | 'trash'

export interface MarkdownBackupNoteEntry {
  id: string
  path: string
  title: string
  folder: string[]
  attachmentHashes: string[]
  state: MarkdownBackupNoteState
  archived: boolean
  bytes: number
  sha256: string
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface MarkdownBackupAttachmentEntry {
  path: string
  filename: string
  mime: string
  size: number
  sha256: string
  createdAt: number
}

export interface MarkdownBackupManifest {
  format: typeof MARKDOWN_BACKUP_FORMAT
  version: MarkdownBackupVersion
  appVersion: string
  createdAt: string
  snapshot: string
  notes: MarkdownBackupNoteEntry[]
  attachments: MarkdownBackupAttachmentEntry[]
}

const HASH_RE = /^[0-9a-f]{64}$/
const NOTE_ID_RE = /^[0-9a-hjkmnp-tv-z]{26}$/
const STAMP_RE = /^\d{8}-\d{6}-\d{3}$/

export function backupSnapshotDir(stamp: string): string {
  if (!STAMP_RE.test(stamp)) throw new Error('Invalid backup snapshot name')
  return `snapshots/${stamp}`
}

export function backupManifestPath(
  stamp: string,
  version: MarkdownBackupVersion = MARKDOWN_BACKUP_VERSION,
): string {
  if (version === 2) return `${backupSnapshotDir(stamp)}/${BACKUP_MANIFEST_NAME}`
  if (!STAMP_RE.test(stamp)) throw new Error('Invalid backup snapshot name')
  return BACKUP_MANIFEST_NAME
}

export function backupCompletePath(
  stamp: string,
  version: MarkdownBackupVersion = MARKDOWN_BACKUP_VERSION,
): string {
  if (version === 2) return `${backupSnapshotDir(stamp)}/${BACKUP_COMPLETE_NAME}`
  if (!STAMP_RE.test(stamp)) throw new Error('Invalid backup snapshot name')
  return BACKUP_COMPLETE_NAME
}

export function backupAttachmentPath(sha256: string, filename: string): string {
  if (!HASH_RE.test(sha256)) throw new Error('Invalid attachment checksum')
  return `attachments/${sha256}--${filename}`
}

export function backupCompleteBody(
  manifestSha256: string,
  version: MarkdownBackupVersion = MARKDOWN_BACKUP_VERSION,
): string {
  if (!HASH_RE.test(manifestSha256)) throw new Error('Invalid manifest checksum')
  return `${MARKDOWN_BACKUP_FORMAT} v${version}\nmanifest-sha256 ${manifestSha256}\n`
}

export function completeManifestHash(value: string): string | null {
  const match = /^inkstone-markdown-backup v(?:2|3)\r?\nmanifest-sha256 ([0-9a-f]{64})\r?\n?$/.exec(value)
  return match?.[1] ?? null
}

export function parseMarkdownBackupManifest(value: unknown): MarkdownBackupManifest | null {
  if (!isRecord(value)) return null
  if (
    value.format !== MARKDOWN_BACKUP_FORMAT ||
    (value.version !== 2 && value.version !== MARKDOWN_BACKUP_VERSION)
  ) return null
  if (typeof value.appVersion !== 'string' || value.appVersion.length > 64) return null
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return null
  if (typeof value.snapshot !== 'string' || !STAMP_RE.test(value.snapshot)) return null
  if (!Array.isArray(value.notes) || !Array.isArray(value.attachments)) return null

  const notes: MarkdownBackupNoteEntry[] = []
  const noteIds = new Set<string>()
  const paths = new Set<string>()
  for (const raw of value.notes) {
    if (!isRecord(raw)) return null
    if (typeof raw.id !== 'string' || !NOTE_ID_RE.test(raw.id) || noteIds.has(raw.id)) return null
    if (!isSafeBackupPath(raw.path) || paths.has(raw.path.toLowerCase())) return null
    if (raw.state !== 'notes' && raw.state !== 'archived' && raw.state !== 'trash') return null
    if (typeof raw.archived !== 'boolean') return null
    if (
      !Array.isArray(raw.folder) ||
      raw.folder.length > LIMITS.folderDepthMax ||
      raw.folder.some((name) => !isBackupFolderName(name))
    ) return null
    if (
      !Array.isArray(raw.attachmentHashes) ||
      raw.attachmentHashes.some((hash) => typeof hash !== 'string' || !HASH_RE.test(hash)) ||
      new Set(raw.attachmentHashes).size !== raw.attachmentHashes.length
    ) return null
    if (raw.state === 'archived' && !raw.archived) return null
    if (raw.state === 'notes' && raw.archived) return null
    const notePrefix = value.version === 2
      ? `${backupSnapshotDir(value.snapshot)}/${raw.state}/`
      : `${raw.state}/`
    if (!raw.path.startsWith(notePrefix)) return null
    if (typeof raw.title !== 'string' || raw.title.length > 512) return null
    if (
      !isSafeSize(raw.bytes) ||
      raw.bytes > LIMITS.importUploadMaxBytes ||
      typeof raw.sha256 !== 'string' ||
      !HASH_RE.test(raw.sha256)
    ) return null
    if (!isTimestamp(raw.createdAt) || !isTimestamp(raw.updatedAt)) return null
    if (raw.deletedAt !== null && !isTimestamp(raw.deletedAt)) return null
    if (raw.state === 'trash' && raw.deletedAt === null) return null
    if (raw.state !== 'trash' && raw.deletedAt !== null) return null

    noteIds.add(raw.id)
    paths.add(raw.path.toLowerCase())
    notes.push({
      id: raw.id,
      path: raw.path,
      title: raw.title,
      folder: raw.folder as string[],
      attachmentHashes: raw.attachmentHashes as string[],
      state: raw.state,
      archived: raw.archived,
      bytes: raw.bytes,
      sha256: raw.sha256,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      deletedAt: raw.deletedAt,
    })
  }

  const attachments: MarkdownBackupAttachmentEntry[] = []
  const hashes = new Set<string>()
  for (const raw of value.attachments) {
    if (!isRecord(raw)) return null
    if (typeof raw.sha256 !== 'string' || !HASH_RE.test(raw.sha256) || hashes.has(raw.sha256)) return null
    if (!isSafeBackupPath(raw.path) || paths.has(raw.path.toLowerCase())) return null
    const attachmentPrefix = `attachments/${raw.sha256}--`
    if (!raw.path.startsWith(attachmentPrefix) || raw.path.length === attachmentPrefix.length) return null
    if (typeof raw.filename !== 'string' || !raw.filename || raw.filename.length > 180) return null
    if (typeof raw.mime !== 'string' || !raw.mime || raw.mime.length > 255) return null
    if (
      !isSafeSize(raw.size) ||
      raw.size > LIMITS.attachmentMaxBytes ||
      !isTimestamp(raw.createdAt)
    ) return null

    hashes.add(raw.sha256)
    paths.add(raw.path.toLowerCase())
    attachments.push({
      path: raw.path,
      filename: raw.filename,
      mime: raw.mime,
      size: raw.size,
      sha256: raw.sha256,
      createdAt: raw.createdAt,
    })
  }
  if (notes.some((note) => note.attachmentHashes.some((hash) => !hashes.has(hash)))) return null

  return {
    format: MARKDOWN_BACKUP_FORMAT,
    version: value.version,
    appVersion: value.appVersion,
    createdAt: value.createdAt,
    snapshot: value.snapshot,
    notes,
    attachments,
  }
}

export function isSafeBackupPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 2048 || value.includes('\\')) return false
  if (value.startsWith('/') || value.endsWith('/')) return false
  const parts = value.split('/')
  return parts.every(
    (part) => part && part !== '.' && part !== '..' && !/[\u0000-\u001f]/.test(part),
  )
}

function isSafeSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isBackupFolderName(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= LIMITS.folderNameMaxLength &&
    value.trim() === value &&
    !/[\u0000-\u001f/\\]/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
