/**
 * Pure view model for the setting-library tab (roadmap X-7).
 *
 * Plain functions over plain data, for the same reason `panel-model.ts` is: `node --test`
 * has no DOM, so the React View is only checked as a built bundle while the grouping rules
 * are tested directly. Three shapes feed this module:
 *
 *   * `GET /inkflow/internal/library` — eight kind groups (X-7: `CONTENT_DIRS` minus
 *     `chapters`), five of which this page renders (`SETTINGS_LIBRARY_KINDS`); `world`
 *     also carries its `category` buckets. `indexAvailable: false` means "cannot answer",
 *     NOT "the book has no characters".
 *   * `GET /inkflow/internal/library/issues` — a flat `validation_issues` list. Grouping by
 *     `code` happens here because it is presentation; the wire stays flat.
 *   * the detail payload (`fingerprint` included) and the `POST /library/item` body it
 *     becomes — field sets per kind, "what changed" and the CAS baseline.
 *
 * WHY IT IS STILL A FILE: it is the address every panel view and three sibling models import
 * from, and that address is what keeps the four halves independent. The code itself lives in
 * the `library-*-model.ts` files next to this one:
 *
 *   * `library-tree-model.ts` — wire shapes, kind labels, the tree (the types leaf);
 *   * `library-issues-model.ts` — `validation_issues` grouped by code;
 *   * `library-editor-model.ts` — field sets, draft, save payload, which write is on offer;
 *   * `library-wording-model.ts` — empty states and refusal wording.
 *
 * No IO, no React, no `@deepseek-ai/*` import (ADR-0008 D4/V7).
 */

export * from './library-tree-model.js'
export * from './library-issues-model.js'
export * from './library-editor-model.js'
export * from './library-wording-model.js'
