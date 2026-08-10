import { APP_VERSION, mergeSettings } from '@shared/constants'
import type { PublicUser, SessionInfo, SiteInfo } from '@shared/types'
import { selectAttachmentStorage } from '../attachments/backend'
import type { Env, Variables } from '../env'
import { rowToUser, USER_COLUMNS } from '../middleware/auth'
import { getAllowRegistration } from './instance-settings'

export async function buildSiteInfo(env: Env): Promise<SiteInfo> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>()
  return {
    name: env.APP_NAME || 'Inkstone',
    initialized: (row?.n ?? 0) > 0,
    registrationOpen: await getAllowRegistration(env.DB),
    r2Enabled: Boolean(env.FILES),
    kvEnabled: Boolean(env.FILES_KV),
    attachmentStorage: selectAttachmentStorage(env),
    realtimeEnabled: Boolean(env.SYNC_HUB),
    version: APP_VERSION,
  }
}

export function publicUser(user: Variables['user']): PublicUser {
  return {
    id: user.id,
    login: user.login,
    name: user.name || user.login,
    avatarUrl: user.avatarUrl,
    role: user.role,
    createdAt: user.createdAt,
    username: user.username,
  }
}

export async function loadUser(env: Env, id: string): Promise<Variables['user'] | null> {
  const row = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?1`)
    .bind(id)
    .first<Parameters<typeof rowToUser>[0]>()
  return row ? rowToUser(row) : null
}

export async function sessionInfo(env: Env, user: Variables['user']): Promise<SessionInfo> {
  return {
    user: publicUser(user),
    site: await buildSiteInfo(env),
    settings: mergeSettings(safeParse(user.settingsRaw)),
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}
