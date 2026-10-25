/**
 * The import's half of the private channel (roadmap X-17): one POST, two actions.
 *
 * Scope: `POST /inkflow/internal/library/import` with `action: 'plan' | 'apply'`. What an
 * import means lives in `import-write.ts`; this module only turns a request into one of
 * those two calls and an HTTP status vocabulary, exactly like `audit-channel.ts` does for
 * the audit.
 *
 * WHY ONE ROUTE FOR BOTH ACTIONS, AND WHY POST FOR THE PREVIEW TOO: the preview has to
 * name a file the author picked, and the channel's own rule is that a browser never names
 * a **directory** (`FORBIDDEN_PATH_PARAMS` keeps `path`/`root`/`cwd`/`workspace`/
 * `projectRoot` out of every request). `sourcePath` is not one of those: it is the
 * manuscript, not the project, and the issue says the Host reads it. Since that field can
 * point outside the book, the preview rides the *write* route's guards — POST only, an
 * `Origin` header that must be present and loopback — so a page that is not this panel
 * cannot use it to read anything, and `confirm: true` is still required before a byte is
 * written. A GET preview would have relaxed those guards for the sake of a verb.
 *
 * The action defaults to `'plan'`: a request that forgot the field previews rather than
 * writes, which is the only failure direction that cannot lose data.
 */

import { applyImport, planImport } from './import-write.js'
import type { ImportError } from './import-write.js'

type JsonRecord = Record<string, unknown>

/** What the channel resolved for this request. */
export interface ImportChannelSource {
  sessionId: string
  root: string
}

export interface ImportChannelRequest {
  source: ImportChannelSource
  version: string
  body: JsonRecord
}

export interface ImportReply {
  status: number
  body: JsonRecord
}

/** HTTP status per refusal code; anything unlisted answers 500 and keeps the domain code. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  CONFIRM_REQUIRED: 400,
  IMPORT_SOURCE_REQUIRED: 400,
  IMPORT_SOURCE_NOT_FILE: 400,
  IMPORT_TYPE_UNSUPPORTED: 400,
  IMPORT_SOURCE_EMPTY: 400,
  IMPORT_SOURCE_UNREADABLE: 400,
  IMPORT_SOURCE_MISSING: 404,
  IMPORT_TOO_LARGE: 413,
  IMPORT_PLAN_STALE: 409,
  VOLUME_ID_INVALID: 400,
  VOLUME_NOT_FOUND: 404,
  IMPORT_CHAPTER_FAILED: 409,
  IMPORT_LIBRARY_FAILED: 409,
  IMPORT_ROLLBACK_FAILED: 500,
  // The gate refusal is a checklist, not a transport failure (ADR-0008 D2, the same
  // treatment `/chapters` and `/library` give it).
  NOT_A_PROJECT: 200,
}

/** The body fields this route may carry (`sessionId` is always allowed). */
export const IMPORT_BODY_FIELDS = ['action', 'sourcePath', 'volumeId', 'keepOriginal', 'confirm', 'planToken'] as const

function refused(status: number, error: ImportError): ImportReply {
  const { code, message, ...extra } = error
  return { status, body: { ok: false, error: { code, message, ...extra } } }
}

function readBoolean(value: unknown, field: string): { ok: true; value: boolean | undefined } | { ok: false; reply: ImportReply } {
  if (value === undefined) return { ok: true, value: undefined }
  if (typeof value !== 'boolean') {
    return {
      ok: false,
      reply: refused(400, {
        code: 'INVALID_FIELD',
        message: `${field} must be a boolean`,
        param: field,
        hint: 'omit it for the default, or send true/false',
      }),
    }
  }
  return { ok: true, value }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * `POST /library/import` — `plan` (read-only) or `apply` (`confirm: true`).
 *
 * Field validation happens here rather than in `import-write.ts` because these are
 * request-shape rules: the domain takes typed options and never parses JSON.
 */
export async function importViaChannel(request: ImportChannelRequest): Promise<ImportReply> {
  const { source, version, body } = request

  const action = readString(body['action'])?.trim() ?? 'plan'
  if (action !== 'plan' && action !== 'apply') {
    return refused(400, {
      code: 'ACTION_INVALID',
      message: `unknown action "${action}"`,
      param: 'action',
      hint: 'send action: "plan" to preview or action: "apply" with confirm: true to write',
    })
  }

  const keepOriginal = readBoolean(body['keepOriginal'], 'keepOriginal')
  if (!keepOriginal.ok) return keepOriginal.reply
  const confirm = readBoolean(body['confirm'], 'confirm')
  if (!confirm.ok) return confirm.reply

  const options = {
    sourcePath: readString(body['sourcePath']) ?? '',
    ...(readString(body['volumeId']) === undefined ? {} : { volumeId: readString(body['volumeId']) ?? '' }),
    ...(keepOriginal.value === undefined ? {} : { keepOriginal: keepOriginal.value }),
  }

  if (action === 'plan') {
    const planned = planImport(source.root, options)
    if (!planned.ok) return refused(STATUS_BY_CODE[planned.error.code] ?? 500, planned.error)
    return {
      status: 200,
      body: {
        ok: true,
        value: {
          pluginVersion: version,
          sessionId: source.sessionId,
          root: source.root,
          action: 'plan',
          ...planned.value,
        },
      },
    }
  }

  const applied = await applyImport(source.root, {
    ...options,
    ...(confirm.value === undefined ? {} : { confirm: confirm.value }),
    ...(readString(body['planToken']) === undefined ? {} : { planToken: readString(body['planToken']) ?? '' }),
  })
  if (!applied.ok) return refused(STATUS_BY_CODE[applied.error.code] ?? 500, applied.error)
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: source.root,
        action: 'apply',
        ...applied.value,
      },
    },
  }
}
