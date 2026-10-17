// /admin/custody keeps its request queues current (F085) without a wallet
// prompt, says what really went wrong when a queue did not load (F199), reads
// each row's vault on its own with a cut-off and a retry (F203), shows a
// disabled Confirm's reason (F200) and the registry resolving as loading, not
// as an error (F205).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSessionReadAction } from "@/lib/siws-session";
import { custodyPageSource, topLevelFunction } from "./admin-custody-source";

const page = custodyPageSource();
const functionSource = (name: string) => topLevelFunction(page, name);

describe("refresh and polling (F085)", () => {
  it("both queues have a Refresh button and poll in the background", () => {
    for (const name of ["ConversionRequestsSection", "DeliveryRequestsSection"]) {
      const src = functionSource(name);
      expect(src).toContain("<QueueRefreshButton");
      expect(src).toContain("useQueuePolling({");
      expect(src).toContain('const backgroundRefresh = useCallback(() => load("background"), [load]);');
      expect(src).toContain("busy: tx.isSending || outcomeRecovery.busy ||");
      // Only the latest list read commits; a failed background read keeps the rows.
      expect(src).toContain("const current = listGate.begin();");
      expect(src).toContain('if (!current() || mode === "background") return;');
    }
  });

  it("a timer or a tab shown again reads with the session only, never a prompt", () => {
    // The background reads go through the lib readers (lib/conversion.ts, lib/delivery.ts)
    // told never to prompt; the operator's own click may start the session once.
    expect(page).toContain("await adminListConversionRequests(conn.wallet, undefined, { interactive: false })");
    expect(page).toContain("await adminListDeliveryRequests(conn.wallet, undefined, undefined, { interactive: false })");
    expect(page).not.toContain("QueueInBackground(");
    for (const action of ["conversion.adminList", "delivery.adminList"]) {
      expect(isSessionReadAction(action), action).toBe(true);
    }
    const poll = functionSource("useQueuePolling");
    expect(poll).toContain('document.addEventListener("visibilitychange", onVisibility);');
    expect(poll).toContain('if (document.visibilityState !== "visible" || busy) return;');
    expect(poll).toContain('if (reason === "poll" && !live) return;');
    expect(page).toContain("const QUEUE_POLL_MS = 30_000;");
    expect(page).toContain("const QUEUE_MIN_GAP_MS = 10_000;");
  });
});

describe("the load banner (F199)", () => {
  it("asks for a signature only for a missing, declined or expired session; otherwise the real error with Retry", () => {
    const classify = functionSource("queueLoadFailure");
    expect(classify).toContain("err instanceof WalletSessionRequiredError");
    expect(classify).toContain("code === 4001");
    for (const name of ["ConversionRequestsSection", "DeliveryRequestsSection"]) {
      const src = functionSource(name);
      const session = src.indexOf('loadError.kind === "session" ? (');
      expect(session, name).toBeGreaterThan(-1);
      expect(src.indexOf("Sign to load")).toBeGreaterThan(session);
      const real = src.indexOf("{loadError.message}");
      expect(real).toBeGreaterThan(session);
      expect(src.indexOf("Retry\n", real)).toBeGreaterThan(real);
    }
  });
});

describe("per-row vault reads (F203)", () => {
  it("reads each vault on its own, cut off after 10 s, stores it as it arrives and never lets an older read win", () => {
    expect(page).toContain("const VAULT_READ_TIMEOUT_MS = 10_000;");
    const read = functionSource("readVaultOnChainInfo");
    expect(read).toContain("abortSignal: AbortSignal,");
    expect(read).toContain("fetchMaybeLiveCustodyVault(rpc, vaultPda, { abortSignal })");
    expect(read).toContain("loadBeneficiaryPassport(rpc, v, undefined, { abortSignal })");
    const hook = functionSource("useRequestVaultInfo");
    expect(hook).toContain("AbortSignal.timeout(VAULT_READ_TIMEOUT_MS)");
    expect(hook).toContain("const fresh = () => generation.current.get(pda) === gen;");
    expect(hook).toContain("setVaultInfo((prev) => new Map(prev).set(pda, info));");
    expect(hook).not.toContain("setVaultInfo(new Map(entries))");
    for (const name of ["ConversionRequestsSection", "DeliveryRequestsSection"]) {
      const src = functionSource(name);
      expect(src).toContain("useRequestVaultInfo()");
      // The retry re-reads that one row, not the whole queue.
      expect(src).toContain("onRetry={() => void loadVaultInfo(liveRequestVaults([r]))}");
      expect(src).not.toContain("loadVaultInfo(requests)");
    }
    // The vault facts are read once per burn and shared with the KYC accounts.
    expect(page).not.toContain("requestRealizeKycAccounts");
    expect(page.match(/fetchVerifiedCustodyVault\(client\.runtime\.rpc, vaultPda\)/g)).toHaveLength(2);
    expect(page.match(/custodyAuthorityRecordFor\(vault\)/g)).toHaveLength(2);
  });

  it("the no-deposit cancel reads the vault right before sending and refuses a deposited escrow", () => {
    const src = functionSource("ConversionRequestsSection");
    const cancel = src.slice(src.indexOf("async function cancelNoDeposit("), src.indexOf("\n  return ("));
    expect(cancel).toContain("live.data.deposited > BigInt(0)");
    expect(cancel).toContain("The holder has deposited — refresh the queue and use Cancel & return.");
    expect(cancel).not.toContain("vaultInfo.get(req.vault_pda)");
  });
});

describe("why a button is disabled (F200, F205)", () => {
  it("the confirm dialog asks for a reason before the operator types", () => {
    const modal = readFileSync(join(process.cwd(), "components/confirm-modal.tsx"), "utf8");
    expect(modal).toContain("{!reasonOk && (");
    expect(modal).not.toContain("{!reasonOk && reason.length > 0 && (");
    expect(modal).toContain("`Enter a reason (at least ${reasonMinLength} characters).`");
    expect(modal).toContain("`At least ${reasonMinLength} characters.`");
  });

  it("the registry resolving is shown as loading, in slate with a spinner; red is for a real error only", () => {
    const line = functionSource("PinnedRegistryLine");
    const resolving = line.indexOf("Resolving the platform KYC registry…");
    expect(resolving).toBeGreaterThan(-1);
    expect(line.lastIndexOf("animate-spin", resolving)).toBeGreaterThan(-1);
    expect(line.lastIndexOf("text-slate-500", resolving)).toBeGreaterThan(line.lastIndexOf("text-red-600", resolving));
    expect(line).toContain('<p className="mt-1 text-red-600" role="alert">\n          {error}');
    expect(line).not.toContain('{error ?? "Resolving');
  });
});
