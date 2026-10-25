/**
 * The export entry's Host half ([ADR-0024](../../.agents/adrs/0024-export-zip-reuse.md) D4 /
 * 「入口归属」, roadmap X-20) — and deliberately nothing more than a **thin forwarder**.
 *
 * WHY THIS FILE IS SHORT. The engine already decided everything an export *is*: which chapters a
 * selection keeps, how EPUB/DOCX/Markdown/TXT are built, that the artifact lands in
 * `dataDir/exports` and never in the book, that a refusal writes no file. That lives in
 * `export.ts` as `exportBook()`, and the tool `inkflow_export` calls it. This file is about the
 * *entry*, so the GUI must call the SAME function: a second implementation would answer
 * slightly different questions ("the panel's EPUB has no toc entry") and nobody would notice
 * for a release. This module therefore owns exactly two things:
 *
 *   1. the anchor — the panel is root-scoped and has no session (ADR-0010 D3), so a book is
 *      named the way `/hub/books` listed it. `registeredBook()`/`usableBook()` are reused from
 *      `shared-channel.ts` on purpose: the anchor rule and the four-state gate have ONE
 *      home, and a hub write into a directory the user has not opened is not expressible;
 *   2. the two channel replies — the read preview (`GET /hub/export/options`) and the export
 *      itself (`POST /hub/export`), each mapped to a status code the page can act on.
 *
 * NO `confirm: true`, on purpose — and the judgement is ADR-0024's, not this file's: a write
 * needs a confirmation when it can **overwrite or delete** something, not when it merely
 * writes. A stamped name (`<slug>-<kind>-<stamp>.<ext>`, `-2` within the same second) can
 * never overwrite, nothing is cleaned up, and a failed export can be retried at no cost. The
 * same rule already kept `inkflow_export` confirm-free.
 *
 * WHAT THIS FILE DOES NOT DO: no second exporter, no format or target vocabulary of its own
 * (`EXPORT_FORMATS` / `EXPORT_TARGETS` are exported from `export.ts` and re-served as-is), no
 * rebuild of the catalog (`readCatalog()` projects the `.md` files, which is how the preview
 * lists volumes without trusting a stale `chapters/index.json`), and no path accepted from the
 * caller — `root`/`path`/`cwd` are refused by the channel before this module runs.
 */

import type { HostContext } from './context.js'
import { readCatalog } from './catalog.js'
import { CHAPTER_STATUSES } from './conventions.js'
import { EXPORT_FORMATS, EXPORT_TARGETS, exportBook, exportsDir } from './export.js'
import { registeredBook, usableBook } from './shared-channel.js'
import type { SharedChannelReply } from './shared-channel.js'

/**
 * Body fields `POST /hub/export` accepts; anything else is 400 `UNEXPECTED_BODY_FIELD`.
 *
 * Exactly `inkflow_export`'s arguments minus `projectRoot` (the anchor replaces it) and minus
 * `confirm` (ADR-0024: an export cannot overwrite). `tests/hub-export.test.js` asserts a
 * `confirm` body field is refused, so the absence above cannot drift back into the route.
 */
export const HUB_EXPORT_BODY_FIELDS = ['book', 'format', 'target', 'volumeId', 'status'] as const

type JsonRecord = Record<string, unknown>

function ok(value: JsonRecord): SharedChannelReply {
  return { status: 200, body: { ok: true, value } }
}

/** One volume the preview offers: the stable id, its display title and its chapter count. */
export interface ExportVolumeOption {
  volumeId: string
  title: string
  chapters: number
}

/**
 * `GET /hub/export/options?book=…` — what this book CAN be exported as.
 *
 * Read-only: it projects the catalog and returns the three vocabularies the page needs so it
 * never hard-codes a second list of formats, targets or statuses. `exportsDir` is where the
 * artifact will land, which is the sentence the page prints after a successful export (the
 * panel cannot open a folder — the client half has no filesystem write access).
 */
export function hubExportOptions(ctx: HostContext, dataDir: string, book: unknown): SharedChannelReply {
  const anchor = registeredBook(ctx, book)
  if (!anchor.ok) return anchor.reply
  const unusable = usableBook(anchor.root)
  if (unusable !== undefined) return unusable

  const catalog = readCatalog(anchor.root)
  const volumes: ExportVolumeOption[] = catalog.catalog.volumes.map((volume, index) => ({
    volumeId: volume.volumeId,
    title: volume.title,
    chapters: catalog.volumeCatalogs[index]?.chapters.length ?? 0,
  }))
  return ok({
    volumes,
    formats: [...EXPORT_FORMATS],
    targets: [...EXPORT_TARGETS],
    statuses: [...CHAPTER_STATUSES],
    exportsDir: exportsDir(dataDir),
  })
}

/**
 * Status codes for `exportBook()`'s refusals.
 *
 * The split is "who has to change something": a request the page composed wrongly is a 400
 * (bad format, mixed axes, a volume id that is not in the list), while a book or an
 * environment that refuses is a 409 (`EXPORT_EMPTY` — nothing to export is a state, not a
 * typo; a read-back failure or a full disk equally so). The page renders the code's sentence
 * either way; the status is for the developer reading a log.
 */
function statusOf(code: string): number {
  switch (code) {
    case 'EXPORT_FORMAT_INVALID':
    case 'EXPORT_TARGET_INVALID':
    case 'EXPORT_VOLUME_REQUIRED':
    case 'EXPORT_VOLUME_UNKNOWN':
    case 'EXPORT_STATUS_REQUIRED':
    case 'EXPORT_STATUS_INVALID':
    case 'EXPORT_SELECTION_UNUSED':
      return 400
    default:
      return 409
  }
}

/**
 * `POST /hub/export` — export once, through `exportBook()`.
 *
 * The request is passed through as it arrived and `exportBook()` validates it: one place
 * decides what "markdown" means and what a mixed selection is refused with, so the panel and
 * the tool cannot disagree. `tests/hub-export.test.js` pins that by comparing the two paths'
 * artifacts (byte for byte for Markdown, entry for entry for EPUB).
 */
export function hubExportReply(ctx: HostContext, dataDir: string, body: JsonRecord): SharedChannelReply {
  const anchor = registeredBook(ctx, body['book'])
  if (!anchor.ok) return anchor.reply
  const unusable = usableBook(anchor.root)
  if (unusable !== undefined) return unusable

  const result = exportBook(anchor.root, dataDir, {
    format: body['format'],
    target: body['target'],
    volumeId: body['volumeId'],
    status: body['status'],
  })
  if (!result.ok) {
    const { code, message, hint } = result.error
    return {
      status: statusOf(code),
      body: {
        ok: false,
        error: {
          code,
          message,
          ...(hint === undefined ? {} : { hint }),
          ...(result.error.available === undefined ? {} : { available: result.error.available }),
          ...(result.error.path === undefined ? {} : { path: result.error.path }),
        },
      },
    }
  }
  return ok(result.value as unknown as JsonRecord)
}
