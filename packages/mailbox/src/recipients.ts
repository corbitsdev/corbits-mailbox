// Recipient address handling: splitting an RFC 2822 address-list header, and
// deciding which of those addresses are principal mailboxes this tenant owns.

import { extractAddrSpec } from "@intx/mime";
import { isAgentAddress } from "@intx/types";

/**
 * Split an address-list header (`To:`, `Cc:`) into its individual addresses.
 * Commas inside a quoted display name or inside angle brackets are not
 * separators, so `"Doe, Jane" <j@x>, k@x` is two addresses, not three.
 */
export function parseAddressList(header: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angled = true;
    else if (!quoted && ch === ">") angled = false;
    else if (ch === "," && !quoted && !angled) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((a) => a.trim()).filter((a) => a.length > 0);
}

// Current principal addresses are `usr_<principal>@…`; addresses minted before
// the prefix existed are bare (`<principal>@…`) and must still resolve.
const USER_PREFIX = "usr_";

export type ResolvedRecipient = { address: string; principalId: string };

/**
 * Resolve inbound recipient addresses to the principals whose mailboxes should
 * receive the message.
 *
 * - `usr_<principal>@domain` -> `<principal>`
 * - `<principal>@domain` (legacy bare) -> `<principal>`
 * - `ins_<id>@domain` -> excluded; instance addresses are not mailboxes
 * - any address whose domain is not `domain` -> skipped, since a mailbox row
 *   is tenant-scoped and delivering another tenant's address into this
 *   tenant would cross the isolation boundary
 *
 * Duplicates collapse: the same principal named twice receives one row.
 */
export function resolveMailboxRecipients(
  addresses: string[],
  domain: string,
): ResolvedRecipient[] {
  const tenantDomain = domain.trim().toLowerCase();
  const seen = new Set<string>();
  const out: ResolvedRecipient[] = [];
  for (const raw of addresses) {
    // `extractAddrSpec` throws on anything that is not a well-formed
    // addr-spec (no `@`, empty local-part, quoted local-part, trailing
    // content after `>`). An unparseable entry in a `To:`/`Cc:` list is an
    // expected case — `undisclosed-recipients:;` and friends — so it is
    // skipped rather than allowed to fail the whole delivery.
    let address: string;
    try {
      // Lowercases both local-part and domain, which is what the
      // case-insensitive tenant-domain and principal matching below relies
      // on; `tenantDomain` is lowercased to match.
      address = extractAddrSpec(raw);
    } catch {
      continue;
    }
    // Guaranteed by `extractAddrSpec`: exactly one `@`, both sides non-empty.
    const at = address.indexOf("@");
    if (address.slice(at + 1) !== tenantDomain) continue;
    // Instance addresses (`ins_<id>@…`) belong to a running workflow instance,
    // not to a person, and have their own delivery path — they are never
    // principal mailboxes. `@intx/types` owns that format; do not re-derive it.
    if (isAgentAddress(address)) continue;
    const local = address.slice(0, at);
    const principalId = local.startsWith(USER_PREFIX)
      ? local.slice(USER_PREFIX.length)
      : local;
    if (principalId.length === 0 || seen.has(principalId)) continue;
    seen.add(principalId);
    out.push({ address, principalId });
  }
  return out;
}
