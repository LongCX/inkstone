


const DEFAULT_FREE_FAILS = 5
const WINDOW_MS = 60 * 60 * 1000
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export interface ThrottleTarget {
  key: string
  freeFails?: number
}

export interface AttemptBudgetTarget {
  key: string
  maxAttempts: number
  windowMs: number
  lockMs?: number
}

type ThrottleInput = string | ThrottleTarget

export class ThrottleError extends Error {
  readonly retryAfterSec: number
  constructor(retryAfterMs: number) {
    super('too_many_attempts')
    this.name = 'ThrottleError'
    this.retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000))
  }
}

function placeholders(n: number): string {
  return Array.from({ length: n }, (_, i) => `?${i + 1}`).join(', ')
}

export async function assertNotLocked(db: D1Database, inputs: readonly ThrottleInput[]): Promise<void> {
  const keys = normalizeTargets(inputs).map((target) => target.key)
  if (!keys.length) return
  const { results } = await db
    .prepare(`SELECT locked_until FROM login_attempts WHERE key IN (${placeholders(keys.length)})`)
    .bind(...keys)
    .all<{ locked_until: number | null }>()
  const now = Date.now()
  let retryAfterMs = 0
  for (const row of results) {
    if (row.locked_until && row.locked_until > now) {
      retryAfterMs = Math.max(retryAfterMs, row.locked_until - now)
    }
  }
  if (retryAfterMs) throw new ThrottleError(retryAfterMs)
}

export async function consumeAttemptBudget(
  db: D1Database,
  inputs: readonly AttemptBudgetTarget[],
): Promise<void> {
  const targets = normalizeAttemptBudgets(inputs)
  if (!targets.length) return
  const now = Date.now()
  await assertNotLocked(db, targets.map((target) => target.key))
  const sql = `
    INSERT INTO login_attempts (key, fails, last_fail_at, locked_until)
    VALUES (?1, 1, ?2, NULL)
    ON CONFLICT(key) DO UPDATE SET
      fails = CASE
        WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until > ?2
          THEN login_attempts.fails
        WHEN ?2 - login_attempts.last_fail_at >= ?3 THEN 1
        ELSE login_attempts.fails + 1
      END,
      last_fail_at = CASE
        WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until > ?2
          THEN login_attempts.last_fail_at
        ELSE ?2
      END,
      locked_until = CASE
        WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until > ?2
          THEN login_attempts.locked_until
        WHEN ?2 - login_attempts.last_fail_at >= ?3 THEN NULL
        WHEN login_attempts.fails + 1 > ?4 THEN ?2 + ?5
        ELSE NULL
      END`
  const statements = targets.map((target) =>
    db.prepare(sql).bind(
      target.key,
      now,
      target.windowMs,
      target.maxAttempts,
      target.lockMs,
    ),
  )
  statements.push(
    db.prepare(`DELETE FROM login_attempts WHERE last_fail_at < ?1`).bind(now - RETENTION_MS),
  )
  await db.batch(statements)
  await assertNotLocked(db, targets.map((target) => target.key))
}

export async function recordLoginFailure(
  db: D1Database,
  inputs: readonly ThrottleInput[],
): Promise<void> {
  const targets = normalizeTargets(inputs)
  if (!targets.length) return
  const now = Date.now()
  const sql = `
    INSERT INTO login_attempts (key, fails, last_fail_at, locked_until)
    VALUES (?1, 1, ?2, NULL)
    ON CONFLICT(key) DO UPDATE SET
      fails = CASE
        WHEN ?2 - login_attempts.last_fail_at > ?3 THEN 1
        ELSE login_attempts.fails + 1
      END,
      last_fail_at = ?2,
      locked_until = CASE
        WHEN ?2 - login_attempts.last_fail_at > ?3 THEN NULL
        WHEN login_attempts.fails + 1 < ?4 THEN NULL
        WHEN login_attempts.fails + 1 = ?4 THEN ?2 + 60000
        WHEN login_attempts.fails + 1 = ?4 + 1 THEN ?2 + 120000
        WHEN login_attempts.fails + 1 = ?4 + 2 THEN ?2 + 240000
        WHEN login_attempts.fails + 1 = ?4 + 3 THEN ?2 + 480000
        ELSE ?2 + 900000
      END`
  const statements = targets.map((target) =>
    db.prepare(sql).bind(target.key, now, WINDOW_MS, target.freeFails),
  )
  statements.push(
    db.prepare(`DELETE FROM login_attempts WHERE last_fail_at < ?1`).bind(now - RETENTION_MS),
  )
  await db.batch(statements)
}

export async function clearLoginFailures(
  db: D1Database,
  inputs: readonly ThrottleInput[],
): Promise<void> {
  const keys = normalizeTargets(inputs).map((target) => target.key)
  if (!keys.length) return
  await db
    .prepare(`DELETE FROM login_attempts WHERE key IN (${placeholders(keys.length)})`)
    .bind(...keys)
    .run()
}

function normalizeTargets(inputs: readonly ThrottleInput[]): Required<ThrottleTarget>[] {
  const unique = new Map<string, number>()
  for (const input of inputs) {
    const rawKey = typeof input === 'string' ? input : input.key
    const key = rawKey.slice(0, 256)
    if (!key) continue
    const requested = typeof input === 'string' ? DEFAULT_FREE_FAILS : input.freeFails
    const freeFails = Math.min(100, Math.max(2, Math.trunc(requested ?? DEFAULT_FREE_FAILS)))
    const previous = unique.get(key)
    unique.set(key, previous === undefined ? freeFails : Math.min(previous, freeFails))
  }
  return [...unique].map(([key, freeFails]) => ({ key, freeFails }))
}

function normalizeAttemptBudgets(inputs: readonly AttemptBudgetTarget[]): Required<AttemptBudgetTarget>[] {
  const unique = new Map<string, Required<AttemptBudgetTarget>>()
  for (const input of inputs) {
    const key = input.key.slice(0, 256)
    if (!key) continue
    const maxAttempts = Math.min(1000, Math.max(1, Math.trunc(input.maxAttempts)))
    const windowMs = Math.min(24 * 60 * 60 * 1000, Math.max(1000, Math.trunc(input.windowMs)))
    const lockMs = Math.min(
      24 * 60 * 60 * 1000,
      Math.max(1000, Math.trunc(input.lockMs ?? windowMs)),
    )
    const candidate = { key, maxAttempts, windowMs, lockMs }
    const previous = unique.get(key)
    if (!previous || maxAttempts < previous.maxAttempts) unique.set(key, candidate)
  }
  return [...unique.values()]
}
