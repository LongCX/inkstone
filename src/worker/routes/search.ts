import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import { segmentCJK, toPlainText, wikiNoteTarget } from '@shared/markdown-utils'
import { sliceText, truncateText } from '@shared/text-utils'
import type { GraphResponse, SearchHit, SearchResponse } from '@shared/types'
import type { AppBindings } from '../env'
import { drainFtsQueue, hasPendingFtsWork, rebuildFtsIndex } from '../db/fts'
import { NOTE_COLUMNS, toNoteSummary, type NoteRow } from '../db/rows'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { acquireLease } from '../lib/lease'
import { scheduleFtsDrain } from '../lib/notify'
import { clampInt } from '../lib/request'
import { consumeAttemptBudget, ThrottleError } from '../lib/throttle'
import { requireAuth } from '../middleware/auth'

export const searchRoutes = new Hono<AppBindings>()

const GRAPH_EDGE_CANDIDATE_LIMIT = 10_000


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
          WHERE nt.note_id = n.id AND t.user_id = n.user_id
            AND t.name = ?${binds.length} COLLATE NOCASE)`,
    )
  }
  if (q.folder) {
    binds.push(q.folder)
    append(
      ` AND EXISTS (SELECT 1 FROM folders f WHERE f.id = n.folder_id
          AND f.name = ?${binds.length} COLLATE NOCASE AND f.user_id = n.user_id)`,
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
  const mode = c.req.query('mode') === 'local' ? 'local' : 'global'
  const rawCenter = (c.req.query('center') ?? '').trim()
  const centerId = rawCenter && isValidId(rawCenter) ? rawCenter : null
  const depth = clampInt(c.req.query('depth'), 1, 3, 1)
  const limit = clampInt(c.req.query('limit'), 50, 600, 350)
  const query = (c.req.query('q') ?? '').trim()
  const rawFolderId = (c.req.query('folderId') ?? '').trim()
  const folderId = rawFolderId && isValidId(rawFolderId) ? rawFolderId : ''
  const tag = (c.req.query('tag') ?? '').trim()
  const includeOrphans = c.req.query('includeOrphans') !== '0'
  const includeUnresolved = c.req.query('includeUnresolved') === '1'

  if (rawCenter && !centerId) {
    throw new ApiError(400, 'bad_request', 'The center note id is not a valid note id')
  }
  if (rawFolderId && !folderId) {
    throw new ApiError(400, 'bad_request', 'The folder id is not a valid folder id')
  }
  if (query.length > 200) {
    throw new ApiError(400, 'bad_request', 'The graph search query cannot exceed 200 characters')
  }
  if (tag.length > LIMITS.tagNameMaxLength) {
    throw new ApiError(400, 'bad_request', `The graph tag cannot exceed ${LIMITS.tagNameMaxLength} characters`)
  }
  if (mode === 'local' && !centerId) {
    throw new ApiError(400, 'bad_request', 'A center note is required for the local graph')
  }

  const filters: string[] = ['n.user_id = ?', 'n.deleted_at IS NULL', 'n.is_archived = 0']
  const filterBinds: unknown[] = [userId]
  if (query) {
    filters.push(`n.title LIKE ? ESCAPE '\\' COLLATE NOCASE`)
    filterBinds.push(`%${escapeLike(query)}%`)
  }
  if (folderId) {
    filters.push('n.folder_id = ?')
    filterBinds.push(folderId)
  }
  if (tag) {
    filters.push(`EXISTS (
      SELECT 1 FROM note_tags nt_filter
      JOIN tags t_filter ON t_filter.id = nt_filter.tag_id AND t_filter.user_id = n.user_id
      WHERE nt_filter.note_id = n.id AND t_filter.name = ? COLLATE NOCASE
    )`)
    filterBinds.push(tag)
  }
  if (!includeOrphans) {
    filters.push(`EXISTS (
      SELECT 1 FROM links connected
      WHERE connected.user_id = n.user_id AND connected.target_note_id IS NOT NULL
        AND (connected.source_note_id = n.id OR connected.target_note_id = n.id)
    )`)
  }

  type GraphRow = {
    id: string
    title: string
    folder_id: string | null
    folder_name: string | null
    folder_color: string | null
    degree: number
    in_degree: number
    out_degree: number
  }
  const degreeSelect = `
    (SELECT COUNT(*) FROM links ld WHERE ld.user_id = ? AND ld.target_note_id IS NOT NULL
      AND (ld.source_note_id = n.id OR ld.target_note_id = n.id)) AS degree,
    (SELECT COUNT(*) FROM links li WHERE li.user_id = ? AND li.target_note_id = n.id) AS in_degree,
    (SELECT COUNT(*) FROM links lo WHERE lo.user_id = ? AND lo.source_note_id = n.id
      AND lo.target_note_id IS NOT NULL) AS out_degree`

  let rows: GraphRow[]
  let totalNodes = 0
  if (mode === 'local') {
    const neighborhood = `WITH RECURSIVE neighborhood(id, depth) AS (
      SELECT ? AS id, 0 AS depth
      UNION
      SELECT CASE WHEN l.source_note_id = neighborhood.id THEN l.target_note_id ELSE l.source_note_id END,
        neighborhood.depth + 1
      FROM neighborhood
      JOIN links l ON l.user_id = ? AND l.target_note_id IS NOT NULL
        AND (l.source_note_id = neighborhood.id OR l.target_note_id = neighborhood.id)
      JOIN notes adjacent ON adjacent.id = CASE
        WHEN l.source_note_id = neighborhood.id THEN l.target_note_id ELSE l.source_note_id END
        AND adjacent.user_id = l.user_id AND adjacent.deleted_at IS NULL AND adjacent.is_archived = 0
      WHERE neighborhood.depth < ?
    ), nearby AS (SELECT id, MIN(depth) AS depth FROM neighborhood GROUP BY id)`
    const prefixBinds = [centerId, userId, depth]
    const result = await c.env.DB.prepare(
      `${neighborhood}
       SELECT n.id, n.title, n.folder_id, f.name AS folder_name, f.color AS folder_color,
         ${degreeSelect}, nearby.depth
       FROM nearby JOIN notes n ON n.id = nearby.id
       LEFT JOIN folders f ON f.id = n.folder_id AND f.user_id = n.user_id
       WHERE ${filters.join(' AND ')}
       ORDER BY nearby.depth ASC, degree DESC, n.updated_at DESC, n.id ASC LIMIT ?`,
    ).bind(...prefixBinds, userId, userId, userId, ...filterBinds, limit + 1).all<GraphRow>()
    rows = result.results
    const count = await c.env.DB.prepare(
      `${neighborhood} SELECT COUNT(*) AS count FROM nearby JOIN notes n ON n.id = nearby.id
       WHERE ${filters.join(' AND ')}`,
    ).bind(...prefixBinds, ...filterBinds).first<{ count: number }>()
    totalNodes = Number(count?.count ?? rows.length)
  } else {
    const result = await c.env.DB.prepare(
      `SELECT n.id, n.title, n.folder_id, f.name AS folder_name, f.color AS folder_color,
         ${degreeSelect}
       FROM notes n LEFT JOIN folders f ON f.id = n.folder_id AND f.user_id = n.user_id
       WHERE ${filters.join(' AND ')}
       ORDER BY degree DESC, n.updated_at DESC, n.id ASC LIMIT ?`,
    ).bind(userId, userId, userId, ...filterBinds, limit + 1).all<GraphRow>()
    rows = result.results
    const count = await c.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM notes n WHERE ${filters.join(' AND ')}`,
    ).bind(...filterBinds).first<{ count: number }>()
    totalNodes = Number(count?.count ?? rows.length)
  }

  const noteLimit = includeUnresolved ? Math.max(1, limit - 50) : limit
  let truncated = rows.length > noteLimit || totalNodes > noteLimit
  rows = rows.slice(0, noteLimit)
  const known = new Set(rows.map((row) => row.id))
  const ids = [...known]
  const edges: GraphResponse['edges'] = []
  const unresolved = new Map<string, { title: string; sources: Set<string> }>()
  const tagsByNote = new Map<string, Array<{ name: string; color: string | null }>>()
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',')
    const [linkResult, tagResult] = await Promise.all([
      c.env.DB.prepare(
        `SELECT source_note_id, target_note_id, target_key, target_title FROM links
         WHERE user_id = ? AND source_note_id IN (${placeholders})
           AND (target_note_id IN (${placeholders})${includeUnresolved ? ' OR target_note_id IS NULL' : ''})
         ORDER BY source_note_id ASC, target_key ASC LIMIT ?`,
      ).bind(userId, ...ids, ...ids, GRAPH_EDGE_CANDIDATE_LIMIT + 1).all<{
        source_note_id: string
        target_note_id: string | null
        target_key: string
        target_title: string
      }>(),
      c.env.DB.prepare(
        `SELECT nt.note_id, t.name, t.color FROM note_tags nt
         JOIN tags t ON t.id = nt.tag_id AND t.user_id = ?
         WHERE nt.note_id IN (${placeholders}) ORDER BY t.name COLLATE NOCASE ASC`,
      ).bind(userId, ...ids).all<{ note_id: string; name: string; color: string | null }>(),
    ])
    if (linkResult.results.length > GRAPH_EDGE_CANDIDATE_LIMIT) truncated = true
    const seen = new Set<string>()
    for (const link of linkResult.results.slice(0, GRAPH_EDGE_CANDIDATE_LIMIT)) {
      if (link.target_note_id === null) {
        if (!includeUnresolved || unresolved.size >= 50 && !unresolved.has(link.target_key)) continue
        const current = unresolved.get(link.target_key) ?? {
          title: wikiNoteTarget(link.target_title),
          sources: new Set<string>(),
        }
        current.sources.add(link.source_note_id)
        unresolved.set(link.target_key, current)
        continue
      }
      if (link.source_note_id === link.target_note_id) continue
      const key = `${link.source_note_id}>${link.target_note_id}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ source: link.source_note_id, target: link.target_note_id })
    }
    for (const item of tagResult.results) {
      const values = tagsByNote.get(item.note_id) ?? []
      values.push({ name: item.name, color: item.color })
      tagsByNote.set(item.note_id, values)
    }
  }

  const nodes: GraphResponse['nodes'] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    kind: 'note',
    degree: Number(row.degree),
    inDegree: Number(row.in_degree),
    outDegree: Number(row.out_degree),
    folderId: row.folder_id,
    folderName: row.folder_name,
    folderColor: row.folder_color,
    tags: tagsByNote.get(row.id) ?? [],
  }))
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  for (const [key, missing] of unresolved) {
    const id = `unresolved:${key}`
    nodes.push({
      id,
      title: missing.title,
      kind: 'unresolved',
      degree: missing.sources.size,
      inDegree: missing.sources.size,
      outDegree: 0,
      folderId: null,
      folderName: null,
      folderColor: null,
      tags: [],
    })
    for (const source of missing.sources) {
      edges.push({ source, target: id })
      const sourceNode = nodeById.get(source)
      if (sourceNode) {
        sourceNode.degree++
        sourceNode.outDegree++
      }
    }
  }
  if (unresolved.size >= 50) truncated = true

  const body: GraphResponse = {
    nodes,
    edges,
    meta: {
      mode,
      centerId: mode === 'local' ? centerId : null,
      depth,
      totalNodes: totalNodes + unresolved.size,
      totalEdges: edges.length,
      truncated,
      limit,
    },
  }
  return c.json(body)
})


searchRoutes.post('/search/reindex', requireAuth, async (c) => {
  const { ftsEnabled } = c.get('database')
  if (!ftsEnabled) throw new ApiError(503, 'internal', 'Full-text indexing is unavailable in this environment; search is using its fallback')
  const userId = c.get('userId')
  const release = await acquireLease(
    c.env.DB,
    `fts-reindex-run:${userId}`,
    15 * 60 * 1000,
    'Search indexing is already running',
  )
  try {
    try {
      await consumeAttemptBudget(c.env.DB, [{
        key: `fts-reindex:${userId}`,
        maxAttempts: 6,
        windowMs: 60 * 60 * 1000,
        lockMs: 60 * 60 * 1000,
      }])
    } catch (error) {
      if (error instanceof ThrottleError) {
        throw new ApiError(
          429,
          'too_many_attempts',
          `Too many search reindex requests. Try again in ${error.retryAfterSec} seconds`,
          { retryAfter: error.retryAfterSec },
        )
      }
      throw error
    }
    const count = await rebuildFtsIndex(c.env.DB, userId)
    return c.json({ ok: true, indexed: count })
  } finally {
    await release()
  }
})
