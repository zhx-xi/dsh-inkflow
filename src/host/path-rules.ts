/**
 * The rules a **proposed file name** must satisfy, in one pure module.
 *
 * Why this is not inside `io.ts`: two callers with opposite roles need the same
 * answer, and a copy in each would drift.
 *
 *   - `io.ts` is the write door. It refuses a bad name *after* the author has
 *     already clicked 确认, and it is the last line of defence.
 *   - `impact.ts` is the read-only preview (conventions §5.6: "blockers empty means
 *     it can run"). It must name the same refusal *before* the click — otherwise
 *     the dialog promises an executable plan for a name the writer refuses
 *     (`blockers: []` → `400 PATH_RESERVED`, which is what the #34 review found
 *     with `con` / `nul` / `COM1`).
 *
 * Keeping it here also preserves a property `impact.ts` states about itself: the
 * listing imports no write capability at all. This module does string work only —
 * no `fs`, no project, no lock — so "the preview cannot write" stays checkable at
 * a glance, and the two sides cannot disagree about what a legal name is.
 */

/**
 * Device names Windows reserves: `CON.md` creates a file that no tool can open
 * again, and `COM1` writes to a serial port. Checked on every platform so a
 * project stays portable between the machines that share it.
 */
const WINDOWS_RESERVED = new Set<string>([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_unused, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_unused, index) => `LPT${index + 1}`),
])

/** Characters NTFS treats specially; legal on POSIX, but not portable. */
const UNSAFE_SEGMENT_CHARS = /[<>:"|?*]/

/** Per-component limit on NTFS. */
export const MAX_SEGMENT = 255

/** The three codes a single segment can be refused with (`io.ts`'s codes). */
export type SegmentProblemCode = 'PATH_INVALID' | 'PATH_TOO_LONG' | 'PATH_RESERVED'

export interface SegmentProblem {
  code: SegmentProblemCode
  message: string
}

/**
 * Is this one path segment (a file name, extension included) portable?
 *
 * `undefined` means "no objection". The checks are ordered so the code names the
 * real problem instead of the first one that happens to match.
 */
export function checkSegment(segment: string): SegmentProblem | undefined {
  if (segment === '') return { code: 'PATH_INVALID', message: 'a write path must not contain empty segments' }
  if (segment === '.' || segment === '..') {
    return { code: 'PATH_INVALID', message: `"${segment}" segments are not allowed; the path is already relative to the project root` }
  }
  if (segment.length > MAX_SEGMENT) {
    return { code: 'PATH_TOO_LONG', message: `the file name is ${segment.length} characters; the limit is ${MAX_SEGMENT}` }
  }
  if (UNSAFE_SEGMENT_CHARS.test(segment)) {
    return { code: 'PATH_INVALID', message: `the file name contains a character that is not portable: ${segment}` }
  }
  // Windows strips trailing dots and spaces, so `x.md.` and `x.md ` silently
  // address the same file as `x.md` while looking like different chapters.
  if (/[. ]$/.test(segment)) {
    return { code: 'PATH_INVALID', message: `a file name must not end with a dot or a space: ${segment}` }
  }
  const stem = (segment.split('.')[0] ?? '').toUpperCase()
  if (WINDOWS_RESERVED.has(stem)) {
    return { code: 'PATH_RESERVED', message: `"${segment}" uses the reserved Windows device name ${stem}` }
  }
  return undefined
}

/**
 * Can this value go into a frontmatter line as is?
 *
 * A display name is written as one `key: value` line, so a line break would turn
 * the rest of the name into a second frontmatter key — the file would then say
 * something the author never wrote. Checked by the preview (`impact.ts`) and by
 * the write (`impact-write.ts`) through this one function, for the same reason as
 * `checkSegment`.
 */
export function isSingleLine(value: string): boolean {
  return !/[\r\n]/u.test(value)
}
