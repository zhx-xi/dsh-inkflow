/**
 * OpenViking as a semantic *backend* — connection, peer, blocks, and the one HTTP path
 * (#41, ADR-0009 P1–P3/P5, ADR-0020 E1–E3/E6).
 *
 * WHAT THIS MODULE IS NOT. It is not a retrieval engine and it is not a second index.
 * OVK owns vectorisation and ranking (ADR-0009 P1); InkFlow owns *which book's which
 * text* goes in, *how* it is written, and *where a hit lands in the manuscript* (P7).
 * Everything here is either a fact about that boundary (peer, URI, chunk) or the
 * transport to it.
 *
 * WHY PLAIN `fetch`. Node 24 ships it, the whole plugin keeps `dependencies` empty, and
 * OVK's data plane is HTTP (`/health`, `/api/v1/...`). The request constructor is
 * deliberately boring: one timeout, two headers, JSON in, JSON out.
 *
 * TWO BOUNDARIES THIS FILE OWNS, both of them silent-failure classes if done casually:
 *
 *   * **The peer is read, never derived** (ADR-0009 P2, X-21). `.openviking/config.local.json`
 *     wins over `.openviking/config.json`; `version` must be `1` (OVK itself drops a layer
 *     whose version differs, so a "helpful" guess here would disagree with what OVK does
 *     with the same file); the id must be ASCII because OVK's server-side `sanitizePeerId`
 *     strips non-ASCII to an empty string and the author would see "no peer" with no cause.
 *     Nothing is ever written back: those files belong to OVK.
 *   * **Writes land in the resource tree, not in a peer subtree** (ADR-0020 E3). OVK's
 *     write surface documents `skills/`, `peers/`, `privacy/` and `sessions/` as read-only
 *     (`openviking/server/mcp_endpoint.py`, 0.4.21), so a block written under
 *     `<user>/peers/<peer>/resources/` is refused — which would make semantic retrieval
 *     permanently unavailable on a stock install. Book isolation therefore comes from the
 *     URI prefix (`resources/inkflow/<projectId>/`), and the peer still travels on every
 *     request so the server's actor-peer view applies.
 *
 * NO `forget` HERE. Physical deletion lives in the purge path only (ADR-0009 P6); this
 * file exposes it as `ovkForget` and nothing on a writing or deleting path may call it.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { InkflowSettings } from './settings.js'

// ---------------------------------------------------------------------------
// Wire constants — the OVK HTTP surface this plugin depends on
// ---------------------------------------------------------------------------

/** Liveness. Cheap, unauthenticated in a stock install, and the first thing to probe. */
export const OVK_HEALTH_PATH = '/health'
/** Semantic recall without session context (`FindRequest` in `server/routers/search.py`). */
export const OVK_SEARCH_PATH = '/api/v1/search/find'
/** Write/overwrite one text file (`WriteContentRequest`). */
export const OVK_WRITE_PATH = '/api/v1/content/write'
/** `DELETE /api/v1/fs?uri=…` — the physical delete used ONLY by the purge action. */
export const OVK_FS_PATH = '/api/v1/fs'
/** Account-level resource tree: the only scope `write` documents as writable. */
export const OVK_RESOURCES_ROOT = 'viking://resources'
/** Sub-tree that holds every InkFlow block, so a book is one prefix. */
export const OVK_BLOCK_ROOT = 'inkflow'
/** Blocks are `chapters/<chapterId>/<index>.md` under the project prefix. */
export const OVK_CHAPTERS_SEGMENT = 'chapters'

/**
 * Characters per block and the overlap carried into the next one.
 *
 * 【推断】ADR-0009 Q1 未裁决具体数值，这里取 ADR-0009 P10 的量级参考（800 字/块、
 * 100 字重叠 → 有效步长 700 字）。理由与代价：块越大，摘要越省调用但定位越粗；
 * 重叠是为了让「跨段的一句话」在两块里都出现，代价是重复的体积（约 12%）。
 * 改这两个数不改协议：URI 只由 `projectId + chapterId + blockIndex` 决定。
 */
export const OVK_BLOCK_CHARS = 800
export const OVK_BLOCK_OVERLAP = 100

/** Per-request timeout. A read the author is waiting on must fail fast, not hang. */
export const OVK_TIMEOUT_MS = 5_000

/** First-build thresholds above which `confirm: true` is required (ADR-0009 P10/Q3). */
export const OVK_FIRST_BUILD_CHAPTERS = 200
export const OVK_FIRST_BUILD_BYTES = 5 * 1024 * 1024

/** OVK's own workspace-config constraints (ADR-0009 P2): both are its rules, not ours. */
export const OVK_CONFIG_DIR = '.openviking'
export const OVK_TEAM_CONFIG_FILE = 'config.json'
export const OVK_LOCAL_CONFIG_FILE = 'config.local.json'
export const OVK_CONFIG_MAX_BYTES = 64 * 1024
export const OVK_CONFIG_VERSION = 1

/** What the OVK server accepts as a peer id (its `sanitizePeerId`, expressed as a test). */
export const PEER_ID_PATTERN = /^[A-Za-z0-9_.@-]{1,100}$/

// ---------------------------------------------------------------------------
// Peer resolution (ADR-0009 P2)
// ---------------------------------------------------------------------------

/** Why a config layer produced no peer. Every case is reported, none is "repaired". */
export type PeerProblem =
  | 'no-config'
  | 'unreadable'
  | 'too-large'
  | 'not-an-object'
  | 'version-mismatch'
  | 'no-peer-id'
  | 'non-ascii'
  | 'source-only'

export interface PeerResolution {
  /** The peer id to send, or absent when the book has none. */
  peer?: string
  /** Which layer supplied it (`config.local.json` wins). */
  source?: 'local' | 'team'
  /** Project-relative path of the layer that was read (for the status surface). */
  configPath?: string
  /** Set when a layer existed but could not supply a peer. */
  problem?: PeerProblem
  /** One sentence the status tool and the degraded reason can quote. */
  detail?: string
}

interface LayerRead {
  peer?: string
  problem?: PeerProblem
  detail?: string
}

/**
 * Read `peer.id` from one layer, applying OVK's own constraints.
 *
 * `peer.source` present without `peer.id` is `source-only`, not "derive it": the template
 * chain is OVK's resolution rule, and a second implementation of it would drift from the
 * server's (ADR-0009 P2 — "不自己实现模板派生").
 */
function readPeerLayer(root: string, file: string): LayerRead {
  const path = join(root, OVK_CONFIG_DIR, file)
  if (!existsSync(path)) return {}
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return { problem: 'unreadable', detail: `${OVK_CONFIG_DIR}/${file} cannot be read` }
  }
  if (size > OVK_CONFIG_MAX_BYTES) {
    return {
      problem: 'too-large',
      detail: `${OVK_CONFIG_DIR}/${file} is ${String(size)} bytes; OVK ignores a layer above ${String(OVK_CONFIG_MAX_BYTES)}`,
    }
  }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { problem: 'unreadable', detail: `${OVK_CONFIG_DIR}/${file} cannot be read` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/u, ''))
  } catch {
    return { problem: 'unreadable', detail: `${OVK_CONFIG_DIR}/${file} is not valid JSON` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { problem: 'not-an-object', detail: `${OVK_CONFIG_DIR}/${file} does not hold a JSON object` }
  }
  const record = parsed as Record<string, unknown>
  // OVK drops the WHOLE layer when `version` is not 1 (workspace-config.mjs), so the
  // honest answer here is "this layer has no peer" — not "look harder and repair it".
  if (record['version'] !== OVK_CONFIG_VERSION) {
    return {
      problem: 'version-mismatch',
      detail: `${OVK_CONFIG_DIR}/${file} has version ${JSON.stringify(record['version'] ?? null)}; OVK only honours version ${String(OVK_CONFIG_VERSION)}`,
    }
  }
  const peerBlock = record['peer']
  const peerRecord =
    typeof peerBlock === 'object' && peerBlock !== null && !Array.isArray(peerBlock)
      ? (peerBlock as Record<string, unknown>)
      : undefined
  const rawId = peerRecord?.['id']
  if (typeof rawId === 'string' && rawId.trim() !== '') {
    const id = rawId.trim()
    if (!PEER_ID_PATTERN.test(id)) {
      // Non-ASCII is the dangerous case: OVK's sanitizer would silently strip it to "",
      // so the author would load a book into a namespace called "" and never know.
      return {
        problem: 'non-ascii',
        detail: `peer.id "${id}" is not ASCII [A-Za-z0-9_.@-] (max 100); OVK would strip it to an empty id, so write an ASCII id`,
      }
    }
    return { peer: id }
  }
  if (peerRecord !== undefined && Object.prototype.hasOwnProperty.call(peerRecord, 'source')) {
    return {
      problem: 'source-only',
      detail: `peer.source is set but peer.id is not; OVK's template chain is not re-implemented here — write peer.id explicitly`,
    }
  }
  return { problem: 'no-peer-id', detail: `${OVK_CONFIG_DIR}/${file} has no peer.id` }
}

/**
 * Resolve the peer for a book (ADR-0009 P2, X-21).
 *
 * Local wins, and a *present but unusable* local layer does not fall through to the team
 * layer: that is what OVK does with the same two files (each layer is validated on its
 * own, an unusable one contributes nothing), and silently preferring the team peer would
 * make two machines that share a repository disagree about the namespace.
 */
export function resolveOvkPeer(root: string): PeerResolution {
  const local = readPeerLayer(root, OVK_LOCAL_CONFIG_FILE)
  const localPath = `${OVK_CONFIG_DIR}/${OVK_LOCAL_CONFIG_FILE}`
  const hasLocal = existsSync(join(root, OVK_CONFIG_DIR, OVK_LOCAL_CONFIG_FILE))
  if (hasLocal) {
    if (local.peer !== undefined) return { peer: local.peer, source: 'local', configPath: localPath }
    return {
      configPath: localPath,
      problem: local.problem ?? 'no-peer-id',
      detail: local.detail ?? `${localPath} has no peer.id`,
    }
  }
  const teamPath = `${OVK_CONFIG_DIR}/${OVK_TEAM_CONFIG_FILE}`
  const hasTeam = existsSync(join(root, OVK_CONFIG_DIR, OVK_TEAM_CONFIG_FILE))
  if (!hasTeam) {
    return {
      configPath: localPath,
      problem: 'no-config',
      detail: `no ${localPath} (or ${teamPath}); semantic search needs peer.id and this plugin never invents one`,
    }
  }
  const team = readPeerLayer(root, OVK_TEAM_CONFIG_FILE)
  if (team.peer !== undefined) return { peer: team.peer, source: 'team', configPath: teamPath }
  return { configPath: teamPath, problem: team.problem ?? 'no-peer-id', detail: team.detail ?? `${teamPath} has no peer.id` }
}

// ---------------------------------------------------------------------------
// Connection from settings (ADR-0020 E1)
// ---------------------------------------------------------------------------

export interface OvkConnection {
  /** `scheme://host:port` with no trailing slash. */
  endpoint: string
  /** Optional bearer token; never rendered back anywhere. */
  apiKey?: string
}

/**
 * Why the semantic backend is not answering. Fixed vocabulary (ADR-0020 E5) because the
 * panel turns each value into one concrete next step.
 */
export type OvkDegradedReason = 'disabled' | 'no-endpoint' | 'no-peer' | 'unreachable' | 'unauthorized' | 'timeout'

export const OVK_DEGRADED_REASONS: readonly OvkDegradedReason[] = [
  'disabled',
  'no-endpoint',
  'no-peer',
  'unreachable',
  'unauthorized',
  'timeout',
]

export type ConnectionResult =
  | { ok: true; connection: OvkConnection }
  | { ok: false; reason: 'disabled' | 'no-endpoint'; detail: string }

/** The endpoint/key pair the settings state, or the reason there is none. */
export function connectionOf(settings: InkflowSettings): ConnectionResult {
  if (settings.semanticSearch !== true) {
    return { ok: false, reason: 'disabled', detail: 'semanticSearch is off in settings.json, so keyword (FTS5) search is used' }
  }
  const endpoint = settings.semanticEndpoint
  if (endpoint === undefined) {
    return {
      ok: false,
      reason: 'no-endpoint',
      detail: 'semanticSearch is on but semanticEndpoint is empty; set the OpenViking URL (e.g. http://127.0.0.1:1933)',
    }
  }
  const connection: OvkConnection = { endpoint }
  if (settings.semanticApiKey !== undefined) connection.apiKey = settings.semanticApiKey
  return { ok: true, connection }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Transport-level failures. `http`/`malformed` never reach the panel as a reason. */
export type OvkFailureReason = 'unreachable' | 'unauthorized' | 'timeout' | 'http' | 'malformed'

export interface OvkFailure {
  reason: OvkFailureReason
  /** HTTP status, or 0 when the request never got an answer. */
  status: number
  detail: string
}

export type OvkResult<T> = { ok: true; value: T } | { ok: false; failure: OvkFailure }

/**
 * Headers every request carries (ADR-0009 P3: the peer is explicit, never implied by the
 * process's boot directory — OVK's MCP data plane resolves the actor peer per process).
 */
export function ovkHeaders(connection: OvkConnection, peer: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-OpenViking-Actor-Peer': peer,
  }
  if (connection.apiKey !== undefined) headers['Authorization'] = `Bearer ${connection.apiKey}`
  return headers
}

/**
 * One request, answered as data in every case.
 *
 * Never throws: a refused connection, an abort and a non-JSON document are all values
 * (the same discipline `search.ts` follows — a cache lookup must not surface a stack).
 * A 2xx that is not JSON is `malformed`, because a captive portal or a proxy login page
 * answering 200 would otherwise read as "connected with zero results".
 */
export async function ovkRequest(
  connection: OvkConnection,
  peer: string,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<OvkResult<Record<string, unknown>>> {
  const timeoutMs = init.timeoutMs === undefined ? OVK_TIMEOUT_MS : Math.max(50, Math.trunc(init.timeoutMs))
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    const response = await fetch(`${connection.endpoint}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: ovkHeaders(connection, peer),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    })
    const text = await response.text()
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        failure: { reason: 'unauthorized', status: response.status, detail: `OpenViking refused the credentials (HTTP ${String(response.status)})` },
      }
    }
    let parsed: unknown
    try {
      parsed = text === '' ? {} : JSON.parse(text)
    } catch {
      return {
        ok: false,
        failure: {
          reason: 'malformed',
          status: response.status,
          detail: `OpenViking answered ${String(response.status)} with a non-JSON body (${text.slice(0, 80)})`,
        },
      }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, failure: { reason: 'malformed', status: response.status, detail: 'OpenViking answered JSON that is not an object' } }
    }
    const body = parsed as Record<string, unknown>
    if (!response.ok || body['status'] === 'error') {
      return {
        ok: false,
        failure: {
          reason: 'http',
          status: response.status,
          detail: `OpenViking answered HTTP ${String(response.status)}${describeError(body)}`,
        },
      }
    }
    return { ok: true, value: body }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    if (timedOut) {
      return { ok: false, failure: { reason: 'timeout', status: 0, detail: `no answer within ${String(timeoutMs)} ms` } }
    }
    return { ok: false, failure: { reason: 'unreachable', status: 0, detail } }
  } finally {
    clearTimeout(timer)
  }
}

function describeError(body: Record<string, unknown>): string {
  const error = body['error']
  if (typeof error === 'string') return ` — ${error}`
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>)['message']
    if (typeof message === 'string') return ` — ${message}`
  }
  return ''
}

/** `GET /health`: the cheapest probe that separates "up" from "not listening". */
export async function ovkHealth(
  connection: OvkConnection,
  peer: string,
  options: { timeoutMs?: number } = {},
): Promise<OvkResult<true>> {
  const answer = await ovkRequest(connection, peer, OVK_HEALTH_PATH, { ...options })
  return answer.ok ? { ok: true, value: true } : answer
}

// ---------------------------------------------------------------------------
// Recall (ADR-0009 P7: OVK finds, the book locates)
// ---------------------------------------------------------------------------

/** One file-level hit, exactly as OVK reports it: a uri plus a *summary*. */
export interface OvkHit {
  uri: string
  score: number
  /** OVK's own summary of the file — a pointer, never quoted as prose (P7). */
  abstract: string
}

/**
 * Read a `FindResult` document into hits.
 *
 * The response buckets by context kind (`memories` / `resources` / `skills`, and more in
 * newer servers), so this walks every array-valued key whose entries carry a `uri`
 * instead of hard-coding three names: an OVK upgrade that adds a bucket then costs a
 * missed bucket at worst, not a silently empty answer.
 */
export function hitsOf(document: Record<string, unknown>): OvkHit[] {
  const result = document['result']
  const root =
    typeof result === 'object' && result !== null && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : document
  const hits: OvkHit[] = []
  for (const value of Object.values(root)) {
    if (!Array.isArray(value)) continue
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null) continue
      const item = entry as Record<string, unknown>
      const uri = item['uri']
      if (typeof uri !== 'string' || uri === '') continue
      const rawScore = item['score']
      const abstract = item['abstract']
      hits.push({
        uri,
        score: typeof rawScore === 'number' && Number.isFinite(rawScore) ? rawScore : 0,
        abstract: typeof abstract === 'string' ? abstract : '',
      })
    }
  }
  // Higher is better, which is the convention X-16 fixed for `score` (see `search.ts`).
  hits.sort((left, right) => right.score - left.score)
  return hits
}

/** `POST /api/v1/search/find` scoped to one book's subtree. */
export async function ovkFind(
  connection: OvkConnection,
  peer: string,
  input: { query: string; targetUri: string; limit: number; timeoutMs?: number },
): Promise<OvkResult<OvkHit[]>> {
  const answer = await ovkRequest(connection, peer, OVK_SEARCH_PATH, {
    method: 'POST',
    body: { query: input.query, target_uri: input.targetUri, limit: input.limit, score_threshold: 0 },
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  })
  return answer.ok ? { ok: true, value: hitsOf(answer.value) } : answer
}

// ---------------------------------------------------------------------------
// Writes: same-path overwrite, no `forget` (ADR-0009 P5/P6)
// ---------------------------------------------------------------------------

/** `POST /api/v1/content/write` in `replace` mode — the idempotent write. */
export async function ovkWriteBlock(
  connection: OvkConnection,
  peer: string,
  input: { uri: string; content: string; tags: readonly string[]; timeoutMs?: number },
): Promise<OvkResult<true>> {
  const answer = await ovkRequest(connection, peer, OVK_WRITE_PATH, {
    method: 'POST',
    body: { uri: input.uri, content: input.content, mode: 'replace', wait: false, tags: [...input.tags], tag_mode: 'replace' },
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  })
  return answer.ok ? { ok: true, value: true } : answer
}

/**
 * Physical deletion. **Only the purge action may call this** (ADR-0009 P6).
 *
 * A 404 is success: the block is already gone, and "delete the thing that is not there"
 * must not stop a purge halfway.
 */
export async function ovkForget(
  connection: OvkConnection,
  peer: string,
  input: { uri: string; timeoutMs?: number },
): Promise<OvkResult<'deleted' | 'absent'>> {
  const answer = await ovkRequest(connection, peer, `${OVK_FS_PATH}?uri=${encodeURIComponent(input.uri)}`, {
    method: 'DELETE',
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  })
  if (answer.ok) return { ok: true, value: 'deleted' }
  if (answer.failure.reason === 'http' && answer.failure.status === 404) return { ok: true, value: 'absent' }
  return answer
}

// ---------------------------------------------------------------------------
// Blocks: URI, hash, chunking (ADR-0009 P5, ADR-0020 E3)
// ---------------------------------------------------------------------------

/**
 * One path segment that OVK's URI parser and this plugin's ledger both accept.
 *
 * Applied to `projectId` only: a project id can arrive from `inkflow.json` (a human
 * edited that file), and a `/` in it would silently move the blocks into a sibling tree.
 */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]/gu, '-').replace(/^-+/u, '')
  return cleaned === '' ? 'book' : cleaned
}

/** `viking://resources/inkflow/<projectId>` — the recall target for one book. */
export function projectSubtreeUri(projectId: string): string {
  return `${OVK_RESOURCES_ROOT}/${OVK_BLOCK_ROOT}/${safeSegment(projectId)}`
}

/** `viking://resources/inkflow/<projectId>/chapters/<chapterId>/<index>.md`. */
export function blockUriOf(projectId: string, chapterId: string, blockIndex: number): string {
  return `${projectSubtreeUri(projectId)}/${OVK_CHAPTERS_SEGMENT}/${safeSegment(chapterId)}/${String(blockIndex)}.md`
}

export interface ParsedBlockUri {
  projectId: string
  chapterId: string
  blockIndex: number
}

/**
 * `uri → {projectId, chapterId, blockIndex}`, or `undefined` for a URI this plugin did
 * not write. The ledger is the primary mapping (P7); this is the fallback that lets a
 * ledger which lost an entry still say *which chapter* a hit came from.
 */
export function parseBlockUri(uri: string): ParsedBlockUri | undefined {
  const prefix = `${OVK_RESOURCES_ROOT}/${OVK_BLOCK_ROOT}/`
  if (!uri.startsWith(prefix)) return undefined
  // `<projectId>/chapters/<chapterId>/<index>.md` — four segments after the plugin prefix.
  const parts = uri.slice(prefix.length).split('/')
  if (parts.length !== 4) return undefined
  const [projectId, segment, chapterId, file] = parts
  if (projectId === undefined || chapterId === undefined || file === undefined) return undefined
  if (segment !== OVK_CHAPTERS_SEGMENT) return undefined
  const match = /^(\d+)\.md$/u.exec(file)
  if (match?.[1] === undefined) return undefined
  return { projectId, chapterId, blockIndex: Number(match[1]) }
}

/** sha256 of the exact text written; the increment check and the tombstone both use it. */
export function contentHashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** One chunk of a chapter, with the character range it covers in the body it came from. */
export interface OvkBlock {
  index: number
  text: string
  /** Inclusive character offset (UTF-16 code units) into the body that was chunked. */
  charStart: number
  /** Exclusive end offset. */
  charEnd: number
}

/**
 * Split a chapter body into blocks of at most `OVK_BLOCK_CHARS`, carrying
 * `OVK_BLOCK_OVERLAP` characters into the next block.
 *
 * Paragraph-aware, not fixed-width: a block boundary inside a sentence produces a
 * summary of half a sentence, and the author's paragraphs are already the author's own
 * idea of where a thought ends. A single paragraph longer than the limit is hard-split
 * (there is no smaller unit left), with the same overlap so a sentence spanning the cut
 * still appears whole in one of the two blocks.
 *
 * Offsets are into the string handed in, which callers obtain from one place (the book's
 * own body reader), so a hit's offset locates text the author can see.
 */
export function chunkBody(body: string, options: { chars?: number; overlap?: number } = {}): OvkBlock[] {
  const limit = Math.max(1, Math.trunc(options.chars ?? OVK_BLOCK_CHARS))
  const overlap = Math.min(limit - 1, Math.max(0, Math.trunc(options.overlap ?? OVK_BLOCK_OVERLAP)))
  const text = body
  if (text.trim() === '') return []

  // Paragraph spans: a run of non-empty content up to a blank line. Keeping offsets
  // means a block never has to be re-located in the body later.
  const spans: Array<{ start: number; end: number }> = []
  let cursor = 0
  for (const raw of text.split(/(\n[ \t]*\n+)/u)) {
    const start = cursor
    cursor += raw.length
    if (/^\n[ \t]*\n+$/u.test(raw)) continue
    if (raw.trim() === '') continue
    spans.push({ start, end: start + raw.length })
  }
  if (spans.length === 0) return []

  const blocks: OvkBlock[] = []
  let first = spans[0]
  if (first === undefined) return []
  let start = first.start
  let end = first.end
  const push = (blockStart: number, blockEnd: number): void => {
    const slice = text.slice(blockStart, blockEnd)
    blocks.push({ index: blocks.length, text: slice, charStart: blockStart, charEnd: blockEnd })
  }

  for (const span of spans.slice(1)) {
    const candidateEnd = span.end
    if (candidateEnd - start <= limit) {
      end = candidateEnd
      continue
    }
    if (end > start) push(start, end)
    start = Math.max(start + 1, end - overlap)
    end = span.end
  }
  if (end > start) push(start, end)

  // A paragraph longer than the limit still has to become blocks: cut at the limit and
  // step by `limit - overlap`, which keeps the "a whole sentence is in one block" promise
  // for everything except a single sentence over the limit.
  const expanded: OvkBlock[] = []
  for (const block of blocks) {
    if (block.charEnd - block.charStart <= limit) {
      expanded.push({ ...block, index: expanded.length })
      continue
    }
    let at = block.charStart
    while (at < block.charEnd) {
      const sliceEnd = Math.min(block.charEnd, at + limit)
      expanded.push({ index: expanded.length, text: text.slice(at, sliceEnd), charStart: at, charEnd: sliceEnd })
      if (sliceEnd >= block.charEnd) break
      at = sliceEnd - overlap
    }
  }
  return expanded
}

/** Metadata carried by every block, in the file's own head and in OVK's tags. */
export interface BlockMetadata {
  projectId: string
  chapterId: string
  blockIndex: number
  contentHash: string
  deleted: boolean
  /** Chapter sequence, when the catalog knows it — makes a raw file readable. */
  seq?: number
  title?: string
}

/** OVK retrieval tags: a stable prefix per fact so a future filter can use them. */
export function blockTagsOf(metadata: BlockMetadata): string[] {
  const tags = [
    `inkflow:plugin=1`,
    `inkflow:project=${metadata.projectId}`,
    `inkflow:chapter=${metadata.chapterId}`,
    `inkflow:block=${String(metadata.blockIndex)}`,
    `inkflow:hash=${metadata.contentHash}`,
  ]
  if (metadata.deleted) tags.push('inkflow:deleted=true')
  if (metadata.seq !== undefined) tags.push(`inkflow:seq=${String(metadata.seq)}`)
  // The title is metadata, not body: keeping it out of the block text is what makes a
  // changed chapter's old text disappear completely (see `blockContentOf`).
  if (metadata.title !== undefined && metadata.title.trim() !== '') tags.push(`inkflow:title=${metadata.title.trim()}`)
  return tags
}

/**
 * What actually gets written for one block: a small head (so a human reading the OVK store
 * knows what this file is and which chapter it belongs to) followed by the prose.
 *
 * The head is ids only — no title, no summary. A title in the body would make every block
 * match a search for a chapter name, and it would make "is this block stale?" a question the
 * content cannot answer (after a rename the old title would look like leftover prose). The
 * title travels in OVK's tags instead, where it is metadata. The prose itself is verbatim.
 */
export function blockContentOf(block: OvkBlock, metadata: BlockMetadata): string {
  return [
    `<!-- inkflow block: project ${metadata.projectId} / chapter ${metadata.chapterId} / #${String(metadata.blockIndex)} -->`,
    '',
    block.text,
  ].join('\n')
}

/**
 * A deleted chapter's block: the prose is gone and the marker says so.
 *
 * Overwriting (rather than `forget`) is the whole point of ADR-0009 P6 — a delete must be
 * recoverable — so this is what "the block still exists but must not be recalled" looks
 * like. The marker is deliberately short: it carries no旧文, so nothing of the deleted
 * chapter can come back through a stale recall.
 */
export function tombstoneContentOf(metadata: BlockMetadata, at: string): string {
  return [
    `<!-- inkflow tombstone: project ${metadata.projectId} / chapter ${metadata.chapterId} / #${String(metadata.blockIndex)} / deleted ${at} -->`,
    '',
    '（该章已删除；本块为占位。清理请用「清理已删除章节的语义条目」。）',
  ].join('\n')
}
