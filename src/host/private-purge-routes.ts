/**
 * The purge area's route descriptors: `GET /purged`, `POST /purged/clean`,
 * `POST /purged/restore`.
 *
 * WHY the descriptors live here instead of in `routes.ts`: that file is exactly on its recorded
 * line budget (`scripts/check-guards.mjs` item 10 — a file may not grow past the count it had
 * when the guard landed), and the purge area needs three new routes plus the fold's `limit` query. The
 * alternative would be deleting working guards or comments to make room, which is the trade the
 * guard exists to prevent. The same reason moved the route *contract* into `route-types.ts`.
 *
 * What does NOT move out of `routes.ts`: the hardening. Loopback host/origin/peer checks, the
 * per-route method declaration, the body-field allowlist, the body cap and the path-parameter
 * ban are all applied by the dispatcher to every entry of `ROUTES`, wherever its descriptor was
 * written. A route declared here is exactly as guarded as one declared inline — there is no
 * second code path that could skip a check.
 */

import { PURGE_CLEAN_BODY_FIELDS, PURGE_RESTORE_BODY_FIELDS, cleanUpViaChannel, purgedListReply, restorePurgedViaChannel } from './private-purge-channel.js'
import type { InternalRoute } from './route-types.js'

export const PRIVATE_PURGE_ROUTES: readonly InternalRoute[] = [
  {
    // What the author cleaned up and can still put back (ADR-0026). Read-only: the area is
    // a manifest plus copies, so a page refresh never creates or removes anything.
    name: 'purged',
    pattern: /^\/purged$/,
    methods: ['GET'],
    query: [],
    handle: ({ target, version }) => purgedListReply(target, version),
  },
  {
    // Move ONE thing into the area. `confirm: true` is required in the body — the panel asks
    // twice, and this is the net under that (ADR-0012 decision 4). An `open` proposal is refused by the
    // domain (`PURGE_OPEN_PROPOSAL`): only what is finished may be cleaned up.
    name: 'purged-clean',
    pattern: /^\/purged\/clean$/,
    methods: ['POST'],
    query: [],
    body: PURGE_CLEAN_BODY_FIELDS,
    handle: ({ target, version, body }) => cleanUpViaChannel(target, version, body),
  },
  {
    // The undo direction: every file goes back to the private-state path it left, byte for byte.
    // No `confirm` — it writes inside `.inkflow/{review,proposals}` only, and it never overwrites.
    name: 'purged-restore',
    pattern: /^\/purged\/restore$/,
    methods: ['POST'],
    query: [],
    body: PURGE_RESTORE_BODY_FIELDS,
    handle: ({ target, version, body }) => restorePurgedViaChannel(target, version, body),
  },
]
