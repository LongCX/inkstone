import { makeZip, predictLength } from 'client-zip'
import type { BackupFile, Snapshot } from './snapshot'

export interface BackupArchive {
  filename: string
  byteLength: bigint
  byteLengthNumber: number
  stream: ReadableStream<Uint8Array>
}

export function backupArchiveFilename(snapshot: Pick<Snapshot, 'stamp'>): string {
  return `inkstone-backup-${snapshot.stamp}.zip`
}

export function backupArchivePath(snapshot: Pick<Snapshot, 'stamp'>): string {
  return `backups/${backupArchiveFilename(snapshot)}`
}

export function createBackupArchive(snapshot: Snapshot): BackupArchive {
  const files = snapshotFiles(snapshot)
  const byteLength = predictLength(metadataFromFiles(files, snapshot.createdAt))
  const byteLengthNumber = Number(byteLength)
  if (!Number.isSafeInteger(byteLengthNumber) || byteLengthNumber < 0) {
    throw new Error('The backup ZIP is too large to transfer safely')
  }

  return {
    filename: backupArchiveFilename(snapshot),
    byteLength,
    byteLengthNumber,
    stream: cancellationSafeStream(makeZip(openFiles(files, snapshot.createdAt), {
      length: byteLength,
      buffersAreUTF8: true,
    })),
  }
}

function snapshotFiles(snapshot: Snapshot): BackupFile[] {
  return [...snapshot.payloadFiles, snapshot.manifestFile, snapshot.completeFile]
}

function metadataFromFiles(files: readonly BackupFile[], lastModified: Date) {
  return files.map((file) => ({
    name: file.path,
    size: file.byteLength,
    lastModified,
    mode: 0o644,
  }))
}

async function* openFiles(files: readonly BackupFile[], lastModified: Date) {
  for (const file of files) {
    const input = exactSizeStream(await file.open(), file)
    yield {
      name: file.path,
      size: file.byteLength,
      lastModified,
      mode: 0o644,
      input,
    }
  }
}

function exactSizeStream(
  source: ReadableStream<Uint8Array>,
  file: Pick<BackupFile, 'path' | 'byteLength'>,
): ReadableStream<Uint8Array> {
  let bytes = 0
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength
      if (bytes > file.byteLength) throw new Error(`Backup source size changed: ${file.path}`)
      controller.enqueue(chunk)
    },
    flush() {
      if (bytes !== file.byteLength) throw new Error(`Backup source size changed: ${file.path}`)
    },
  }))
}

function cancellationSafeStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null
  let cancelled = false
  let released = false
  const release = () => {
    if (released) return
    released = true
    reader.releaseLock()
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        pending = reader.read()
        const result = await pending
        pending = null
        if (cancelled) {
          release()
          return
        }
        if (result.done) {
          release()
          controller.close()
        } else {
          controller.enqueue(result.value)
        }
      } catch (error) {
        pending = null
        release()
        controller.error(error)
      }
    },
    async cancel() {
      cancelled = true
      if (pending) await pending.catch(() => {})
      release()
    },
  })
}
