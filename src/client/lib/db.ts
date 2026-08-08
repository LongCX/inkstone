import { clear as clearStore, createStore, del, get, getMany, set, setMany, update } from 'idb-keyval'
import * as idbKeyval from 'idb-keyval'
import type { UseStore } from 'idb-keyval'
import type { Folder, Note, NoteSummary, PublicUser, SessionInfo, SiteInfo, Tag } from '@shared/types'
import { CLIENT_DATABASE_NAME } from './runtime'

const optionalIdbExport = (name: string): unknown => Object.prototype.hasOwnProperty.call(idbKeyval, name)
  ? Reflect.get(idbKeyval, name)
  : undefined
const delMany = optionalIdbExport('delMany') as ((keys: IDBValidKey[], store?: UseStore) => Promise<void>) | undefined
const entries = optionalIdbExport('entries') as (<KeyType extends IDBValidKey, ValueType = unknown>(store?: UseStore) => Promise<[KeyType, ValueType][]>) | undefined

const store = createStore(CLIENT_DATABASE_NAME, 'kv')

const KEY = {
  notes: 'notes',
  folders: 'folders',
  tags: 'tags',
  cursor: 'cursor',
  content: (id: string) => `note:${id}`,
  outbox: 'outbox',
  outboxReplayLease: 'outboxReplayLease',
  userId: 'userId',
  session: 'session',
} as const

interface ShellData {
  notes: NoteSummary[]
  folders: Folder[]
  tags: Tag[]
  cursor: number
}

let shellSaveTimer = 0
let pendingShell: ShellData | null = null
let pendingShellUserId: string | null = null
let activeUserId: string | null = null
const supportsUserNamespaces = typeof entries === 'function' && typeof delMany === 'function'

export interface OutboxItem {
  id: string
  clientId: string
  writeId: string
  dependsOnWriteId?: string
  noteId: string
  payload: Record<string, unknown>
  attempts: number
  createdAt: number
  lastError?: string
}

export interface CachedNoteContent {
  content: string
  rev: number
  updatedAt: number
  writeId?: string
  pendingTitle?: string
  contentDirty?: boolean
}

function normalizeOutbox(value: unknown): OutboxItem[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is OutboxItem => {
    if (!item || typeof item !== 'object') return false
    const candidate = item as Partial<OutboxItem>
    return typeof candidate.id === 'string' &&
      typeof candidate.clientId === 'string' &&
      typeof candidate.writeId === 'string' &&
      typeof candidate.noteId === 'string' &&
      Boolean(candidate.payload) &&
      typeof candidate.payload === 'object' &&
      !Array.isArray(candidate.payload) &&
      typeof candidate.attempts === 'number' &&
      Number.isInteger(candidate.attempts) &&
      typeof candidate.createdAt === 'number' &&
      Number.isFinite(candidate.createdAt)
  })
}

async function safeGet<T>(key: string): Promise<T | undefined> {
  try {
    return await get<T>(key, store)
  } catch {
    return undefined
  }
}

async function safeSet(key: string, value: unknown): Promise<void> {
  try {
    await set(key, value, store)
  } catch {
  }
}

function userScopedKey(key: string, userId = activeUserId): string {
  return userId && supportsUserNamespaces ? `user:${userId}:${key}` : key
}

function isLegacyDataKey(key: unknown): key is string {
  return key === KEY.notes || key === KEY.folders || key === KEY.tags || key === KEY.cursor ||
    key === KEY.outbox || key === KEY.outboxReplayLease || (typeof key === 'string' && key.startsWith('note:'))
}

async function migrateLegacyData(userId: string): Promise<void> {
  if (!supportsUserNamespaces) return
  const legacy = (await entries<string, unknown>(store)).filter(([key]) => isLegacyDataKey(key))
  if (!legacy.length) return
  const scopedKeys = await getMany(legacy.map(([key]) => userScopedKey(key, userId)), store)
  const writes: [string, unknown][] = []
  for (let index = 0; index < legacy.length; index++) {
    if (scopedKeys[index] === undefined) {
      writes.push([userScopedKey(legacy[index]![0], userId), legacy[index]![1]])
    }
  }
  if (writes.length) await setMany(writes, store)
  await delMany(legacy.map(([key]) => key), store)
}

async function bindLocalUser(userId: string): Promise<void> {
  if (activeUserId === userId) {
    await set(KEY.userId, userId, store)
    return
  }
  if (!supportsUserNamespaces) {
    await clearLocalData()
    activeUserId = userId
    await set(KEY.userId, userId, store)
    return
  }
  activeUserId = userId
  const legacyUserId = await safeGet<string>(KEY.userId)
  if (legacyUserId === userId) await migrateLegacyData(userId)
  await set(KEY.userId, userId, store)
}

export const localDb = {
  async loadSession(): Promise<SessionInfo | null> {
    const value = await safeGet<unknown>(KEY.session)
    if (!isRecord(value) || !isPublicUser(value.user) || !isSiteInfo(value.site)) return null
    if (value.settings !== null && !isRecord(value.settings)) return null
    if (await safeGet<string>(KEY.userId) !== value.user.id) return null
    return value as unknown as SessionInfo
  },

  async saveSession(info: SessionInfo): Promise<void> {
    if (!info.user) return
    try {
      await bindLocalUser(info.user.id)
      await set(KEY.session, info, store)
    } catch {
    }
  },

  clearSession: () => del(KEY.session, store).catch(() => {}),

  async loadShell(): Promise<{
    notes: NoteSummary[]
    folders: Folder[]
    tags: Tag[]
    cursor: number
  } | null> {
    const shellKeys = [KEY.notes, KEY.folders, KEY.tags, KEY.cursor].map((key) => userScopedKey(key))
    try {
      const values = await getMany(shellKeys, store)
      const [notes, folders, tags, cursor] = values as [
        NoteSummary[] | undefined,
        Folder[] | undefined,
        Tag[] | undefined,
        number | undefined,
      ]
      if (
        !Array.isArray(notes) || !notes.every(isNoteSummary) ||
        !Array.isArray(folders) || !folders.every(isFolder) ||
        !Array.isArray(tags) || !tags.every(isTag) ||
        typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0
      ) {
        return null
      }
      return {
        notes,
        folders,
        tags,
        cursor,
      }
    } catch {
      return null
    }
  },

  async saveShell(data: ShellData, userId = activeUserId) {
    try {
      await setMany(
        [
          [userScopedKey(KEY.notes, userId), data.notes],
          [userScopedKey(KEY.folders, userId), data.folders],
          [userScopedKey(KEY.tags, userId), data.tags],
          [userScopedKey(KEY.cursor, userId), data.cursor],
        ],
        store,
      )
    } catch {
    }
  },

  scheduleShellSave(data: ShellData) {
    pendingShell = data
    pendingShellUserId = activeUserId
    window.clearTimeout(shellSaveTimer)
    shellSaveTimer = window.setTimeout(() => {
      const snapshot = pendingShell
      const userId = pendingShellUserId
      pendingShell = null
      pendingShellUserId = null
      if (snapshot) void localDb.saveShell(snapshot, userId)
    }, 80)
  },

  async getContent(id: string): Promise<CachedNoteContent | undefined> {
    const value = await safeGet<unknown>(userScopedKey(KEY.content(id)))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const cached = value as Partial<CachedNoteContent>
    if (
      typeof cached.content !== 'string' ||
      !Number.isSafeInteger(cached.rev) ||
      cached.rev! < 1 ||
      typeof cached.updatedAt !== 'number' ||
      !Number.isFinite(cached.updatedAt) ||
      (cached.writeId !== undefined && typeof cached.writeId !== 'string') ||
      (cached.pendingTitle !== undefined && typeof cached.pendingTitle !== 'string') ||
      (cached.contentDirty !== undefined && typeof cached.contentDirty !== 'boolean')
    ) {
      return undefined
    }
    return cached as CachedNoteContent
  },
  setContent: (id: string, value: CachedNoteContent) =>
    safeSet(userScopedKey(KEY.content(id)), value),
  dropContent: (id: string) => del(userScopedKey(KEY.content(id)), store).catch(() => {}),

  getOutbox: async (): Promise<OutboxItem[]> => normalizeOutbox(await safeGet<unknown>(userScopedKey(KEY.outbox))),

  enqueueOutbox(item: OutboxItem): Promise<void> {
    return update<OutboxItem[]>(
      userScopedKey(KEY.outbox),
      (current) => {
        const items = normalizeOutbox(current)
        const previous = items.find((entry) => entry.id === item.id)
        return [
          ...items.filter((entry) => entry.id !== item.id),
          { ...item, createdAt: previous?.createdAt ?? item.createdAt },
        ]
      },
      store,
    )
  },

  completeOutboxItem(id: string, writeId: string): Promise<void> {
    return update<OutboxItem[]>(
      userScopedKey(KEY.outbox),
      (current) => normalizeOutbox(current)
        .filter((item) => item.id !== id || item.writeId !== writeId),
      store,
    )
  },

  updateOutboxRevision(
    id: string,
    writeId: string,
    rev: number,
    preserveVersion = false,
  ): Promise<void> {
    return update<OutboxItem[]>(
      userScopedKey(KEY.outbox),
      (current) => normalizeOutbox(current)
        .map((item) => item.id === id && item.writeId === writeId
          ? {
              ...item,
              dependsOnWriteId: undefined,
              payload: {
                ...item.payload,
                rev,
                ...(preserveVersion ? { preserveVersion: true } : {}),
              },
            }
          : item),
      store,
    )
  },

  setOutboxRecoveryId(id: string, writeId: string, recoveryId: string): Promise<void> {
    return update<OutboxItem[]>(
      userScopedKey(KEY.outbox),
      (current) => normalizeOutbox(current)
        .map((item) => item.id === id && item.writeId === writeId
          ? { ...item, payload: { ...item.payload, recoveryId } }
          : item),
      store,
    )
  },

  advanceOutboxDependents(
    noteId: string,
    sourceWriteId: string,
    expectedRev: number,
    nextRev: number,
  ): Promise<void> {
    return update<OutboxItem[]>(
      userScopedKey(KEY.outbox),
      (current) => normalizeOutbox(current)
        .map((item) => item.noteId === noteId &&
            item.dependsOnWriteId === sourceWriteId &&
            item.payload.rev === expectedRev
          ? { ...item, dependsOnWriteId: undefined, payload: { ...item.payload, rev: nextRev } }
          : item),
      store,
    )
  },

  markOutboxFailure(id: string, writeId: string, message: string): Promise<void> {
    return update<OutboxItem[]>(
      userScopedKey(KEY.outbox),
      (current) => normalizeOutbox(current)
        .map((item) => item.id === id && item.writeId === writeId
          ? { ...item, attempts: item.attempts + 1, lastError: message }
          : item),
      store,
    )
  },

  async withOutboxReplayLock(owner: string, task: () => Promise<void>): Promise<boolean> {
    const lockName = activeUserId ? `inkstone-outbox-replay:${activeUserId}` : 'inkstone-outbox-replay'
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      let acquired = false
      await navigator.locks.request(
        lockName,
        async () => {
          acquired = true
          await task()
        },
      )
      return acquired
    }

    const leaseMs = 90_000
    let acquired = false
    const deadline = Date.now() + 30_000
    while (!acquired && Date.now() < deadline) {
      const now = Date.now()
      await update<{ owner: string; expiresAt: number } | null>(
        userScopedKey(KEY.outboxReplayLease),
        (current) => {
          if (!current || current.expiresAt <= now) {
            acquired = true
            return { owner, expiresAt: now + leaseMs }
          }
          return current
        },
        store,
      )
      if (!acquired) {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 50))
      }
    }
    if (!acquired) return false

    const heartbeat = globalThis.setInterval(() => {
      void update<{ owner: string; expiresAt: number } | null>(
        userScopedKey(KEY.outboxReplayLease),
        (current) => current?.owner === owner
          ? { owner, expiresAt: Date.now() + leaseMs }
          : current ?? null,
        store,
      ).catch(() => {})
    }, 20_000)
    try {
      await task()
      return true
    } finally {
      globalThis.clearInterval(heartbeat)
      await update<{ owner: string; expiresAt: number } | null>(
        userScopedKey(KEY.outboxReplayLease),
        (current) => current?.owner === owner ? null : current ?? null,
        store,
      ).catch(() => {})
    }
  },

  async bindUser(userId: string): Promise<void> {
    await bindLocalUser(userId)
  },

  async clear(): Promise<void> {
    try {
      await clearLocalData()
      activeUserId = null
    } catch {
    }
  },
}

async function clearLocalData(): Promise<void> {
  window.clearTimeout(shellSaveTimer)
  shellSaveTimer = 0
  pendingShell = null
  pendingShellUserId = null
  await clearStore(store)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isPublicUser(value: unknown): value is PublicUser {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' &&
    typeof value.login === 'string' &&
    typeof value.name === 'string' &&
    typeof value.avatarUrl === 'string' &&
    (value.role === 'owner' || value.role === 'member') &&
    isFiniteNumber(value.createdAt) &&
    typeof value.username === 'string'
}

function isSiteInfo(value: unknown): value is SiteInfo {
  if (!isRecord(value)) return false
  return typeof value.name === 'string' &&
    typeof value.initialized === 'boolean' &&
    typeof value.registrationOpen === 'boolean' &&
    typeof value.r2Enabled === 'boolean' &&
    typeof value.kvEnabled === 'boolean' &&
    (value.attachmentStorage === 'r2' || value.attachmentStorage === 'kv' || value.attachmentStorage === null) &&
    typeof value.realtimeEnabled === 'boolean' &&
    typeof value.version === 'string'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value)
}

function isNoteSummary(value: unknown): value is NoteSummary {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.excerpt === 'string' &&
    isNullableString(value.folderId) &&
    Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === 'string') &&
    typeof value.isPinned === 'boolean' &&
    typeof value.isStarred === 'boolean' &&
    typeof value.isArchived === 'boolean' &&
    isFiniteNumber(value.wordCount) &&
    isFiniteNumber(value.charCount) &&
    Number.isSafeInteger(value.rev) && (value.rev as number) >= 1 &&
    isFiniteNumber(value.position) &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.updatedAt) &&
    isNullableNumber(value.deletedAt)
}

function isFolder(value: unknown): value is Folder {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' &&
    isNullableString(value.parentId) &&
    typeof value.name === 'string' &&
    isNullableString(value.icon) &&
    (value.color === undefined || isNullableString(value.color)) &&
    isFiniteNumber(value.position) &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.updatedAt) &&
    (value.noteCount === undefined || isFiniteNumber(value.noteCount))
}

function isTag(value: unknown): value is Tag {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    isNullableString(value.color) &&
    isFiniteNumber(value.count) &&
    isFiniteNumber(value.createdAt)
}

export type BroadcastPayload = (
  | { type: 'local-write'; clientId: string }
  | { type: 'pulled'; cursor: number; clientId: string }
  | { type: 'claim-leader'; clientId: string; at: number }
  | { type: 'settings-changed'; clientId: string }
  | { type: 'profile-changed'; clientId: string }
  | {
      type: 'outbox-base-advanced'
      clientId: string
      noteId: string
      writeId: string
      expectedRev: number
      nextRev: number
    }
  | {
      type: 'outbox-result'
      clientId: string
      targetClientId: string
      noteId: string
      writeId: string
      outcome: 'saved' | 'recovered'
      recoveryReason?: 'conflict' | 'deleted'
      rev?: number
      updatedAt?: number
      savedTitle?: string
      savedNote?: Note
      copyId?: string
    }
) & { userId?: string }

let broadcastPublisher: BroadcastChannel | null = null

export function publishBroadcast(payload: BroadcastPayload): void {
  if (typeof BroadcastChannel === 'undefined') return
  try {
    broadcastPublisher ??= new BroadcastChannel('inkstone')
    broadcastPublisher.postMessage({ ...payload, userId: activeUserId })
  } catch {
  }
}

export function createBroadcast(
  onMessage: (payload: BroadcastPayload) => void,
): { post: (payload: BroadcastPayload) => void; close: () => void } {
  if (typeof BroadcastChannel === 'undefined') {
    return { post: () => {}, close: () => {} }
  }
  const channel = new BroadcastChannel('inkstone')
  channel.onmessage = (event) => {
    const payload = event.data as BroadcastPayload
    if (payload?.userId && payload.userId !== activeUserId) return
    onMessage(payload)
  }
  return {
    post: (payload) => {
      try {
        channel.postMessage({ ...payload, userId: activeUserId })
      } catch {
      }
    },
    close: () => channel.close(),
  }
}
