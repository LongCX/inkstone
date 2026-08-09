import {
  backupCompletePath,
  backupManifestPath,
  completeManifestHash,
  MARKDOWN_BACKUP_FORMAT,
  parseMarkdownBackupManifest,
  type MarkdownBackupAttachmentEntry,
  type MarkdownBackupManifest,
  type MarkdownBackupNoteEntry,
} from '@shared/backup-format'
import { LIMITS } from '@shared/constants'
import type { ImportResult } from '@shared/types'
import { t } from './i18n'

interface SelectedBackupFile<T extends MarkdownBackupAttachmentEntry | MarkdownBackupNoteEntry> {
  file: File
  path: string
  entry: T
}

interface BackupSelection {
  manifest: MarkdownBackupManifest
  attachments: SelectedBackupFile<MarkdownBackupAttachmentEntry>[]
  notes: SelectedBackupFile<MarkdownBackupNoteEntry>[]
  warning: string | null
}

type SendBatch = (
  files: File[],
  manifest: MarkdownBackupManifest,
  paths: string[],
) => Promise<ImportResult>

const NOTE_BATCH_BYTES = 8 * 1024 * 1024
const NOTE_BATCH_FILES = 50
const ATTACHMENT_BATCH_FILES = 20

export async function restoreMarkdownBackupFolder(
  files: readonly File[],
  send: SendBatch,
): Promise<ImportResult> {
  const selection = await selectLatestCompleteBackup(files)
  const result = emptyResult()
  const attachmentEntryByHash = new Map(
    selection.manifest.attachments.map((entry) => [entry.sha256, entry]),
  )
  if (selection.warning) result.warnings.push(selection.warning)

  for (const selected of selection.attachments) await verifySelectedFile(selected)
  for (const selected of selection.notes) await verifySelectedFile(selected)

  let attachmentBatch: SelectedBackupFile<MarkdownBackupAttachmentEntry>[] = []
  let attachmentBatchBytes = 0
  const flushAttachments = async () => {
    if (!attachmentBatch.length) return
    mergeResult(
      result,
      await send(
        attachmentBatch.map((selected) => selected.file),
        manifestSlice(
          selection.manifest,
          [],
          attachmentBatch.map((selected) => selected.entry),
        ),
        attachmentBatch.map((selected) => selected.path),
      ),
    )
    attachmentBatch = []
    attachmentBatchBytes = 0
  }
  for (const selected of selection.attachments) {
    if (
      attachmentBatch.length &&
      (
        attachmentBatch.length >= ATTACHMENT_BATCH_FILES ||
        attachmentBatchBytes + selected.file.size > LIMITS.attachmentMaxBytes
      )
    ) {
      await flushAttachments()
    }
    attachmentBatch.push(selected)
    attachmentBatchBytes += selected.file.size
  }
  await flushAttachments()

  let batch: SelectedBackupFile<MarkdownBackupNoteEntry>[] = []
  let batchBytes = 0
  const flush = async () => {
    if (!batch.length) return
    const dependencyHashes = new Set(
      batch.flatMap((selected) => selected.entry.attachmentHashes),
    )
    const dependencies = [...dependencyHashes].map((hash) => attachmentEntryByHash.get(hash)!)
    mergeResult(
      result,
      await send(
        batch.map((selected) => selected.file),
        manifestSlice(selection.manifest, batch.map((selected) => selected.entry), dependencies),
        batch.map((selected) => selected.path),
      ),
    )
    batch = []
    batchBytes = 0
  }
  for (const selected of selection.notes) {
    if (
      batch.length &&
      (batch.length >= NOTE_BATCH_FILES || batchBytes + selected.file.size > NOTE_BATCH_BYTES)
    ) {
      await flush()
    }
    batch.push(selected)
    batchBytes += selected.file.size
  }
  await flush()
  return result
}

async function selectLatestCompleteBackup(files: readonly File[]): Promise<BackupSelection> {
  const byPath = new Map<string, File>()
  for (const file of files) {
    const path = selectedPath(file)
    const key = path.toLowerCase()
    if (byPath.has(key)) throw new Error(t('settings.backup_duplicate_path', { value0: path }))
    byPath.set(key, file)
  }

  const candidates: Array<{
    file: File
    path: string
    manifest: MarkdownBackupManifest
    rootPrefix: string
    complete: File | undefined
  }> = []
  let manifestSeen = false
  for (const file of byPath.values()) {
    const path = selectedPath(file)
    if (!/(?:^|\/)manifest\.json$/i.test(path)) continue
    const legacyPath = /(?:^|\/)snapshots\/\d{8}-\d{6}-\d{3}\/manifest\.json$/i.test(path)
    const directory = path.slice(0, path.lastIndexOf('/') + 1)
    const siblingComplete = byPath.get(`${directory}complete`.toLowerCase())
    if (file.size > LIMITS.importUploadMaxBytes) {
      if (legacyPath || siblingComplete) {
        throw new Error(t('settings.backup_manifest_invalid', { value0: path }))
      }
      continue
    }
    let raw: unknown
    try {
      raw = JSON.parse(await file.text())
    } catch {
      if (legacyPath || siblingComplete) manifestSeen = true
      if (siblingComplete) throw new Error(t('settings.backup_manifest_invalid', { value0: path }))
      continue
    }
    const declaresInkstone = isRecord(raw) && raw.format === MARKDOWN_BACKUP_FORMAT
    if (legacyPath || declaresInkstone) manifestSeen = true
    const manifest = parseMarkdownBackupManifest(raw)
    if (!manifest) {
      if (siblingComplete && declaresInkstone) {
        throw new Error(t('settings.backup_manifest_invalid', { value0: path }))
      }
      continue
    }
    const suffix = backupManifestPath(manifest.snapshot, manifest.version)
    if (!path.toLowerCase().endsWith(suffix.toLowerCase())) {
      if (siblingComplete) throw new Error(t('settings.backup_manifest_invalid', { value0: path }))
      continue
    }
    const rootPrefix = path.slice(0, path.length - suffix.length)
    const complete = byPath.get(
      `${rootPrefix}${backupCompletePath(manifest.snapshot, manifest.version)}`.toLowerCase(),
    )
    if (complete && complete.size > 1024) {
      throw new Error(t('settings.backup_complete_marker_mismatch', { value0: path }))
    }
    candidates.push({ file, path, manifest, rootPrefix, complete })
  }
  candidates.sort((a, b) => b.manifest.snapshot.localeCompare(a.manifest.snapshot))

  const skipped: string[] = []
  for (const candidate of candidates) {
    const { manifest, rootPrefix, complete } = candidate
    if (!complete) {
      skipped.push(manifest.snapshot)
      continue
    }
    const declaredHash = completeManifestHash(await complete.text())
    const actualHash = await sha256File(candidate.file)
    if (!declaredHash || declaredHash !== actualHash) {
      throw new Error(t('settings.backup_complete_marker_mismatch', { value0: candidate.path }))
    }
    const resolve = <T extends MarkdownBackupAttachmentEntry | MarkdownBackupNoteEntry>(
      entry: T,
    ): SelectedBackupFile<T> => {
      const path = entry.path
      const file = byPath.get(`${rootPrefix}${path}`.toLowerCase())
      if (!file) throw new Error(t('settings.backup_missing_file', { value0: path }))
      return { file, path, entry }
    }
    return {
      manifest,
      attachments: manifest.attachments.map(resolve),
      notes: manifest.notes.map(resolve),
      warning: skipped.length
        ? t('settings.backup_newer_snapshot_skipped', { value0: skipped[0] })
        : null,
    }
  }

  throw new Error(
    manifestSeen
      ? t('settings.backup_no_complete_snapshot')
      : t('settings.backup_manifest_not_found'),
  )
}

async function verifySelectedFile(
  selected: SelectedBackupFile<MarkdownBackupAttachmentEntry | MarkdownBackupNoteEntry>,
): Promise<void> {
  const expectedBytes = 'bytes' in selected.entry ? selected.entry.bytes : selected.entry.size
  if (selected.file.size !== expectedBytes) throw new Error(t('settings.backup_file_size_mismatch', { value0: selected.path }))
  if (await sha256File(selected.file) !== selected.entry.sha256) throw new Error(t('settings.backup_file_checksum_failed', { value0: selected.path }))
}

function manifestSlice(
  manifest: MarkdownBackupManifest,
  notes: MarkdownBackupNoteEntry[],
  attachments: MarkdownBackupAttachmentEntry[],
): MarkdownBackupManifest {
  return { ...manifest, notes, attachments }
}

async function sha256File(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function selectedPath(file: File): string {
  return (file.webkitRelativePath || file.name).replace(/\\/g, '/').replace(/^\/+/, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function emptyResult(): ImportResult {
  return {
    createdNotes: 0,
    updatedNotes: 0,
    skippedNotes: 0,
    createdFolders: 0,
    createdAttachments: 0,
    skippedAttachments: 0,
    warnings: [],
  }
}

function mergeResult(target: ImportResult, next: ImportResult): void {
  target.createdNotes += next.createdNotes
  target.updatedNotes += next.updatedNotes
  target.skippedNotes += next.skippedNotes
  target.createdFolders += next.createdFolders
  target.createdAttachments += next.createdAttachments
  target.skippedAttachments += next.skippedAttachments
  for (const warning of next.warnings) {
    if (target.warnings.length >= 100) break
    target.warnings.push(warning)
  }
}
