import { describe, expect, test } from "bun:test";
import { decodeMailFrame } from "./frame.js";

// Externally delivered mail is nearly always multipart, so these frames are
// the common case on the read path, not an exotic one. The hub behavior spec
// (`extractConversationBodyFromRaw`) walks MIME paths `1` and `1.1`; this
// package returned every byte after the header section instead, which put the
// boundary delimiters, the part headers and the raw `text/html` alternative
// into both the snippet and the detail body.
function frame(lines: string[]): Uint8Array {
  return new TextEncoder().encode(lines.join("\r\n"));
}

const ALTERNATIVE = frame([
  "From: sender@example.com",
  "To: user@example.com",
  "Subject: Multipart hello",
  "Message-ID: <mp@example.com>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="BOUND"',
  "",
  "--BOUND",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello human, this is the readable text.",
  "--BOUND",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Hello human</p>",
  "--BOUND--",
  "",
]);

const NESTED = frame([
  "From: sender@example.com",
  "To: user@example.com",
  "Subject: Nested",
  'Content-Type: multipart/mixed; boundary="OUT"',
  "",
  "--OUT",
  'Content-Type: multipart/alternative; boundary="IN"',
  "",
  "--IN",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Nested readable text.",
  "--IN",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Nested</p>",
  "--IN--",
  "--OUT--",
  "",
]);

describe("decodeMailFrame body extraction", () => {
  test("multipart/alternative yields the text/plain part, not the MIME envelope", () => {
    const decoded = decodeMailFrame(ALTERNATIVE);
    expect(decoded).not.toBeNull();
    expect(decoded!.body).toBe("Hello human, this is the readable text.");
    expect(decoded!.body).not.toContain("--BOUND");
    expect(decoded!.body).not.toContain("Content-Type:");
    expect(decoded!.body).not.toContain("<p>");
  });

  test("nested multipart resolves through MIME path 1.1", () => {
    const decoded = decodeMailFrame(NESTED);
    expect(decoded).not.toBeNull();
    expect(decoded!.body).toBe("Nested readable text.");
  });

  test("headers still come from the frame's own header section", () => {
    const decoded = decodeMailFrame(ALTERNATIVE);
    expect(decoded!.headers.get("subject")).toBe("Multipart hello");
    expect(decoded!.headers.get("message-id")).toBe("<mp@example.com>");
  });

  test("a single-part text/plain frame still returns the bytes after its headers", () => {
    const decoded = decodeMailFrame(
      frame([
        "From: sender@example.com",
        "To: user@example.com",
        "Subject: Flat",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Just a flat body.",
        "",
      ]),
    );
    expect(decoded!.body).toBe("Just a flat body.");
  });

  test("a frame with no Content-Type at all still returns its raw body", () => {
    const decoded = decodeMailFrame(
      frame([
        "From: sender@example.com",
        "To: user@example.com",
        "Subject: No content type",
        "",
        "line one",
        "line two",
        "",
      ]),
    );
    expect(decoded!.body).toBe("line one\nline two");
  });

  test("a multipart frame whose body has no boundary yields an empty body, not MIME soup", () => {
    // Degrades exactly as the spec does: an unparseable multipart body is
    // reported as no body rather than surfacing the undelimited bytes or
    // throwing. The read path's malformed-frame path (200, never 500) rests on
    // this returning rather than raising.
    const decoded = decodeMailFrame(
      frame([
        "From: sender@example.com",
        "To: user@example.com",
        "Subject: Broken",
        'Content-Type: multipart/alternative; boundary="BOUND"',
        "",
        "no boundary delimiter anywhere in this body",
        "",
      ]),
    );
    expect(decoded).not.toBeNull();
    expect(decoded!.body).toBe("");
  });
});
