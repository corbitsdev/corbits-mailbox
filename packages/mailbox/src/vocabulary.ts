// The package ships mechanism; the host ships opinion. The `priority` and
// `status` vocabularies are supplied by the host through `MountMailboxOpts`,
// and the schemas, OpenAPI enums and ranking are generated from them — there
// is no closed vocabulary anywhere in this package. `classification` and
// `assignee` are open host-defined strings with no ordering and nothing to
// generate.

import { sql, type SQL } from "drizzle-orm";
import { mailbox } from "./schema.js";

/**
 * The host's triage vocabulary.
 *
 * `priorities` is ORDERED, most urgent first — the order *is* the ranking, and
 * `sort=priority` reads it straight out of this array. `statuses` is an
 * unordered set; nothing sorts by it.
 */
export type MailboxVocabulary = {
  priorities: readonly string[];
  statuses: readonly string[];
};

/**
 * Reject a vocabulary this package cannot generate a total ordering or a
 * meaningful OpenAPI enum from, at mount time rather than on the first request.
 *
 * Duplicates are refused rather than de-duplicated: a host that lists `high`
 * twice has two different ranks in mind for it, and silently keeping the first
 * picks one of them without saying so.
 */
export function assertMailboxVocabulary(vocab: MailboxVocabulary): void {
  for (const [label, values] of [
    ["priorities", vocab.priorities],
    ["statuses", vocab.statuses],
  ] as const) {
    if (values.length === 0) {
      throw new RangeError(`mailbox ${label} must not be empty`);
    }
    for (const value of values) {
      if (value.length === 0) {
        throw new RangeError(`mailbox ${label} must not contain a blank value`);
      }
    }
    if (new Set(values).size !== values.length) {
      throw new RangeError(`mailbox ${label} must not contain duplicates`);
    }
  }
}

/**
 * Most-urgent-first rank for `sort=priority`, generated from the host's ordered
 * list. Anything not in the list — including the NULL of an un-triaged message
 * and a value left behind by a vocabulary the host has since changed — ranks
 * LAST rather than sorting as an empty string, so un-triaged mail falls to the
 * bottom of a priority-sorted list instead of leading it.
 *
 * The literals are bound as parameters, never interpolated: the vocabulary is
 * host input and this expression is built per request.
 */
export function priorityRank(priorities: readonly string[]): SQL<number> {
  const whens = priorities.map(
    (value, rank) => sql`WHEN ${value} THEN ${sql.raw(String(rank))}`,
  );
  return sql<number>`CASE ${mailbox.priority} ${sql.join(whens, sql` `)} ELSE ${sql.raw(String(priorities.length))} END`;
}

/**
 * A stable string identifying which priority ordering a page was produced
 * under, embedded in every `sort=priority` cursor.
 *
 * Precedent and reasoning are `canonicalMailboxFilter`'s: a keyset cursor is
 * only meaningful against the exact result set it was minted from. The leading
 * component of a priority-sorted keyset is an INTEGER RANK, so a host that
 * reorders its vocabulary between two requests leaves in-flight cursors seeking
 * on a rank that now means a different band — silently skipping or repeating
 * every message in between. Embedding this lets the route refuse instead.
 *
 * Only the ORDER matters, so this is the list itself: reordering changes it,
 * and appending a new lowest-priority band does too (it shifts nothing, but it
 * does change what rank `n` means for the ELSE arm).
 */
export function canonicalMailboxPriorities(
  priorities: readonly string[],
): string {
  return priorities.map((value) => encodeURIComponent(value)).join(",");
}
