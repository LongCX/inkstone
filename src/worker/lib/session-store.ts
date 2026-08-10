import { SESSION_TTL_MS } from '@shared/constants'
import { utf8 } from './encoding'


export function newSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8(token) as BufferSource)
  let out = ''
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, '0')
  return out
}

export function isSessionToken(token: string): boolean {
  return /^[a-f0-9]{64}$/.test(token)
}

export async function createSession(db: D1Database, userId: string): Promise<string> {
  const token = newSessionToken()
  const now = Date.now()
  await db
    .prepare(`INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(await hashToken(token), userId, now + SESSION_TTL_MS, now)
    .run()
  return token
}

export async function renewSession(db: D1Database, sessionId: string): Promise<void> {
  await db
    .prepare(`UPDATE sessions SET expires_at = ?1 WHERE id = ?2`)
    .bind(Date.now() + SESSION_TTL_MS, sessionId)
    .run()
}

export async function destroySession(db: D1Database, token: string): Promise<void> {
  if (!isSessionToken(token)) return
  await db.prepare(`DELETE FROM sessions WHERE id = ?1`).bind(await hashToken(token)).run()
}


export async function destroyOtherSessions(
  db: D1Database,
  userId: string,
  keepSessionId: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM sessions WHERE user_id = ?1 AND id != ?2`)
    .bind(userId, keepSessionId)
    .run()
}
