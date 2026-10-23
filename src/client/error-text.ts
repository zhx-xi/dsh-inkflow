/**
 * Wording for the refusals whose text has to carry a number (issue #115).
 *
 * Why a module of its own: `panel-model.ts` and `library-model.ts` are pure view
 * models — a guard test in `tests/panel-bundle.test.js` forbids them a runtime
 * import from the channel (`./internal.js`), precisely so they can be unit-tested
 * and bundled without a network. Both of them need this sentence, so it lives in
 * a third pure module instead of being copied into each (AGENTS.md §10.5).
 *
 * The case that produced it: a save carries a whole chapter as ONE JSON string, and
 * the channel's ceiling counted the serialised bytes. A 20,000-character chapter
 * serialises to ~70 KB, so the author got a bare `payload-too-large` next to a Save
 * button that appeared to do nothing at all.
 */

/** The shape this module needs from a channel error; no dependency on its type. */
export interface SizedRefusal {
  code: string
  limitBytes?: unknown
  [key: string]: unknown
}

/** A byte count in the unit a person reads (KB up to one decimal, MB above). */
export function formatByteSize(bytes: number): string {
  // A bad count must not print "-1 B" or "NaN B": fall back to "?".
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The `payload-too-large` refusal in words and numbers, or `null` for any other
 * code — so a caller chains it in front of its own hint table without restating
 * the condition.
 *
 * It always says "原文没有改动": the refusal happens before the Host reads the
 * body, and the author's next question is exactly that.
 */
export function describeTooLarge(error: SizedRefusal | undefined): string | null {
  if (error === undefined || error.code !== 'payload-too-large') return null
  const limit = typeof error.limitBytes === 'number' && Number.isFinite(error.limitBytes) ? error.limitBytes : null
  const ceiling = limit === null ? '面板通道装不下' : `面板通道上限 ${formatByteSize(limit)}`
  return `这一条太长了，${ceiling}：把它拆短（分章或分段）后重试。原文没有改动。`
}

/**
 * The write guard's refusal, in words an author can act on (issue #115).
 *
 * `forbidden-origin` used to reach the panel as a bare English code — this is the
 * card the author actually saw. The Host's refusal carries `reason` (`origin-required`
 * or `origin-mismatch`) and, for a mismatch, the offending `origin`; both are printed
 * because they are the whole diagnosis: "the request arrived with no Origin" is a
 * different bug from "the request arrived with a foreign one".
 */
export function describeOriginRefusal(error: SizedRefusal | undefined): string | null {
  if (error === undefined || error.code !== 'forbidden-origin') return null
  const reason = typeof error.reason === 'string' && error.reason !== '' ? error.reason : '未标明原因'
  const origin = typeof error.origin === 'string' && error.origin !== '' ? `；Host 收到的 Origin: ${error.origin}` : '（Host 没收到 Origin 头）'
  return (
    `这次保存被 Host 的写守卫拒绝了（forbidden-origin / ${reason}${origin}）：` +
    '面板写请求必须带一个 loopback Origin。原文没有改动，也没有写入任何字节。'
  )
}
