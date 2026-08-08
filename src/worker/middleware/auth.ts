import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { getCookie, setCookie } from 'hono/cookie'
import {
  CLIENT_HEADER,
  LEGACY_SESSION_COOKIE,
  SESSION_COOKIE,
  SESSION_RENEW_BEFORE_MS,
  SESSION_TTL_MS,
} from '@shared/constants'
import { destroySession, hashToken, isSessionToken, renewSession } from '../lib/session-store'
import { ApiError } from '../lib/errors'
import type { AppBindings, Variables } from '../env'

interface UserRow {
  id: string
  username: string
  login: string
  name: string
  avatar_url: string
  role: 'owner' | 'member'
  settings: string
  created_at: number
}

export const USER_COLUMNS = `id, username, login, name, avatar_url, role, settings, created_at`

const USER_COLUMNS_ALIASED = USER_COLUMNS.split(', ').map((column) => `u.${column}`).join(', ')

export function rowToUser(row: UserRow): Variables['user'] {
  return {
    id: row.id,
    username: row.username,
    login: row.login,
    name: row.name,
    avatarUrl: row.avatar_url,

    role: row.role === 'owner' ? 'owner' : 'member',
    createdAt: row.created_at,
    settingsRaw: row.settings,
  }
}


interface SessionUserRow extends UserRow {
  session_id: string
  expires_at: number
}

export const loadSession = createMiddleware<AppBindings>(async (c, next) => {
  const cookieNames = sessionCookieNames(c.req.url)
  const token = cookieNames.map((name) => getCookie(c, name)).find(Boolean)

  if (token && isSessionToken(token)) {
    const row = await c.env.DB.prepare(
      `SELECT ${USER_COLUMNS_ALIASED}, s.id AS session_id, s.expires_at
         FROM sessions s LEFT JOIN users u ON u.id = s.user_id
        WHERE s.id = ?1 AND s.expires_at > ?2`,
    )
      .bind(await hashToken(token), Date.now())
      .first<SessionUserRow>()

    if (row?.session_id) {
      if (!row.id) {
        await destroySession(c.env.DB, token)
        clearSessionCookie(c)
      } else {
        c.set('user', rowToUser(row))
        c.set('userId', row.id)
        c.set('sessionId', row.session_id)

        if (row.expires_at - Date.now() < SESSION_RENEW_BEFORE_MS) {
          await renewSession(c.env.DB, row.session_id)
          writeSessionCookie(c, token)
        }
        const now = Date.now()
        c.executionCtx?.waitUntil(
          c.env.DB.prepare(`UPDATE users SET last_seen_at = ?1 WHERE id = ?2 AND last_seen_at < ?3`)
            .bind(now, row.id, now - 5 * 60 * 1000)
            .run()
            .catch(() => {}),
        )
      }
    } else {
      clearSessionCookie(c)
    }
  }

  await next()
})

export const requireAuth = createMiddleware<AppBindings>(async (c, next) => {
  if (!c.get('userId')) throw ApiError.unauthenticated()
  await next()
})

export const requireClientHeader = createMiddleware<AppBindings>(async (c, next) => {
  const method = c.req.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    if (c.req.header(CLIENT_HEADER) !== '1') {
      throw new ApiError(403, 'forbidden', 'Missing client identification header. Refresh and try again')
    }
  }
  await next()
})

export function sessionCookieString(requestUrl: string, token: string): string {
  const secure = new URL(requestUrl).protocol === 'https:'
  const parts = [
    `${secure ? SESSION_COOKIE : LEGACY_SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function writeSessionCookie(c: Context<AppBindings>, token: string): void {
  c.header('Set-Cookie', sessionCookieString(c.req.url, token), { append: true })
}

export function clearSessionCookie(c: Context<AppBindings>): void {
  const secure = new URL(c.req.url).protocol === 'https:'
  const names = secure ? [SESSION_COOKIE, LEGACY_SESSION_COOKIE] : [LEGACY_SESSION_COOKIE]
  for (const name of names) {
    setCookie(c, name, '', {
      path: '/',
      httpOnly: true,
      maxAge: 0,
      sameSite: 'Lax',
      secure,
    })
  }
}

export function sessionCookieNames(requestUrl: string): string[] {
  return new URL(requestUrl).protocol === 'https:'
    ? [SESSION_COOKIE, LEGACY_SESSION_COOKIE]
    : [LEGACY_SESSION_COOKIE, SESSION_COOKIE]
}
