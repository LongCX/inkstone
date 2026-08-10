/**
 * Static API keys for MCP access.
 *
 * Small or generic MCP clients (scripts, SDKs, unnamed agents) cannot run the
 * OAuth 2.1 dance, so they authenticate with a plain `Authorization: Bearer
 * <key>` header — the universal HTTP standard. The OAuth provider resolves
 * these tokens through its official `resolveExternalToken` hook; the key is
 * never stored or returned again, only its SHA-256 hash.
 */
import { sha256Hex, toBase64Url } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { getMcpPreferences, grantedMcpScopes, MCP_SUPPORTED_SCOPES } from './settings'

const KEY_PREFIX = 'ink_'
const ACTIVE_KEYS_MAX = 50
// 32 random bytes encoded as unpadded base64url is exactly 43 characters.
const KEY_TOKEN_RE = /^ink_[A-Za-z0-9_-]{43}$/

export interface McpApiKeyRecord {
  id: string
  name: string
  scopes: string[]
  createdAt: number
  lastUsedAt: number | null
}

export interface McpApiKeyAuth {
  userId: string
  role: 'owner' | 'member'
  scopes: string[]
}

interface ApiKeyRow {
  user_id: string
  role: string
  scopes: string
  last_used_at: number | null
}

const LAST_USED_WRITE_INTERVAL_MS = 10 * 60 * 1000
const REVOKED_KEY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export function generateApiKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return KEY_PREFIX + toBase64Url(bytes)
}

export function parseApiKey(token: string): string | null {
  if (token.length > 128 || !KEY_TOKEN_RE.test(token)) return null
  return token
}

export async function createMcpApiKey(
  db: D1Database,
  userId: string,
  name: string,
): Promise<{ record: McpApiKeyRecord; token: string }> {
  const token = generateApiKey()
  const keyHash = await sha256Hex(token)
  const id = newId()
  const now = Date.now()
  const preferences = await getMcpPreferences(db, userId)
  const scopes = grantedMcpScopes(MCP_SUPPORTED_SCOPES, preferences)
  const inserted = await db.prepare(
    `INSERT INTO mcp_api_keys (id, user_id, name, key_hash, scopes, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6
      WHERE (SELECT COUNT(*) FROM mcp_api_keys
              WHERE user_id = ?2 AND revoked_at IS NULL) < ?7`,
  ).bind(id, userId, name, keyHash, scopes.join(' '), now, ACTIVE_KEYS_MAX).run()
  if (!inserted.meta.changes) {
    throw ApiError.conflict(
      `An account can have at most ${ACTIVE_KEYS_MAX} active MCP API keys`,
    )
  }
  return {
    record: { id, name, scopes, createdAt: now, lastUsedAt: null },
    token,
  }
}

export async function listMcpApiKeys(db: D1Database, userId: string): Promise<McpApiKeyRecord[]> {
  const { results } = await db.prepare(
    `SELECT id, name, scopes, created_at, last_used_at
       FROM mcp_api_keys
      WHERE user_id = ?1 AND revoked_at IS NULL
      ORDER BY created_at DESC`,
  ).bind(userId).all<{
    id: string
    name: string
    scopes: string
    created_at: number
    last_used_at: number | null
  }>()
  return results.map((row) => ({
    id: row.id,
    name: row.name,
    scopes: row.scopes.split(' ').filter(Boolean),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }))
}

export async function revokeMcpApiKey(
  db: D1Database,
  userId: string,
  id: string,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE mcp_api_keys SET revoked_at = ?1
      WHERE id = ?2 AND user_id = ?3 AND revoked_at IS NULL`,
  ).bind(Date.now(), id, userId).run()
  return (result.meta.changes ?? 0) > 0
}

export async function purgeRevokedMcpApiKeys(
  db: D1Database,
  maxAgeMs = REVOKED_KEY_RETENTION_MS,
  limit = 500,
): Promise<void> {
  const capped = Math.max(1, Math.min(1_000, Math.trunc(limit)))
  await db.prepare(
    `DELETE FROM mcp_api_keys WHERE rowid IN (
       SELECT rowid FROM mcp_api_keys
        WHERE revoked_at IS NOT NULL AND revoked_at < ?1
        ORDER BY revoked_at, rowid LIMIT ?2
     )`,
  ).bind(Date.now() - maxAgeMs, capped).run()
}

/**
 * Resolves a bearer token to an account. Returns null for unknown, revoked,
 * or malformed keys so the OAuth provider can answer with 401 invalid_token.
 */
export async function verifyMcpApiKey(
  db: D1Database,
  token: string,
  now = Date.now(),
): Promise<McpApiKeyAuth | null> {
  const parsed = parseApiKey(token)
  if (!parsed) return null
  const keyHash = await sha256Hex(parsed)
  const row = await db.prepare(
    `SELECT k.user_id, k.scopes, k.last_used_at, u.role
       FROM mcp_api_keys k JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = ?1 AND k.revoked_at IS NULL`,
  ).bind(keyHash).first<ApiKeyRow>()
  if (!row || (row.role !== 'owner' && row.role !== 'member')) return null
  if (!row.last_used_at || now - row.last_used_at > LAST_USED_WRITE_INTERVAL_MS) {
    await db.prepare(`UPDATE mcp_api_keys SET last_used_at = ?1 WHERE key_hash = ?2`)
      .bind(now, keyHash).run()
  }
  return {
    userId: row.user_id,
    role: row.role === 'owner' ? 'owner' : 'member',
    scopes: row.scopes.split(' ').filter(Boolean),
  }
}
