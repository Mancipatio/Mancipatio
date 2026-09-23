import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { CLOSED_ACCOUNT_TAG as FRONT_TAG } from "@/lib/closed-account";
import {
  CLOSED_ACCOUNT_TAG,
  isRegistryTombstone,
} from "../scripts/ops/closed-account-tag.mjs";

describe("2D tombstone in the rollout inventory", () => {
  it("uses the program's CLOSED_ACCOUNT_TAG", () => {
    const constants = readFileSync(
      join(process.cwd(), "../program/programs/asset_registry/src/constants.rs"),
      "utf8",
    );
    const tag = /CLOSED_ACCOUNT_TAG: \[u8; 8\] = \*b"([^"]{8})"/.exec(constants)?.[1];
    expect(tag).toBe("CLOSED__");
    expect(Buffer.from(CLOSED_ACCOUNT_TAG).toString("utf8")).toBe(tag);
    expect(Array.from(CLOSED_ACCOUNT_TAG)).toEqual(Array.from(FRONT_TAG));
  });

  it("recognises only an 8-byte registry-owned tombstone", () => {
    const tag = Buffer.from("CLOSED__");
    const registry = ASSET_REGISTRY_PROGRAM_ADDRESS;
    expect(isRegistryTombstone(registry, registry, tag)).toBe(true);
    expect(isRegistryTombstone("Other1111111111111111111111111111", registry, tag)).toBe(false);
    expect(isRegistryTombstone(registry, registry, Buffer.concat([tag, Buffer.from([0])]))).toBe(false);
    expect(isRegistryTombstone(registry, registry, Buffer.from("CLOSED_X"))).toBe(false);
  });

  it("the inventory records a tombstone as a known row, before the blocker branch", () => {
    const script = readFileSync(
      join(process.cwd(), "scripts/ops/devnet-rollout-inventory.mjs"),
      "utf8",
    );
    const decode = script.slice(script.indexOf("function decodeAccount("));
    const tombstone = decode.indexOf("isRegistryTombstone(account.owner, IDS.asset_registry, account.data)");
    expect(tombstone).toBeGreaterThan(0);
    expect(tombstone).toBeLessThan(decode.indexOf("Unknown ${programName} account layout"));
    expect(decode.slice(tombstone, tombstone + 400)).toMatch(/type: 'Tombstone'[\s\S]*return;/);
  });
});
