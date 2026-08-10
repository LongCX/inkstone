import { sha256Hex, toBase64Url } from './encoding'
import { isValidSlug } from './id'
import { isPasswordHash } from './password'


const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export async function createShareAssetSession(
  db: D1Database,
  slug: string,
  passwordHash: string,
  expiresAt: number,
): Promise<string> {
  if (!isValidSlug(slug) || !isPasswordHash(passwordHash) || !Number.isSafeInteger(expiresAt)) {
    throw new Error('invalid_share_asset_session')
  }
  const token = createOpaqueToken()
  const now = Date.now()
  if (expiresAt <= now) throw new Error('expired_share_asset_session')
  await db
    .prepare(
      `INSERT INTO share_asset_sessions
         (id, slug, password_hash, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(await tokenId(token), slug, passwordHash, expiresAt, now)
    .run()
  return token
}

export async function verifyShareAssetSession(
  db: D1Database,
  token: string | undefined | null,
  slug: string,
  passwordHash: string,
): Promise<boolean> {
  if (!isOpaqueToken(token) || !isValidSlug(slug) || !isPasswordHash(passwordHash)) return false
  const row = await db
    .prepare(
      `SELECT 1 AS present FROM share_asset_sessions
        WHERE id = ?1 AND slug = ?2 AND password_hash = ?3 AND expires_at > ?4`,
    )
    .bind(await tokenId(token), slug, passwordHash, Date.now())
    .first<{ present: number }>()
  return row?.present === 1
}

export async function revokeShareAssetSessions(db: D1Database, slug: string): Promise<void> {
  if (!isValidSlug(slug)) return
  await db.prepare(`DELETE FROM share_asset_sessions WHERE slug = ?1`).bind(slug).run()
}

export function shareAssetCookieName(slug: string): string {
  return `inkstone_share_${slug}`
}

function createOpaqueToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

function isOpaqueToken(value: string | undefined | null): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value)
}

function tokenId(token: string): Promise<string> {
  return sha256Hex(token)
}
