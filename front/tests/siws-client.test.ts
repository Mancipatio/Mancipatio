// lib/siws-client.ts — canonical JSON + message construction. The server
// (lib/server/siws.ts) rebuilds the signed bytes with these exact helpers,
// so the canonical form must stay byte-stable: these tests pin it.
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  SIWS_MAX_AGE_MS,
  SIWS_MESSAGE_PREFIX,
  siwsMessage,
  type SiwsPayload,
} from "@/lib/siws-client";

describe("canonicalJson", () => {
  it("serializes primitives like JSON.stringify", () => {
    expect(canonicalJson(1)).toBe("1");
    expect(canonicalJson("a\"b")).toBe('"a\\"b"');
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(undefined)).toBe("null"); // top-level undefined → null
  });

  it("sorts object keys recursively with no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it("is key-order independent (the whole point)", () => {
    const x = { wallet: "W", action: "a", params: { z: 1, a: 2 } };
    const y = { params: { a: 2, z: 1 }, action: "a", wallet: "W" };
    expect(canonicalJson(x)).toBe(canonicalJson(y));
  });

  it("drops undefined object values but nulls undefined array elements", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson([1, undefined, 2])).toBe("[1,null,2]");
  });

  it("preserves array element order (arrays are not sorted)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("handles nested arrays of objects", () => {
    expect(canonicalJson({ list: [{ b: 1, a: 2 }] })).toBe('{"list":[{"a":2,"b":1}]}');
  });
});

describe("siwsMessage", () => {
  const payload: SiwsPayload = {
    v: 2,
    origin: "https://mancipatio.test",
    network: "devnet",
    action: "clients.create",
    wallet: "11111111111111111111111111111111",
    ts: "2026-07-20T00:00:00.000Z",
    nonce: "8e7a1b2c-0000-4000-8000-000000000001",
    params: { note: "hi", amount: "1000" },
  };

  it("matches the hand-computed known vector exactly", () => {
    // Keys sorted: action, network, nonce, origin, params, ts, v, wallet.
    expect(siwsMessage(payload)).toBe(
      "mancipatio:v2:" +
        '{"action":"clients.create",' +
        '"network":"devnet",' +
        '"nonce":"8e7a1b2c-0000-4000-8000-000000000001",' +
        '"origin":"https://mancipatio.test",' +
        '"params":{"amount":"1000","note":"hi"},' +
        '"ts":"2026-07-20T00:00:00.000Z",' +
        '"v":2,' +
        '"wallet":"11111111111111111111111111111111"}',
    );
  });

  it("is deterministic across calls", () => {
    expect(siwsMessage(payload)).toBe(siwsMessage(payload));
  });

  it("uses the exported prefix (server pins the same constant)", () => {
    expect(SIWS_MESSAGE_PREFIX).toBe("mancipatio:v2:");
    expect(siwsMessage(payload).startsWith(SIWS_MESSAGE_PREFIX)).toBe(true);
  });

  it("changes when any signed field changes", () => {
    const base = siwsMessage(payload);
    expect(siwsMessage({ ...payload, nonce: "other" })).not.toBe(base);
    expect(siwsMessage({ ...payload, origin: "https://another.test" })).not.toBe(base);
    expect(siwsMessage({ ...payload, network: "mainnet" })).not.toBe(base);
    expect(siwsMessage({ ...payload, params: { note: "hi", amount: "1001" } })).not.toBe(base);
  });
});

describe("protocol constants", () => {
  it("keeps the ±300s replay window the server enforces", () => {
    expect(SIWS_MAX_AGE_MS).toBe(300_000);
  });
});
