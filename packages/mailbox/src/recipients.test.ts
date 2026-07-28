import { describe, expect, test } from "bun:test";
import {
  parseAddressList,
  resolveMailboxRecipients,
} from "./recipients.js";

describe("parseAddressList", () => {
  test("splits a multi-recipient header", () => {
    expect(parseAddressList("a@x.example, b@x.example, c@x.example")).toEqual([
      "a@x.example",
      "b@x.example",
      "c@x.example",
    ]);
  });

  test("does not split on a comma inside a quoted display name", () => {
    expect(parseAddressList('"Doe, Jane" <j@x.example>, k@x.example')).toEqual([
      '"Doe, Jane" <j@x.example>',
      "k@x.example",
    ]);
  });

  test("does not split on a comma inside angle brackets", () => {
    expect(parseAddressList("Ops <ops@x.example>, k@x.example")).toHaveLength(
      2,
    );
  });

  test("drops empty entries from a trailing separator", () => {
    expect(parseAddressList("a@x.example, ,")).toEqual(["a@x.example"]);
  });
});

describe("resolveMailboxRecipients", () => {
  const DOMAIN = "acme.example";

  // Addr-spec extraction is @intx/mime's `extractAddrSpec`; these two pin the
  // behavior this module depends on it for — display-name stripping and
  // case-insensitive matching of both local-part and domain.
  test("strips the display name and matches case-insensitively", () => {
    expect(
      resolveMailboxRecipients(['"Jane" <usr_Jane@ACME.Example>'], DOMAIN),
    ).toEqual([{ address: "usr_jane@acme.example", principalId: "jane" }]);
  });

  test("tolerates surrounding whitespace on a bare address", () => {
    expect(
      resolveMailboxRecipients([" usr_bob@acme.example "], DOMAIN),
    ).toEqual([{ address: "usr_bob@acme.example", principalId: "bob" }]);
  });

  test("resolves a usr_-prefixed address to its principalId", () => {
    expect(
      resolveMailboxRecipients(["usr_alice@acme.example"], DOMAIN),
    ).toEqual([{ address: "usr_alice@acme.example", principalId: "alice" }]);
  });

  test("resolves a legacy bare address to its principalId", () => {
    expect(resolveMailboxRecipients(["alice@acme.example"], DOMAIN)).toEqual([
      { address: "alice@acme.example", principalId: "alice" },
    ]);
  });

  test("excludes ins_ instance addresses", () => {
    expect(
      resolveMailboxRecipients(["ins_run42@acme.example"], DOMAIN),
    ).toEqual([]);
  });

  test("skips a cross-tenantId domain mismatch", () => {
    expect(
      resolveMailboxRecipients(["usr_alice@other.example"], DOMAIN),
    ).toEqual([]);
  });

  test("keeps only the tenantId's own addresses out of a mixed list", () => {
    const resolved = resolveMailboxRecipients(
      [
        "usr_alice@acme.example",
        "bob@acme.example",
        "ins_run42@acme.example",
        "usr_mallory@evil.example",
        "Carol <usr_carol@ACME.example>",
      ],
      DOMAIN,
    );
    expect(resolved.map((r) => r.principalId)).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
  });

  test("collapses a principalId named twice into one delivery", () => {
    expect(
      resolveMailboxRecipients(
        ["usr_alice@acme.example", "alice@acme.example"],
        DOMAIN,
      ),
    ).toHaveLength(1);
  });

  test("ignores entries that are not addresses", () => {
    expect(
      resolveMailboxRecipients(
        ["undisclosed-recipients", "@acme.example"],
        DOMAIN,
      ),
    ).toEqual([]);
  });
});
