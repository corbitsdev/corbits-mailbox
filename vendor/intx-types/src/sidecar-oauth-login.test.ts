// CL-7508 local delta: parse/reject tests for the oauth.login.start /
// oauth.login.result frame pair the sidecar ws channel threads (see the
// `vendor/intx/types` ledger row).
import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  HubFrame,
  OAuthLoginCancelFrame,
  OAuthLoginResultFrame,
  OAuthLoginStartFrame,
  SidecarFrame,
} from "./sidecar";

describe("oauth.login.start frame", () => {
  test("parses a well-formed hub request", () => {
    const frame = {
      type: "oauth.login.start",
      requestId: "req_1",
      connectorId: "codex",
    };
    expect(OAuthLoginStartFrame(frame)).not.toBeInstanceOf(type.errors);
    expect(HubFrame(frame)).not.toBeInstanceOf(type.errors);
  });

  test("accepts every loopback connector id and nothing else", () => {
    expect(
      OAuthLoginStartFrame({
        type: "oauth.login.start",
        requestId: "r",
        connectorId: "xai-oauth",
      }),
    ).not.toBeInstanceOf(type.errors);
    expect(
      OAuthLoginStartFrame({
        type: "oauth.login.start",
        requestId: "r",
        connectorId: "github",
      }),
    ).toBeInstanceOf(type.errors);
  });

  test("rejects a missing requestId", () => {
    expect(
      OAuthLoginStartFrame({ type: "oauth.login.start", connectorId: "codex" }),
    ).toBeInstanceOf(type.errors);
  });

  test("parses the cancel frame the hub sends on timeout", () => {
    const frame = { type: "oauth.login.cancel", requestId: "req_1" };
    expect(OAuthLoginCancelFrame(frame)).not.toBeInstanceOf(type.errors);
    expect(HubFrame(frame)).not.toBeInstanceOf(type.errors);
    expect(
      OAuthLoginCancelFrame({ type: "oauth.login.cancel" }),
    ).toBeInstanceOf(type.errors);
  });
});

describe("oauth.login.result frame", () => {
  test("parses the started arm with its authorize URL", () => {
    const frame = {
      type: "oauth.login.result",
      requestId: "req_1",
      outcome: { status: "started", authorizeUrl: "https://auth.example/authorize?x=1" },
    };
    expect(OAuthLoginResultFrame(frame)).not.toBeInstanceOf(type.errors);
    expect(SidecarFrame(frame)).not.toBeInstanceOf(type.errors);
  });

  test("parses the completed arm with tokens", () => {
    const frame = {
      type: "oauth.login.result",
      requestId: "req_1",
      outcome: {
        status: "completed",
        tokens: {
          access: "at",
          refresh: "rt",
          expiresAt: 123,
          idToken: "idt",
          accountId: "acc",
        },
      },
    };
    expect(OAuthLoginResultFrame(frame)).not.toBeInstanceOf(type.errors);
  });

  test("parses the error arm", () => {
    expect(
      OAuthLoginResultFrame({
        type: "oauth.login.result",
        requestId: "req_1",
        outcome: { status: "error", message: "port in use" },
      }),
    ).not.toBeInstanceOf(type.errors);
  });

  test("rejects a completed arm without tokens", () => {
    expect(
      OAuthLoginResultFrame({
        type: "oauth.login.result",
        requestId: "req_1",
        outcome: { status: "completed" },
      }),
    ).toBeInstanceOf(type.errors);
  });

  test("rejects an unknown outcome status", () => {
    expect(
      OAuthLoginResultFrame({
        type: "oauth.login.result",
        requestId: "req_1",
        outcome: { status: "pending" },
      }),
    ).toBeInstanceOf(type.errors);
  });
});
