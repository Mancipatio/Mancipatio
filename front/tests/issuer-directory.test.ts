// lib/issuer-directory (/admin/issuers): the review-queue order, the status
// chip counts, the KYB dossier link, and the KYB-decision reconciliation that
// keeps a just-decided row from "staying pending" while the indexer lags.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KybStatus } from "@/lib/generated/asset_registry";
import { toBytes32 } from "@/lib/format";
import {
  ADMIN_BADGES_REFRESH_EVENT,
  applyKybOverrides,
  compareForReview,
  decisionStatus,
  filterIssuers,
  issuerLegalId,
  issuerStatusCounts,
  KYB_RECONCILE_ATTEMPTS,
  KYB_RECONCILE_INTERVAL_MS,
  kybDecisionPreflight,
  kybDossierHref,
  listAgrees,
  markChainOnly,
  matchesStatus,
  reconciledStatus,
  requestAdminBadgesRefresh,
  startKybReconcile,
  statusChipLabel,
  unsettledOverrides,
  type DirectoryIssuer,
  type KybOverrides,
} from "@/lib/issuer-directory";

const WALLET_A = "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS";
const WALLET_B = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function issuer(
  name: string,
  kybStatus: KybStatus,
  authority = `${name}-wallet`,
  jurisdiction = 688,
): DirectoryIssuer {
  return { legalEntityId: toBytes32(name), authority, jurisdiction, kybStatus };
}

const names = (list: readonly DirectoryIssuer[]) => list.map(issuerLegalId);

describe("review-queue order and filters", () => {
  const list = [
    issuer("Delta", KybStatus.Verified),
    issuer("Bravo", KybStatus.Pending),
    issuer("Alpha", KybStatus.Rejected),
    issuer("Charlie", KybStatus.Pending),
    issuer("Echo", KybStatus.Suspended),
  ];

  it("lists pending KYB first, then by name", () => {
    expect(names([...list].sort(compareForReview))).toEqual([
      "Bravo",
      "Charlie",
      "Alpha",
      "Delta",
      "Echo",
    ]);
    expect(names(filterIssuers(list, { query: "", status: "all" }))).toEqual([
      "Bravo",
      "Charlie",
      "Alpha",
      "Delta",
      "Echo",
    ]);
  });

  it("breaks a name tie by authority, so the order is stable", () => {
    const twins = [issuer("Same", KybStatus.Pending, "zzz"), issuer("Same", KybStatus.Pending, "aaa")];
    expect(twins.sort(compareForReview).map((i) => i.authority)).toEqual(["aaa", "zzz"]);
  });

  it("filters by status chip and by name, wallet or jurisdiction", () => {
    expect(names(filterIssuers(list, { query: "", status: "pending" }))).toEqual(["Bravo", "Charlie"]);
    expect(names(filterIssuers(list, { query: "", status: "verified" }))).toEqual(["Delta"]);
    expect(names(filterIssuers(list, { query: "  cHaR ", status: "all" }))).toEqual(["Charlie"]);
    expect(names(filterIssuers(list, { query: "echo-wallet", status: "all" }))).toEqual(["Echo"]);
    const withUk = [...list, issuer("Foxtrot", KybStatus.Pending, WALLET_A, 826)];
    expect(names(filterIssuers(withUk, { query: "826", status: "all" }))).toEqual(["Foxtrot"]);
  });

  it("keeps the open row under the status chip after its status changed, not past the query", () => {
    const decided = list.map((i) =>
      issuerLegalId(i) === "Bravo" ? { ...i, kybStatus: KybStatus.Verified } : i,
    );
    expect(names(filterIssuers(decided, { query: "", status: "pending" }))).toEqual(["Charlie"]);
    expect(
      names(filterIssuers(decided, { query: "", status: "pending", keepLegalId: "Bravo" })),
    ).toEqual(["Charlie", "Bravo"]);
    expect(
      names(filterIssuers(decided, { query: "charlie", status: "pending", keepLegalId: "Bravo" })),
    ).toEqual(["Charlie"]);
  });

  it("matches every row under All and only its own chip otherwise", () => {
    const pending = issuer("P", KybStatus.Pending);
    expect(matchesStatus(pending, "all")).toBe(true);
    expect(matchesStatus(pending, "pending")).toBe(true);
    expect(matchesStatus(pending, "verified")).toBe(false);
  });
});

describe("status chips", () => {
  it("counts each status and labels the chips, e.g. Pending (7)", () => {
    const list = [
      ...Array.from({ length: 7 }, (_, n) => issuer(`P${n}`, KybStatus.Pending)),
      issuer("V", KybStatus.Verified),
      issuer("R", KybStatus.Rejected),
    ];
    const counts = issuerStatusCounts(list);
    expect(counts).toEqual({ all: 9, pending: 7, verified: 1, rejected: 1, suspended: 0 });
    expect(statusChipLabel("pending", counts)).toBe("Pending (7)");
    expect(statusChipLabel("all", counts)).toBe("All (9)");
    expect(statusChipLabel("suspended", counts)).toBe("Suspended (0)");
  });

  it("shows just the name while the list is loading", () => {
    expect(statusChipLabel("pending", null)).toBe("Pending");
    expect(statusChipLabel("all", null)).toBe("All");
  });
});

describe("KYB dossier link", () => {
  it("opens the client search seeded with the authority (applicant) wallet", () => {
    expect(kybDossierHref(WALLET_A)).toBe(`/admin/clients?q=${WALLET_A}`);
    expect(kybDossierHref("a b&c")).toBe("/admin/clients?q=a%20b%26c");
  });

  it("targets a search that is seeded from ?q= and matches wallets", () => {
    // The link is only useful while /admin/clients keeps both behaviors.
    const source = readFileSync(join(__dirname, "../app/admin/clients/page.tsx"), "utf8");
    expect(source).toMatch(/searchParams\.get\("q"\)/);
    expect(source).toMatch(/\(r\.wallet \?\? ""\)\.toLowerCase\(\)\.includes\(q\)/);
  });
});

describe("KYB decision guards", () => {
  it("sends a decision only while the live chain record is still pending", () => {
    expect(kybDecisionPreflight({ kybStatus: KybStatus.Pending })).toEqual({ ok: true });
    expect(kybDecisionPreflight({ kybStatus: KybStatus.Verified })).toEqual({
      ok: false,
      status: KybStatus.Verified,
      message: "Already verified on chain",
    });
    expect(kybDecisionPreflight({ kybStatus: KybStatus.Rejected })).toEqual({
      ok: false,
      status: KybStatus.Rejected,
      message: "Already rejected on chain",
    });
    expect(kybDecisionPreflight(null)).toEqual({
      ok: false,
      status: null,
      message: "Issuer account not found on chain.",
    });
  });

  it("maps approve / reject to the status verify_issuer_kyb sets", () => {
    expect(decisionStatus(true)).toBe(KybStatus.Verified);
    expect(decisionStatus(false)).toBe(KybStatus.Rejected);
  });

  it("trusts a post-decision chain read unless it is lagging (still Pending) or failed", () => {
    expect(reconciledStatus(KybStatus.Verified, KybStatus.Verified)).toBe(KybStatus.Verified);
    expect(reconciledStatus(KybStatus.Verified, KybStatus.Pending)).toBe(KybStatus.Verified);
    expect(reconciledStatus(KybStatus.Verified, null)).toBe(KybStatus.Verified);
    // A concurrent opposite decision is the chain's truth.
    expect(reconciledStatus(KybStatus.Verified, KybStatus.Rejected)).toBe(KybStatus.Rejected);
  });
});

describe("KYB overrides until the indexer agrees", () => {
  const indexed = [issuer("Acme", KybStatus.Pending, WALLET_A), issuer("Beta", KybStatus.Pending, WALLET_B)];

  it("shows the decided status on the row without touching the loaded list", () => {
    const overrides: KybOverrides = { Acme: { status: KybStatus.Verified, phase: "syncing" } };
    const shown = applyKybOverrides(indexed, overrides);
    expect(shown.map((i) => i.kybStatus)).toEqual([KybStatus.Verified, KybStatus.Pending]);
    expect(indexed[0].kybStatus).toBe(KybStatus.Pending);
    expect(shown[1]).toBe(indexed[1]);
    expect(issuerStatusCounts(shown).pending).toBe(1);
  });

  it("drops an override once the list agrees (or the issuer is gone) and keeps the rest", () => {
    const overrides: KybOverrides = {
      Acme: { status: KybStatus.Verified, phase: "syncing" },
      Beta: { status: KybStatus.Rejected, phase: "chain" },
      Gone: { status: KybStatus.Verified, phase: "syncing" },
    };
    const caughtUp = [issuer("Acme", KybStatus.Verified, WALLET_A), issuer("Beta", KybStatus.Pending, WALLET_B)];
    expect(unsettledOverrides(caughtUp, overrides)).toEqual({
      Beta: { status: KybStatus.Rejected, phase: "chain" },
    });
  });

  it("returns the same object when nothing settled (no re-render)", () => {
    const overrides: KybOverrides = { Acme: { status: KybStatus.Verified, phase: "syncing" } };
    expect(unsettledOverrides(indexed, overrides)).toBe(overrides);
    const none: KybOverrides = {};
    expect(unsettledOverrides(indexed, none)).toBe(none);
  });

  it("marks an override chain-only when the poll gives up", () => {
    const overrides: KybOverrides = { Acme: { status: KybStatus.Verified, phase: "syncing" } };
    expect(markChainOnly(overrides, "Acme")).toEqual({
      Acme: { status: KybStatus.Verified, phase: "chain" },
    });
    expect(markChainOnly(overrides, "Other")).toBe(overrides);
    const chain = markChainOnly(overrides, "Acme");
    expect(markChainOnly(chain, "Acme")).toBe(chain);
  });

  it("the row never reads Pending again while the indexer lags, then the list takes over", () => {
    let overrides: KybOverrides = { Acme: { status: KybStatus.Verified, phase: "syncing" } };
    const loads = [indexed, indexed, [issuer("Acme", KybStatus.Verified, WALLET_A), indexed[1]]];
    for (const list of loads) {
      overrides = unsettledOverrides(list, overrides);
      const acme = applyKybOverrides(list, overrides).find((i) => issuerLegalId(i) === "Acme");
      expect(acme?.kybStatus).toBe(KybStatus.Verified);
    }
    expect(overrides).toEqual({});
    expect(listAgrees(loads[2], "Acme", KybStatus.Verified)).toBe(true);
    expect(listAgrees(indexed, "Acme", KybStatus.Verified)).toBe(false);
  });
});

describe("startKybReconcile (bounded indexer poll)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const lagging = [issuer("Acme", KybStatus.Pending)];
  const caughtUp = [issuer("Acme", KybStatus.Verified)];

  it("re-loads every interval until the list agrees, then stops", async () => {
    let calls = 0;
    const load = vi.fn(async () => (++calls >= 3 ? caughtUp : lagging));
    const onAgree = vi.fn();
    const onGiveUp = vi.fn();
    startKybReconcile({ legalId: "Acme", status: KybStatus.Verified, load, onAgree, onGiveUp });
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(KYB_RECONCILE_INTERVAL_MS * 2);
    expect(load).toHaveBeenCalledTimes(2);
    expect(onAgree).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(KYB_RECONCILE_INTERVAL_MS);
    expect(onAgree).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(KYB_RECONCILE_INTERVAL_MS * 10);
    expect(load).toHaveBeenCalledTimes(3);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it("gives up after one minute (a failed load counts as not yet) and says so once", async () => {
    expect(KYB_RECONCILE_INTERVAL_MS * KYB_RECONCILE_ATTEMPTS).toBe(60_000);
    let calls = 0;
    const load = vi.fn(async () => {
      calls += 1;
      if (calls % 2 === 0) throw new Error("indexer down");
      return lagging;
    });
    const onAgree = vi.fn();
    const onGiveUp = vi.fn();
    startKybReconcile({ legalId: "Acme", status: KybStatus.Verified, load, onAgree, onGiveUp });
    await vi.advanceTimersByTimeAsync(KYB_RECONCILE_INTERVAL_MS * (KYB_RECONCILE_ATTEMPTS + 5));
    expect(load).toHaveBeenCalledTimes(KYB_RECONCILE_ATTEMPTS);
    expect(onAgree).not.toHaveBeenCalled();
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it("stop (a new decision or unmount) cancels it, even with a load in flight", async () => {
    let release: (list: readonly DirectoryIssuer[]) => void = () => undefined;
    const load = vi.fn(
      () => new Promise<readonly DirectoryIssuer[]>((resolve) => (release = resolve)),
    );
    const onAgree = vi.fn();
    const onGiveUp = vi.fn();
    const stop = startKybReconcile({ legalId: "Acme", status: KybStatus.Verified, load, onAgree, onGiveUp });
    await vi.advanceTimersByTimeAsync(KYB_RECONCILE_INTERVAL_MS);
    expect(load).toHaveBeenCalledTimes(1);
    stop();
    release(caughtUp);
    await vi.advanceTimersByTimeAsync(KYB_RECONCILE_INTERVAL_MS * 20);
    expect(load).toHaveBeenCalledTimes(1);
    expect(onAgree).not.toHaveBeenCalled();
    expect(onGiveUp).not.toHaveBeenCalled();
  });
});

describe("admin badge refresh", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dispatches admin:badges-refresh on window", () => {
    const target = new EventTarget();
    const heard = vi.fn();
    target.addEventListener(ADMIN_BADGES_REFRESH_EVENT, heard);
    vi.stubGlobal("window", target);
    requestAdminBadgesRefresh();
    expect(ADMIN_BADGES_REFRESH_EVENT).toBe("admin:badges-refresh");
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("is a no-op without a window (server render)", () => {
    expect(typeof window).toBe("undefined");
    expect(() => requestAdminBadgesRefresh()).not.toThrow();
  });
});
