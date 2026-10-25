/**
 * Shared plumbing for the built-in tool surface (split out of `tools.ts`).
 *
 * Why this module exists: `tools.ts` was a 2269-line file holding every built-in tool
 * plus the reply envelope every one of them returns. The tools now live in one file per
 * domain (`project-tools.ts`, `chapter-tools.ts`, …); what is left here is exactly the
 * part no single domain owns — the tool dependency bag, the `{ok, …}` envelope, the
 * gate-prefixed `projectRoot` parameter, the compare-and-swap write baseline and the
 * two ways an index rebuild can fail. Each domain keeps its own refusal rendering in
 * its own file, next to the codes only that domain produces.
 *
 * Nothing in this file decides anything: every helper is shape-only, so moving a tool
 * between domain files changes no byte the model sees.
 */

import type { ContentBlock, HostContext, JsonSchemaNode } from '../context.js'
import type { EnsureIndexResult } from '../index-freshness.js'
import type { FileExpectation } from '../file-cas.js'
import { describeIndexBuildFailure } from '../index-build.js'

export interface ToolDeps {
  ctx: HostContext
  dataDir: string
  version: string
}

export type Json = Record<string, unknown>

export function text(lines: string[]): ContentBlock[] {
  return [{ type: 'text', text: lines.join('\n') }]
}

export function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {}
}

const OBJECT_SCHEMA: JsonSchemaNode = { type: 'object', additionalProperties: true }

/**
 * The model-facing shape of a failed rebuild. The index is a cache, so a failed
 * rebuild is reported as data — never as a thrown stack trace.
 */
export function indexBuildFailure(cause: unknown, root: string): Json {
  const failure = describeIndexBuildFailure(cause)
  return {
    ok: false,
    root,
    error: {
      code: failure.code,
      errno: failure.errno,
      message: failure.message,
      hint:
        failure.code === 'INDEX_BUSY'
          ? 'another session or process is already rebuilding this index; retry in a moment'
          : 'the previous index (if any) is still readable; fix the cause and rebuild',
    },
  }
}

/**
 * A caller-supplied write baseline (`FILE_CHANGED`).
 *
 * Accepted as a plain object on `inkflow_chapter_write` / `_move` / `_delete`
 * and on `inkflow_project_init`; every field that is present must match, so
 * `{ sha256 }` alone is a full content check and `{ absent: true }` is "the file
 * must not exist yet".
 */
export const EXPECTED_PARAM = {
  type: 'object',
  properties: {
    sha256: { type: 'string', description: 'Lowercase hex sha256 of the file bytes you last read.' },
    size: { type: 'integer', description: 'Byte length of the file you last read (0 or higher).' },
    mtimeMs: { type: 'number', description: 'Modification time in ms (only compared when sha256/size are absent).' },
    absent: { type: 'boolean', description: 'True when the file must not exist yet (project init).' },
  },
  additionalProperties: false,
  description:
    'Optional compare-and-swap baseline: the file fingerprint you last read. A mismatch is refused with FILE_CHANGED ' +
    'and nothing is written, so an editor save is never overwritten by a stale write.',
} as const

export function expectedParam(value: unknown): FileExpectation | undefined {
  const raw = asRecord(value)
  if (Object.keys(raw).length === 0) return undefined
  const expected: FileExpectation = {}
  if (typeof raw['sha256'] === 'string' && raw['sha256'].trim() !== '') expected.sha256 = raw['sha256'].trim()
  if (typeof raw['size'] === 'number') expected.size = raw['size']
  if (typeof raw['mtimeMs'] === 'number') expected.mtimeMs = raw['mtimeMs']
  if (raw['absent'] === true) expected.absent = true
  return expected
}

/** Report a rebuild that `ensureIndex` refused, keeping the freshness verdict visible. */
export function ensureFailure(ensured: EnsureIndexResult & { ok: false }, root: string): Json {
  const failure = indexBuildFailure(ensured.failure, root)
  const error = asRecord(failure['error'])
  return {
    ...failure,
    error: {
      ...error,
      indexState: ensured.state,
      indexReasons: ensured.freshness.reasons,
    },
  }
}

export const PROJECT_ROOT_PARAM = {
  type: 'string',
  description:
    'Absolute path of the InkFlow project root. Omit to resolve from the session working directory (walks up to the nearest project). An explicit path must live inside the session working directory.',
} as const

/** A JSON argument that is not a string counts as "not given"; validation is the tool's job. */
export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export const SUCCESS_SCHEMA: JsonSchemaNode = {
  type: 'object',  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: true,
}

export const commitLine = (value: Json): string => {
  const parts = ['catalog rebuilt']
  if (value['indexRebuilt'] === true) parts.push('index rebuilt')
  else if (value['indexError'] !== undefined) {
    parts.push(`index NOT rebuilt (${String(asRecord(value['indexError'])['code'] ?? 'unknown')}) — run inkflow_index_rebuild`)
  }
  return parts.join('; ')
}

/** Exported for tests: the schema every tool must satisfy. */
export const TOOL_OUTPUT_SCHEMA: JsonSchemaNode = OBJECT_SCHEMA

