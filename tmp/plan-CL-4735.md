# Implementation plan — CL-4735

Enforce hard limits on frame size and recipient fan-out.

## Intent

Reject oversized raw/body frames and oversized recipient lists **before** multi-row insert construction (and before huge `inArray` lookups). Guardrails only — no shared frame table, no schema changes.

## Defaults (exported constants)

| Constant | Value | Where enforced |
| --- | --- | --- |
| `MAX_MAILBOX_FRAME_BYTES` | `1_048_576` (1 MiB) | Direct write after `buildMailFrame`; transport on `raw.byteLength` |
| `MAX_MAILBOX_RECIPIENTS` | `50` | Transport on input `recipients.length` before resolve |

Rationale: audit describes multi-megabyte frames and thousands of recipients as the failure mode; no numeric defaults exist in docs. 1 MiB matches “block multi-MB amplification” while allowing normal HTML mail. Recipient cap mirrors `MAX_BULK_MAILBOX_IDS` (50) — hard refuse, not clamp.

One frame-byte constant for both paths (not separate body vs raw names): direct write measures **final frame bytes** (headers + body); transport measures **raw frame bytes**.

## Files to modify

### `packages/mailbox/src/write.ts`

1. Export `MAX_MAILBOX_FRAME_BYTES = 1_048_576`.
2. In `insertMailboxMessage`, after `buildMailFrame`:
   - if `raw.byteLength > MAX_MAILBOX_FRAME_BYTES`, throw `RangeError` with the constant in the message (same shape as bulk/page caps).
3. Covers `writeMailboxMessage` and `deliverInboxItems` (both call `insertMailboxMessage`).

### `packages/mailbox/src/persist.ts`

1. Import `MAX_MAILBOX_FRAME_BYTES` from `write.js` (or co-export from a tiny shared spot — prefer `write.ts` for body/frame, re-export recipients from persist).
2. Export `MAX_MAILBOX_RECIPIENTS = 50`.
3. At the top of `writeMailboxRows`, **before** `authorizeSender` / resolve / `inArray` / insert:
   - if `raw.byteLength > MAX_MAILBOX_FRAME_BYTES` → `RangeError`
   - if `recipients.length > MAX_MAILBOX_RECIPIENTS` → `RangeError`
4. Dual-write independence unchanged: `attemptMailboxWrite` still catches and logs; over-cap prevents partial insert and does not reject upstream success.

### `packages/mailbox/src/index.ts`

Re-export `MAX_MAILBOX_FRAME_BYTES` and `MAX_MAILBOX_RECIPIENTS`.

### Docs

- `packages/mailbox/README.md` — document the two caps under write/limits.
- `ARCHITECTURE.md` § Known limits — frame bytes + recipient count as hard refuses.

### Tests

| Case | File |
| --- | --- |
| Direct write at cap succeeds; cap+1 throws `RangeError`, zero rows | `write.test.ts` |
| `deliverInboxItems` oversized body fails whole batch (atomic path already rolls back) | `write.test.ts` |
| Transport raw over cap → no `principal_mail` rows; upstream still called | `persist.test.ts` |
| Transport recipients over cap → no insert | `persist.test.ts` |
| Transport at-cap multi-recipient still delivers | `persist.test.ts` |

Follow existing patterns: `withTestDb`, `seedScope`, `rejects.toThrow(RangeError)`, `rowCount() === 0` (see `scope-validation.test.ts`, `mutations.test.ts` bulk cap).

## Non-goals

- Configurable per-host limits API (constants + docs only for this ticket)
- Cap on total fan-out-bytes product (frame × recipients)
- Shared immutable frame table / storage redesign
- Surfacing transport over-cap as a caller-visible error (would break dual-write independence)

## Commits (suggested)

1. Add frame/recipient caps and enforce on write + transport
2. Tests for boundary accept / over-cap reject
3. Document caps in README + ARCHITECTURE

## Verification

- `bun test` in package (DB tests need Postgres)
- `bun run typecheck` at root
