export async function setMeta(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_meta (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value)
    .run()
}

export async function getMeta(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM app_meta WHERE key = ?1`)
    .bind(key)
    .first<{ value: string }>()
  return row?.value ?? null
}

export async function selectQueueUsersRoundRobin(
  db: D1Database,
  table: 'ai_index_queue' | 'fts_index_queue',
  cursorKey: string,
  limit: number,
): Promise<string[]> {
  const requested = Math.trunc(limit)
  if (!Number.isFinite(requested) || requested <= 0) return []
  const capped = Math.min(1000, requested)
  const cursor = await getMeta(db, cursorKey) ?? ''
  const select = async (comparison: '>' | '<=', boundary: string, count: number) => {
    const { results } = await db.prepare(
      `SELECT DISTINCT user_id FROM ${table}
        WHERE user_id ${comparison} ?1 ORDER BY user_id LIMIT ?2`,
    ).bind(boundary, count).all<{ user_id: string }>()
    return results.map((row) => row.user_id)
  }
  const users = await select('>', cursor, capped)
  if (users.length < capped && cursor) {
    users.push(...await select('<=', cursor, capped - users.length))
  }
  if (users.length) await setMeta(db, cursorKey, users[users.length - 1]!)
  return users
}
