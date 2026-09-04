import { describe, expect, test } from "bun:test";
import { generateMessageId, parseHeaderSection } from "@intx/mime";
import {
  buildMailFrame,
  decodeMailFrame,
  generateMailboxMessageId,
  MESSAGE_ID_FALLBACK_DOMAIN,
} from "./frame.js";

// A well-formed msg-id: exactly one pair of angle brackets, nothing nested.
const MESSAGE_ID = /^<[^<>]+@[^<>]+>$/;

function frame(overrides: Partial<Parameters<typeof buildMailFrame>[0]> = {}) {
  return buildMailFrame({
    from: "bot@example.com",
    to: "user@example.com",
    subject: "hello",
    body: "body",
    messageId: "<fixed-id@example.com>",
    ...overrides,
  });
}

function headers(raw: Uint8Array) {
  return parseHeaderSection(raw).headers;
}

describe("buildMailFrame headers", () => {
  // Nothing used to assert a single header value this function produces,
  // which is how a doubly-bracketed Message-ID shipped unnoticed.
  test("emits every header it promises, verbatim", () => {
    const h = headers(frame());
    expect(h.get("from")).toBe("bot@example.com");
    expect(h.get("to")).toBe("user@example.com");
    expect(h.get("subject")).toBe("hello");
    expect(h.get("message-id")).toBe("<fixed-id@example.com>");
    expect(h.get("date")).toBeDefined();
    expect(Number.isNaN(new Date(h.get("date")!).getTime())).toBe(false);
    expect(h.has("in-reply-to")).toBe(false);
  });

  test("In-Reply-To is emitted only when supplied, brackets intact", () => {
    const h = headers(frame({ inReplyTo: "<parent@example.com>" }));
    expect(h.get("in-reply-to")).toBe("<parent@example.com>");
  });

  test("a Message-ID from @intx/mime survives the frame unchanged", () => {
    // Regression: generateMessageId already returns `<uuid@domain>`. The frame
    // builder used to wrap it a second time, writing `<<uuid@domain>>` into
    // every `raw` — frozen and corrupt at rest, and unthreadable by any MTA.
    const generated = generateMessageId("bot@example.com");
    expect(generated).toMatch(MESSAGE_ID);
    expect(headers(frame({ messageId: generated })).get("message-id")).toBe(
      generated,
    );
    expect(
      headers(frame({ messageId: generated })).get("message-id"),
    ).not.toContain("<<");
  });

  test("header values can never smuggle in extra headers", () => {
    const h = headers(
      frame({ subject: "evil\r\nBcc: attacker@example.com", from: "a@b.c" }),
    );
    expect(h.get("subject")).toBe("evil Bcc: attacker@example.com");
    expect(h.has("bcc")).toBe(false);
  });

  test("References is emitted oldest first, folded, and round-trips", () => {
    // A three-deep chain is the shortest one where order and folding both
    // matter: a client walks References oldest-first to place a reply under its
    // root, and RFC 2822 caps a header line at 78 characters — which a chain
    // passes within a few ids.
    const chain = [
      "<root-message-of-the-thread@example.com>",
      "<second-message-of-the-thread@example.com>",
      "<third-message-of-the-thread@example.com>",
    ];
    const raw = frame({ references: chain, inReplyTo: chain[2] });
    const text = new TextDecoder().decode(raw);
    // Folded: continuation lines begin with the single space RFC 2822 requires.
    expect(text).toContain("\r\n <");
    for (const line of text.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
    const decoded = decodeMailFrame(raw);
    expect(decoded?.references).toEqual(chain);
    // In-Reply-To stays a SINGLE msg-id — the immediate parent, not the chain.
    expect(decoded?.inReplyTo).toBe(chain[2]!);
    expect(decoded?.messageId).toBe("<fixed-id@example.com>");
  });

  test("no References header when the chain is absent or empty", () => {
    expect(headers(frame()).has("references")).toBe(false);
    expect(headers(frame({ references: [] })).has("references")).toBe(false);
    expect(decodeMailFrame(frame())?.references).toEqual([]);
    expect(decodeMailFrame(frame())?.inReplyTo).toBeNull();
  });

  test("a frame with no Message-ID decodes to a null messageId", () => {
    const raw = new TextEncoder().encode(
      "From: a@b.c\r\nTo: d@e.f\r\nSubject: s\r\n\r\nbody\r\n",
    );
    const decoded = decodeMailFrame(raw);
    expect(decoded?.messageId).toBeNull();
    expect(decoded?.inReplyTo).toBeNull();
    expect(decoded?.references).toEqual([]);
  });

  test("a threading value that is not a bracketed msg-id is refused", () => {
    // A frame is frozen at rest: an unthreadable header written today is
    // unthreadable forever, so this is refused at the builder rather than
    // stored and discovered by an MTA.
    expect(() => frame({ messageId: "fixed-id@example.com" })).toThrow(
      RangeError,
    );
    expect(() => frame({ messageId: "<<double@example.com>>" })).toThrow(
      RangeError,
    );
    expect(() => frame({ inReplyTo: "parent@example.com" })).toThrow(RangeError);
    expect(() =>
      frame({ references: ["<ok@example.com>", "not-an-id"] }),
    ).toThrow(RangeError);
    expect(() => frame({ references: ["<no-domain>"] })).toThrow(RangeError);
  });

  test("the body round-trips through decodeMailFrame", () => {
    const decoded = decodeMailFrame(frame({ body: "line one\nline two" }));
    expect(decoded?.body).toBe("line one\nline two");
  });
});

describe("Message-ID domain fallback", () => {
  // `@intx/mime`'s own generateMessageId falls back to the bare `local`
  // instead, so this is deliberately NOT delegated — the two differ, and a
  // non-resolving domain is the safer fallback.
  test("uses hub.invalid when the sender address carries no domain", () => {
    const id = generateMailboxMessageId("no-at-sign");
    expect(id).toMatch(MESSAGE_ID);
    expect(id.endsWith("@hub.invalid>")).toBe(true);
    expect(MESSAGE_ID_FALLBACK_DOMAIN).toBe("hub.invalid");
  });

  test("uses hub.invalid when the address ends at a bare @", () => {
    expect(generateMailboxMessageId("bot@").endsWith("@hub.invalid>")).toBe(
      true,
    );
    expect(generateMailboxMessageId("").endsWith("@hub.invalid>")).toBe(true);
  });

  test("uses the sender's own domain when it has one", () => {
    const id = generateMailboxMessageId("bot@example.com");
    expect(id).toMatch(MESSAGE_ID);
    expect(id.endsWith("@example.com>")).toBe(true);
  });

  test("differs from the upstream helper's fallback, which is not hub.invalid", () => {
    // Pins the reason this helper exists: if @intx/mime ever adopts
    // hub.invalid, this test fails and the local helper can be retired.
    expect(generateMessageId("no-at-sign").endsWith("@local>")).toBe(true);
  });

  test("mints a distinct id per call", () => {
    expect(generateMailboxMessageId("bot@example.com")).not.toBe(
      generateMailboxMessageId("bot@example.com"),
    );
  });
});
