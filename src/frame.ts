import {
  extractPartByPath,
  formatRFC2822Date,
  parseHeaderSection,
  parseMimePart,
} from "@intx/mime";

// Header values are single-line by contract; anything reaching a header
// (an externally-supplied subject in particular) is flattened so it can
// never smuggle in extra headers via embedded newlines.
export function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * The domain a minted Message-ID falls back to when the sender address carries
 * none. Not a cosmetic choice:
 * `.invalid` is the RFC 2606 §2 reserved TLD, guaranteed never to resolve, so a
 * frame whose sender was malformed can never mint an id that looks routable.
 *
 * `@intx/mime`'s `generateMessageId` falls back to the bare `local` instead,
 * which is a real (if conventional) hostname and reserved for nothing. This is
 * deliberately NOT delegated upstream for that reason — see README.
 */
export const MESSAGE_ID_FALLBACK_DOMAIN = "hub.invalid";

/**
 * Mint a Message-ID for a frame this package authors: `<uuid@domain>`, where
 * the domain is the sender's, or `hub.invalid` when the sender address has no
 * parseable domain.
 */
export function generateMailboxMessageId(fromAddress: string): string {
  const at = fromAddress.lastIndexOf("@");
  const domain = at === -1 ? "" : fromAddress.slice(at + 1).trim();
  return `<${crypto.randomUUID()}@${domain === "" ? MESSAGE_ID_FALLBACK_DOMAIN : domain}>`;
}

/**
 * A msg-id as every threading header carries it: exactly one pair of angle
 * brackets, an `@`, and no whitespace. The same shape `@intx/mime`'s
 * `generateMessageId` and `generateMailboxMessageId` return.
 */
const MSG_ID = /^<[^<>\s]+@[^<>\s]+>$/;

/**
 * Refuse a threading header value that is not a bracketed msg-id.
 *
 * `RangeError` for the same reason the frame-byte cap throws it: a caller that
 * hands this builder `uuid@host` (or `<<uuid@host>>`) has a bug, and a frame is
 * frozen at rest — an unthreadable `References:` written today is unthreadable
 * forever. Rejecting at the builder is the last point where the caller can
 * still be blamed precisely.
 */
export function assertMsgId(value: string, field: string): void {
  if (!MSG_ID.test(value)) {
    throw new RangeError(
      `mailbox frame ${field} must be a bracketed msg-id (<local@domain>), got ${JSON.stringify(value)}`,
    );
  }
}

// RFC 2822 §2.1.1 caps a line at 78 characters; a References chain on a deep
// thread passes that within a handful of ids. Folded before each id that would
// overflow, with the single leading space RFC 2822 §2.2.3 requires — an
// unfolding parser joins the pieces back into one space-separated value.
const HEADER_LINE_MAX = 78;

function foldReferences(references: readonly string[]): string {
  const lines: string[] = ["References:"];
  for (const reference of references) {
    const current = lines[lines.length - 1]!;
    if (current.length + 1 + reference.length > HEADER_LINE_MAX) {
      lines.push(` ${reference}`);
      continue;
    }
    lines[lines.length - 1] = `${current} ${reference}`;
  }
  return lines.join("\r\n");
}

/** Split an unfolded `References:` value into its msg-ids, oldest first. */
export function parseMsgIdList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value.match(/<[^<>]+>/g) ?? [];
}

export type MailFrameArgs = {
  from: string;
  to: string;
  subject: string;
  body: string;
  /**
   * A complete msg-id INCLUDING its angle brackets, e.g. `<uuid@host>` — the
   * same shape `@intx/mime`'s `generateMessageId` returns and its mail builder
   * requires. The brackets belong to the id, not to this frame builder —
   * `<<uuid@host>>` is not a valid msg-id and breaks In-Reply-To threading
   * against any real MTA.
   */
  messageId: string;
  /** Also a complete msg-id, brackets included. */
  inReplyTo?: string;
  /**
   * The thread's ancestry, OLDEST FIRST — the order RFC 2822 §3.6.4 defines
   * and every threading client walks. Each entry is a complete msg-id,
   * brackets included. `In-Reply-To` stays a single msg-id (the immediate
   * parent); this is the whole chain, and the two are independent — a caller
   * supplying one is not obliged to supply the other.
   */
  references?: string[];
};

/**
 * Build a minimal RFC 2822 frame. Message detail treats `raw` as
 * authoritative — headers, body, and snippet are re-derived from it. Inbox list
 * does not load `raw` and projects subject/from from denormalized caches only.
 * Any row this package writes directly must still carry a real frame, not just
 * cached columns.
 */
export function buildMailFrame(args: MailFrameArgs): Uint8Array {
  const from = headerValue(args.from);
  const messageId = headerValue(args.messageId);
  assertMsgId(messageId, "messageId");
  const headers = [
    `From: ${from}`,
    `To: ${headerValue(args.to)}`,
    `Subject: ${headerValue(args.subject)}`,
    `Date: ${formatRFC2822Date(new Date())}`,
    `Message-ID: ${messageId}`,
  ];
  if (args.inReplyTo !== undefined) {
    const inReplyTo = headerValue(args.inReplyTo);
    assertMsgId(inReplyTo, "inReplyTo");
    headers.push(`In-Reply-To: ${inReplyTo}`);
  }
  if (args.references !== undefined && args.references.length > 0) {
    const references = args.references.map((reference) => {
      const value = headerValue(reference);
      assertMsgId(value, "references entry");
      return value;
    });
    headers.push(foldReferences(references));
  }
  const body = args.body.replace(/\r?\n/g, "\r\n");
  return new TextEncoder().encode(`${headers.join("\r\n")}\r\n\r\n${body}\r\n`);
}

export type DecodedFrame = {
  headers: Map<string, string>;
  body: string;
  /**
   * The threading headers, parsed once here rather than re-derived by every
   * reader. `messageId` and `inReplyTo` are null when the frame carries no such
   * header; `references` is `[]`, oldest first, for the same case — a chain of
   * no ancestors is an empty chain, not an absent one.
   */
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
};

function normalizeMailText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false })
    .decode(bytes)
    .replace(/\r\n/g, "\n")
    .trimEnd();
}

function mimeType(contentTypeValue: string): string {
  return (contentTypeValue.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * The human-readable text of a frame.
 *
 * A flat frame's text is simply the bytes after its header section. A multipart
 * frame's is NOT: those bytes are the MIME envelope — boundary delimiters, per-
 * part headers, and every alternative representation including `text/html`.
 * Externally delivered mail is nearly always multipart, so returning the raw
 * envelope put MIME soup in every snippet and handed raw markup to detail
 * readers.
 *
 * Multipart frames expose their readable text at MIME path `1`, or at `1.1`
 * when part 1 is itself multipart (a signed or mixed envelope wrapping an
 * alternative set). The walk is delegated to `@intx/mime`'s `extractPartByPath`
 * / `parseMimePart` rather than hand-rolled — upstream already owns boundary
 * and part parsing.
 *
 * A multipart frame whose body cannot be walked yields `""`. That is a
 * deliberate degrade, not a swallowed error: the read path must serve such a
 * row as a 200 with no body, and surfacing the undelimited envelope bytes
 * instead would be the very regression this function exists to prevent.
 */
function extractFrameBody(
  raw: Uint8Array,
  headers: Map<string, string>,
  bodyOffset: number,
): string {
  if (!mimeType(headers.get("content-type") ?? "").startsWith("multipart/")) {
    return normalizeMailText(raw.subarray(bodyOffset));
  }
  try {
    const part1 = parseMimePart(extractPartByPath(raw, "1"));
    const bodyBytes = mimeType(part1.contentType).startsWith("multipart/")
      ? parseMimePart(extractPartByPath(raw, "1.1")).body
      : part1.body;
    return normalizeMailText(bodyBytes);
  } catch {
    return "";
  }
}

// A stored frame whose header section @intx/mime rejects is an expected
// case: the read path degrades to cached columns rather than failing the
// whole read for one malformed row.
export function decodeMailFrame(raw: Uint8Array): DecodedFrame | null {
  let parsed: { headers: Map<string, string>; bodyOffset: number };
  try {
    parsed = parseHeaderSection(raw);
  } catch {
    return null;
  }
  return {
    headers: parsed.headers,
    body: extractFrameBody(raw, parsed.headers, parsed.bodyOffset),
    messageId: parsed.headers.get("message-id") ?? null,
    inReplyTo: parsed.headers.get("in-reply-to") ?? null,
    references: parseMsgIdList(parsed.headers.get("references")),
  };
}
