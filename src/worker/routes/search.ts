import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import { segmentCJK, toPlainText } from '@shared/markdown-utils'
import { sliceText, truncateText } from '@shared/text-utils'
import type { GraphResponse, SearchHit, SearchResponse } from '@shared/types'
import type { AppBindings } from '../env'
import { drainFtsQueue, hasPendingFtsWork, rebuildFtsIndex } from '../db/fts'
import { NOTE_COLUMNS, toNoteSummary, type NoteRow } from '../db/rows'
import { ApiError } from '../lib/errors'
import { clampInt } from '../lib/request'
import { scheduleFtsDrain } from '../lib/notify'
import { requireAuth } from '../middleware/auth'

export const searchRoutes = new Hono<AppBindings>()


export interface ParsedQuery {
  text: string
  terms: string[]
  tags: string[]
  folder: string | null
  starred: boolean | null
  archived: boolean | null
  trash: boolean
}


export function parseQuery(raw: string): ParsedQuery {
  const parsed: ParsedQuery = {
    text: '',
    terms: [],
    tags: [],
    folder: null,
    starred: null,
    archived: null,
    trash: false,
  }
  const plain: string[] = []
  const tokenRe = /([A-Za-z]+):"([^"]*)"|"([^"]*)"|(\S+)/g

  for (const m of raw.matchAll(tokenRe)) {
    const quotedKey = m[1]
    const quotedValue = m[2]
    const quoted = m[3]
    const bare = m[4]
    if (quotedKey !== undefined) {
      const key = quotedKey.toLowerCase()
      const value = quotedValue?.trim() ?? ''
      if (key === 'tag' && value) parsed.tags.push(value.replace(/^#/, ''))
      else if (key === 'folder' && value) parsed.folder = value
      else if (value) {
        const token = `${quotedKey}:${value}`
        parsed.terms.push(token)
        plain.push(token)
      }
      continue
    }
    if (quoted !== undefined) {
      if (quoted.trim()) {
        parsed.terms.push(quoted.trim())
        plain.push(quoted.trim())
      }
      continue
    }
    const token = bare ?? ''
    const colon = token.indexOf(':')
    if (colon > 0) {
      const key = token.slice(0, colon).toLowerCase()
      const value = token.slice(colon + 1)
      if (key === 'tag' && value) {
        parsed.tags.push(value.replace(/^#/, ''))
        continue
      }
      if (key === 'folder' && value) {
        parsed.folder = value
        continue
      }
      if (key === 'is') {
        const qualifier = value.toLowerCase()
        if (qualifier === 'starred') parsed.starred = true
        else if (qualifier === 'archived') parsed.archived = true
        else if (qualifier === 'unarchived') parsed.archived = false
        else if (qualifier) {
          parsed.terms.push(token)
          plain.push(token)
        }
        if (qualifier) continue
      }
      if (key === 'in' && value.toLowerCase() === 'trash') {
        parsed.trash = true
        continue
      }
    }
    if (token) {
      parsed.terms.push(token)
      plain.push(token)
    }
  }

  parsed.terms = [...new Set(parsed.terms)].slice(0, 12)
  parsed.tags = [...new Set(parsed.tags)].slice(0, 8)
  parsed.text = plain.slice(0, 12).join(' ')
  return parsed
}

export interface UserSearchResult {
  results: SearchHit[]
  mode: 'fts' | 'like'
  query: ParsedQuery
}

export async function searchUserNotes(
  db: D1Database,
  userId: string,
  raw: string,
  limit: number,
  ftsEnabled: boolean,
  drain = true,
): Promise<UserSearchResult> {
  const query = parseQuery(truncateText(raw.trim(), 512))
  if (!raw.trim()) return { results: [], mode: ftsEnabled ? 'fts' : 'like', query }

  let useFts = ftsEnabled
  if (useFts) {
    try {
      if (drain) await drainFtsQueue(db, userId, 50, true)
      useFts = !(await hasPendingFtsWork(db, userId))
    } catch {
      useFts = false
    }
  }

  if (useFts && query.terms.length && !query.trash) {
    try {
      return { results: await ftsSearch(db, userId, query, limit), mode: 'fts', query }
    } catch (error) {
      console.warn(
        '[inkstone] FTS query failed; falling back to LIKE:',
        error instanceof Error ? error.message : error,
      )
    }
  }
  return { results: await likeSearch(db, userId, query, limit), mode: 'like', query }
}


function buildFtsQuery(terms: string[]): string {
  const parts: string[] = []
  for (const term of terms) {
    const seg = segmentCJK(term).trim().replace(/"/g, '')
    if (!seg) continue
    if (seg.includes(' ')) parts.push(`"${seg}"`)
    else parts.push(`"${seg}"*`)
  }
  return parts.join(' AND ')
}


searchRoutes.get('/search', requireAuth, async (c) => {
  const started = Date.now()
  const userId = c.get('userId')
  const raw = truncateText((c.req.query('q') ?? '').trim(), 512)
  const limit = clampInt(c.req.query('limit'), 1, 200, LIMITS.searchLimit)

  if (!raw) {
    const empty: SearchResponse = {
      results: [],
      mode: 'fts',
      took: 0,
      query: { text: '', tags: [], folder: null, starred: null, archived: null },
    }
    return c.json(empty)
  }

  const { ftsEnabled } = c.get('database')
  scheduleFtsDrain(c, 50)
  const result = await searchUserNotes(c.env.DB, userId, raw, limit, ftsEnabled, false)
  const q = result.query

  const body: SearchResponse = {
    results: result.results,
    mode: result.mode,
    took: Date.now() - started,
    query: {
      text: q.text,
      tags: q.tags,
      folder: q.folder,
      starred: q.starred,
      archived: q.archived,
    },
  }
  return c.json(body)
})

async function ftsSearch(
  db: D1Database,
  userId: string,
  q: ParsedQuery,
  limit: number,
): Promise<SearchHit[]> {
  const match = buildFtsQuery(q.terms)
  if (!match) return []

  const binds: unknown[] = [match, userId]
  let where = `notes_fts MATCH ?1 AND notes_fts.user_id = ?2
    AND n.user_id = ?2 AND n.deleted_at IS NULL`
  applyFilters(q, binds, (clause) => (where += clause))
  binds.push(q.terms[0]!)
  const contentWindow = contentWindowSql(binds.length)
  binds.push(limit)


  const { results } = await db
    .prepare(
      `SELECT ${NOTE_COLUMNS}, ${contentWindow} AS content,
              bm25(notes_fts, 0.0, 0.0, 10.0, 1.0) AS score
         FROM notes_fts JOIN notes n
           ON n.id = notes_fts.note_id AND n.user_id = notes_fts.user_id
        WHERE ${where}
        ORDER BY score ASC, n.updated_at DESC, n.id ASC
        LIMIT ?${binds.length}`,
    )
    .bind(...binds)
    .all<NoteRow & { content: string; score: number }>()

  if (!results.length) return []

  return results.map((row) => ({
    note: toNoteSummary(row),
    snippet: makeSnippet(row.content ?? '', q.terms),
    score: -row.score,
  }))
}

async function likeSearch(
  db: D1Database,
  userId: string,
  q: ParsedQuery,
  limit: number,
): Promise<SearchHit[]> {
  const binds: unknown[] = [userId]
  const termBindIndexes: number[] = []
  let where = 'n.user_id = ?1'
  where += q.trash ? ' AND n.deleted_at IS NOT NULL' : ' AND n.deleted_at IS NULL'

  for (const term of q.terms) {
    binds.push(`%${escapeLike(term)}%`)
    const i = binds.length
    termBindIndexes.push(i)
    where += ` AND (n.title LIKE ?${i} ESCAPE '\\' OR n.content LIKE ?${i} ESCAPE '\\')`
  }
  applyFilters(q, binds, (clause) => (where += clause))

  const candidateLimit = q.terms.length ? Math.min(limit * 3, 600) : limit
  let contentSelect = 'n.excerpt'
  if (q.terms.length) {
    binds.push(q.terms[0]!)
    contentSelect = contentWindowSql(binds.length)
  }
  binds.push(candidateLimit)
  const titleRank = termBindIndexes.length
    ? termBindIndexes.map((index) => `(CASE WHEN n.title LIKE ?${index} ESCAPE '\\' THEN 10 ELSE 0 END)`).join(' + ')
    : '0'
  const { results } = await db
    .prepare(
      `SELECT ${NOTE_COLUMNS}, ${contentSelect} AS content FROM notes n
        WHERE ${where}
        ORDER BY ${titleRank} DESC, n.updated_at DESC, n.id ASC
        LIMIT ?${binds.length}`,
    )
    .bind(...binds)
    .all<NoteRow & { content: string }>()

  const ranked = results.map((row) => ({ row, score: scoreOf(row, q.terms) }))
  if (q.terms.length) {
    ranked.sort(
      (a, b) =>
        b.score - a.score ||
        b.row.updated_at - a.row.updated_at ||
        a.row.id.localeCompare(b.row.id),
    )
  }
  return ranked.slice(0, limit).map(({ row, score }) => ({
    note: toNoteSummary(row),
    snippet: makeSnippet(row.content, q.terms),
    score,
  }))
}

function applyFilters(q: ParsedQuery, binds: unknown[], append: (clause: string) => void): void {
  if (q.starred === true) append(' AND n.is_starred = 1')
  if (q.archived === true) append(' AND n.is_archived = 1')
  else if (q.archived === false) append(' AND n.is_archived = 0')

  for (const tag of q.tags) {
    binds.push(tag)
    append(
      ` AND EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
          WHERE nt.note_id = n.id AND t.name = ?${binds.length})`,
    )
  }
  if (q.folder) {
    binds.push(q.folder)
    append(
      ` AND EXISTS (SELECT 1 FROM folders f WHERE f.id = n.folder_id
          AND f.name = ?${binds.length} AND f.user_id = n.user_id)`,
    )
  }
}

function makeSnippet(content: string, terms: string[], radius = 70): string {
  const plain = toPlainText(content).replace(/\s+/g, ' ')
  if (!plain) return ''
  const lower = plain.toLowerCase()

  let at = -1
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase())
    if (idx >= 0 && (at < 0 || idx < at)) at = idx
  }
  if (at < 0) return truncateText(plain, radius * 2) + (plain.length > radius * 2 ? '…' : '')

  const start = Math.max(0, at - radius)
  const end = Math.min(plain.length, at + radius * 1.6)
  return (start > 0 ? '…' : '') + sliceText(plain, start, end).trim() + (end < plain.length ? '…' : '')
}

function scoreOf(row: NoteRow & { content: string }, terms: string[]): number {
  let score = 0
  const title = row.title.toLowerCase()
  const body = row.content.toLowerCase()
  for (const term of terms) {
    const t = term.toLowerCase()
    if (title.includes(t)) score += 10
    score += countOccurrences(body, t, 8)
  }
  return score
}

function countOccurrences(text: string, query: string, limit: number): number {
  if (!query) return 0
  let count = 0
  let offset = 0
  while (count < limit) {
    const found = text.indexOf(query, offset)
    if (found < 0) break
    count++
    offset = found + query.length
  }
  return count
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

function contentWindowSql(termBindIndex: number): string {
  const found = `instr(lower(n.content), lower(?${termBindIndex}))`
  return `substr(n.content, CASE WHEN ${found} > 180 THEN ${found} - 180 ELSE 1 END, 520)`
}


searchRoutes.get('/graph', requireAuth, async (c) => {
  const userId = c.get('userId')

  const { results: notes } = await c.env.DB.prepare(
    `SELECT id, title, folder_id FROM notes
       WHERE user_id = ?1 AND deleted_at IS NULL AND is_archived = 0
       ORDER BY updated_at DESC, id ASC LIMIT 600`,
  )
    .bind(userId)
    .all<{ id: string; title: string; folder_id: string | null }>()

  const known = new Set(notes.map((n) => n.id))

  const { results: links } = await c.env.DB.prepare(
    `WITH visible AS (
       SELECT id FROM notes WHERE user_id = ?1 AND deleted_at IS NULL AND is_archived = 0
        ORDER BY updated_at DESC, id ASC LIMIT 600
     )
     SELECT l.source_note_id, l.target_note_id FROM links l
       JOIN visible source ON source.id = l.source_note_id
       JOIN visible target ON target.id = l.target_note_id
      WHERE l.user_id = ?1 AND l.target_note_id IS NOT NULL`,
  )
    .bind(userId)
    .all<{ source_note_id: string; target_note_id: string }>()

  const degree = new Map<string, number>()
  const edges: GraphResponse['edges'] = []
  const seen = new Set<string>()

  for (const link of links) {
    if (!known.has(link.source_note_id) || !known.has(link.target_note_id)) continue
    if (link.source_note_id === link.target_note_id) continue
    const key = `${link.source_note_id}>${link.target_note_id}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ source: link.source_note_id, target: link.target_note_id })
    degree.set(link.source_note_id, (degree.get(link.source_note_id) ?? 0) + 1)
    degree.set(link.target_note_id, (degree.get(link.target_note_id) ?? 0) + 1)
  }

  const body: GraphResponse = {
    nodes: notes.map((n) => ({
      id: n.id,
      title: n.title,
      degree: degree.get(n.id) ?? 0,
      folderId: n.folder_id,
    })),
    edges,
  }
  return c.json(body)
})


searchRoutes.post('/search/reindex', requireAuth, async (c) => {
  const { ftsEnabled } = c.get('database')
  if (!ftsEnabled) throw new ApiError(503, 'internal', 'Full-text indexing is unavailable in this environment; search is using its fallback')
  const count = await rebuildFtsIndex(c.env.DB, c.get('userId'))
  return c.json({ ok: true, indexed: count })
})
