/**
 * The small surface every domain tool needs, in one place.
 *
 * `world-tools.ts` and `outline-tools.ts` each carry a private copy of these helpers
 * (they landed before this file existed); the timeline tools (#28) use this module
 * instead of adding a third. Moving the two older copies over is a mechanical
 * follow-up that no branch has to own — nothing here is domain-specific:
 *
 *   - `withProject()` — the four-state project gate plus the session working directory,
 *     so a domain tool resolves the book exactly the way a built-in tool does and never
 *     from `process.cwd()` (inside the host process that is the DSH install directory);
 *   - argument readers that treat "not a string" / "not true" as "not given", because
 *     the model's JSON is untrusted and validation belongs to the caller;
 *   - `slugify()` — a title → portable file name, CJK preserved as-is;
 *   - `indexFailure()` — the error shape `tools.ts` answers with, so the model sees one
 *     code family no matter which half answered.
 */

import { resolve as resolvePath } from 'node:path'

import type { ContentBlock, JsonSchemaNode, ToolRunContext } from '../context.js'
import { findProjectRoot, inspectProject } from '../project.js'
import { sessionCwd } from '../session-cwd.js'
import type { DomainToolDeps } from './types.js'

export type Json = Record<string, unknown>

/** The `{type:'text'}` block every tool result renders through. */
export function text(lines: string[]): ContentBlock[] {
  return [{ type: 'text', text: lines.join('\n') }]
}

export function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {}
}

/** A JSON argument that is not a non-empty string counts as "not given"; validation is the tool's job. */
export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function optionalBoolean(value: unknown): boolean {
  return value === true
}

export const PROJECT_ROOT_PARAM = {
  type: 'string',
  description:
    'Absolute path of the InkFlow project root. Omit to resolve from the session working directory (walks up to the nearest project).',
} as const

export const OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: true,
}

/** Characters a slug may never carry: path separators, control bytes, Windows-reserved shapes. */
const UNSAFE_SEGMENT = /[<>:"|?*\\/\u0000-\u001f]/u
const SLUG_MAX = 60

/**
 * Title → file slug. CJK survives as-is (a Chinese title needs no transliteration and
 * stays readable in `git diff`); whitespace and anything a filesystem would rewrite
 * collapses to a single `-`.
 */
export function slugify(title: string): string {
  const normalized = title.normalize('NFKC').replace(UNSAFE_SEGMENT, '-').replace(/\s+/gu, '-').replace(/-+/gu, '-')
  const trimmed = normalized.replace(/^[-. ]+/u, '').replace(/[-. ]+$/u, '')
  return [...trimmed].slice(0, SLUG_MAX).join('').replace(/[-. ]+$/u, '')
}

/**
 * Is this slug portable as one path segment — and **visible**?
 *
 * The leading-dot rule is not cosmetic. Both scanners skip dot entries
 * (`indexer.ts`'s walk and `impact.ts`'s listing), so a file named `.hidden.md`
 * would be written successfully and then be invisible: the tool answered 200, yet
 * `GET /library`/`GET /impact` cannot find it, the index has no row for it, and
 * the relations that name it report `RELATION_ENDPOINT` — the entry is gone, with
 * git as the only way back (#34 review). `.`/`..` are refused by the same line.
 */
export function isPortableSlug(slug: string): boolean {
  return slug !== '' && !slug.startsWith('.') && !UNSAFE_SEGMENT.test(slug) && !slug.includes('/')
}

/** Index failure, in the same shape `tools.ts` answers with. */
export function indexFailure(root: string, failure: { code: string; errno?: string; message: string }): Json {
  return {
    ok: false,
    root,
    error: {
      code: failure.code,
      ...(failure.errno === undefined ? {} : { errno: failure.errno }),
      message: failure.message,
      hint:
        failure.code === 'INDEX_BUSY'
          ? 'another session or process is already rebuilding this index; retry in a moment'
          : 'the previous index (if any) is still readable; fix the cause and rebuild',
    },
  }
}

/** Gate → run. A non-usable project gets the same four-state refusal `tools.ts` gives. */
export async function withProject(
  deps: DomainToolDeps,
  exec: ToolRunContext,
  args: unknown,
  run: (root: string) => Promise<Json>,
): Promise<Json> {
  const a = asRecord(args)
  const requested = optionalString(a['projectRoot'])
  const root = requested !== undefined ? resolvePath(requested) : findProjectRoot(await sessionCwd(deps.ctx, exec))
  if (root === undefined) {
    return {
      ok: false,
      error: {
        code: 'NOT_AN_INKFLOW_PROJECT',
        state: 'needs-setup',
        message: 'no InkFlow project was found from the session working directory',
        hint: 'pass projectRoot, or open the book so the session working directory is inside it',
      },
    }
  }
  const probe = inspectProject(root)
  if (probe.usable !== true) {
    const code =
      probe.state === 'needs-newer-plugin'
        ? 'PROJECT_NEEDS_NEWER_PLUGIN'
        : probe.state === 'needs-repair'
          ? 'PROJECT_NEEDS_REPAIR'
          : 'NOT_AN_INKFLOW_PROJECT'
    return {
      ok: false,
      error: {
        code,
        state: probe.state,
        root: probe.root,
        message: `this directory is not a usable InkFlow project (state: ${probe.state})`,
        missing: probe.missing,
        hint:
          code === 'PROJECT_NEEDS_NEWER_PLUGIN'
            ? 'this book was written by a newer dsh-inkflow; tell the user to upgrade the plugin'
            : 'run inkflow_project_plan, show the list to the user, then inkflow_project_init with confirm: true',
      },
    }
  }
  return run(probe.root)
}
