// lib/send-stage (r2g4-10): the channel every wallet send reports its steps
// on, and the one line the site-wide notice (components/send-progress-notice)
// shows for each. The client's own emissions are covered by
// tests/verified-solana-client.test.ts and tests/verified-batch-send.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { currentSendStage, emitSendStage, onSendStage, sendStageLabel, type SendStage } from "@/lib/send-stage";

afterEach(() => emitSendStage({ kind: "done" }));

describe("the channel", () => {
  it("tells every listener each stage, keeps the current one, and forgets it on done or failed", () => {
    const seen: SendStage[] = [];
    const stop = onSendStage((stage) => seen.push(stage));
    try {
      expect(currentSendStage()).toBeNull();
      emitSendStage({ kind: "checking" });
      expect(currentSendStage()).toEqual({ kind: "checking" });
      emitSendStage({ kind: "waiting-previous", count: 2, maxSeconds: 30 });
      expect(currentSendStage()).toEqual({ kind: "waiting-previous", count: 2, maxSeconds: 30 });
      emitSendStage({ kind: "done" });
      expect(currentSendStage()).toBeNull();
      emitSendStage({ kind: "wallet" });
      emitSendStage({ kind: "failed" });
      expect(currentSendStage()).toBeNull();
    } finally {
      stop();
    }
    expect(seen.map((s) => s.kind)).toEqual(["checking", "waiting-previous", "done", "wallet", "failed"]);
  });

  it("a listener that throws is skipped, the others still told; an unsubscribed one is not", () => {
    const seen: string[] = [];
    const stopThrowing = onSendStage(() => {
      throw new Error("the notice broke");
    });
    const stop = onSendStage((stage) => seen.push(stage.kind));
    try {
      expect(() => emitSendStage({ kind: "testing" })).not.toThrow();
      expect(seen).toEqual(["testing"]);
      stop();
      emitSendStage({ kind: "sending" });
      expect(seen).toEqual(["testing"]);
    } finally {
      stopThrowing();
      stop();
    }
  });
});

describe("the notice's words", () => {
  it.each<[SendStage | null, string | null]>([
    [{ kind: "checking" }, "Checking the network…"],
    [{ kind: "waiting-previous", count: 1, maxSeconds: 30 }, "Waiting for your previous transaction to confirm (up to 30 s)…"],
    [{ kind: "waiting-previous", count: 3, maxSeconds: 30 }, "Waiting for your previous 3 transactions to confirm (up to 30 s)…"],
    [{ kind: "testing" }, "Testing the transaction…"],
    [{ kind: "account" }, "Confirming your account…"],
    [{ kind: "account", signIn: true }, "Confirming your Manci sign-in (a message, not a transaction)…"],
    [{ kind: "wallet" }, "Waiting for your wallet…"],
    [{ kind: "sending" }, "Sending…"],
    [{ kind: "done" }, null],
    [{ kind: "failed" }, null],
    [null, null],
  ])("%j → %s", (stage, label) => {
    expect(sendStageLabel(stage)).toBe(label);
  });

  it("every line is one sentence case phrase ending in an ellipsis, with no exclamation mark", () => {
    const stages: SendStage[] = [
      { kind: "checking" }, { kind: "waiting-previous", count: 1, maxSeconds: 30 }, { kind: "testing" },
      { kind: "account" }, { kind: "account", signIn: true }, { kind: "wallet" }, { kind: "sending" },
    ];
    for (const stage of stages) {
      const label = sendStageLabel(stage)!;
      expect(label).toMatch(/^[A-Z][^!…]*…$/);
    }
  });
});

describe("the notice is mounted once, next to the signing notice, and takes no clicks", () => {
  it("app/providers mounts SendProgressNotice after WalletSigningNotice; the notice is a live region behind the toasts", () => {
    const providers = readFileSync(join(process.cwd(), "app/providers.tsx"), "utf8");
    expect(providers).toMatch(/<WalletSigningNotice \/>\s*<SendProgressNotice \/>/);
    expect(providers.match(/<SendProgressNotice \/>/g)).toHaveLength(1);
    const notice = readFileSync(join(process.cwd(), "components/send-progress-notice.tsx"), "utf8");
    expect(notice).toContain('"use client"');
    expect(notice).toContain("pointer-events-none");
    expect(notice).toContain('role="status"');
    expect(notice).toContain('aria-live="polite"');
    expect(notice).toContain("sendStageLabel(useSendStage())");
    // Under the toasts and the signing notice (z-50) in the stacking order, and never at the bottom with them.
    expect(notice).toMatch(/\bz-40\b/);
    expect(notice).toMatch(/\btop-4\b/);
    expect(notice).not.toMatch(/\bbottom-\d/);
  });
});
