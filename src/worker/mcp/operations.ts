import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'

interface OperationRow {
  tool: string
  request_hash: string
  response_json: string
  created_at: number
}

interface PendingOperation {
  pending: true
  recovery?: Record<string, unknown>
}

export async function runIdempotent<T>(options: {
  db: D1Database
  userId: string
  operationId: string
  tool: string
  request: unknown
  recovery?: Record<string, unknown>
  recover?: (recovery: Record<string, unknown> | undefined) => Promise<T | null>
  execute: () => Promise<T>
}): Promise<T> {
  const operationId = normalizeOperationId(options.operationId)
  const requestHash = await sha256Hex(stableJson(options.request))
  const pending: PendingOperation = { pending: true, recovery: options.recovery }
  const inserted = await options.db.prepare(
    `INSERT OR IGNORE INTO mcp_operations
       (user_id, operation_id, tool, request_hash, response_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(
    options.userId,
    operationId,
    options.tool,
    requestHash,
    JSON.stringify(pending),
    Date.now(),
  ).run()

  if (!inserted.meta.changes) {
    const existing = await options.db.prepare(
      `SELECT tool, request_hash, response_json, created_at
         FROM mcp_operations WHERE user_id = ?1 AND operation_id = ?2`,
    ).bind(options.userId, operationId).first<OperationRow>()
    if (!existing) throw ApiError.conflict('Operation state changed; retry the call')
    if (existing.tool !== options.tool || existing.request_hash !== requestHash) {
      throw ApiError.conflict('operation_id was already used with different arguments')
    }
    const stored = parseJson(existing.response_json)
    if (!isPending(stored)) return stored as T
    const recovered = await options.recover?.(stored.recovery)
    if (recovered !== null && recovered !== undefined) {
      await storeResponse(options.db, options.userId, operationId, recovered)
      return recovered
    }
    throw ApiError.conflict(
      'The previous call may still be completing. Read the note before retrying with a new operation_id',
      { operationId, startedAt: existing.created_at },
    )
  }

  let result: T
  try {
    result = await options.execute()
  } catch (error) {
    // The mutation itself failed before committing; remove the pending row
    // so the client can retry the same operation_id cleanly.
    await options.db.prepare(
      `DELETE FROM mcp_operations
        WHERE user_id = ?1 AND operation_id = ?2 AND response_json = ?3`,
    ).bind(options.userId, operationId, JSON.stringify(pending)).run().catch(() => {})
    throw error
  }
  try {
    await storeResponse(options.db, options.userId, operationId, result)
  } catch (error) {
    // The mutation already committed. Keep the pending row so a retry goes
    // through the recovery path instead of re-executing and colliding
    // (e.g. create_note with the same id).
    throw error
  }
  return result
}

export async function purgeExpiredMcpOperations(
  db: D1Database,
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  limit = 500,
): Promise<void> {
  const capped = Math.max(1, Math.min(1_000, Math.trunc(limit)))
  await db.prepare(
    `DELETE FROM mcp_operations WHERE rowid IN (
       SELECT rowid FROM mcp_operations
        WHERE created_at < ?1 ORDER BY created_at, rowid LIMIT ?2
     )`,
  )
    .bind(Date.now() - maxAgeMs, capped)
    .run()
}

async function storeResponse<T>(
  db: D1Database,
  userId: string,
  operationId: string,
  response: T,
): Promise<void> {
  await db.prepare(
    `UPDATE mcp_operations SET response_json = ?1
      WHERE user_id = ?2 AND operation_id = ?3`,
  ).bind(JSON.stringify(response), userId, operationId).run()
}

function normalizeOperationId(value: string): string {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(normalized)) {
    throw ApiError.badRequest('operation_id must be 8-128 safe ASCII characters')
  }
  return normalized
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error('Stored MCP operation response is invalid')
  }
}

function isPending(value: unknown): value is PendingOperation {
  return Boolean(value && typeof value === 'object' && (value as PendingOperation).pending === true)
}
