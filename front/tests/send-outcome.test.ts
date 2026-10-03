// #56 lows (S9): a send is reported only after the network's answer. The
// success toast and the audit row wait for the confirmation, and the page's
// refresh comes after them (lib/send-outcome confirmThenReport) — for the
// single send (ShareTransferPanel), the treasury mint (lib/treasury-mint,
// TreasuryMintPanel) and the distribution.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateKeyPairSigner, type Address } from "@solana/kit";
import { confirmThenReport } from "@/lib/send-outcome";
import { buildTreasuryMintIxs, parseUsdPerToken, treasuryMintEur } from "@/lib/treasury-mint";
import { sentSize } from "@/lib/distribution-plan";
import { PAUSE_PRIMARY } from "@/lib/pause-flags";
import { findAdminRecordPda } from "@/lib/generated/asset_registry";

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("confirmThenReport", () => {
  it("reports only after the wait resolves, then settles (refresh)", async () => {
    const order: string[] = [];
    let release!: (v: "confirmed") => void;
    const wait = () =>
      new Promise<"confirmed">((resolve) => {
        order.push("wait");
        release = resolve;
      });
    const done = confirmThenReport(wait, {
      confirmed: () => void order.push("toast+audit success"),
      failed: () => void order.push("failed"),
      unconfirmed: () => void order.push("unconfirmed"),
      settled: async () => void order.push("refresh"),
    });
    await Promise.resolve();
    expect(order).toEqual(["wait"]);
    release("confirmed");
    expect(await done).toBe("confirmed");
    expect(order).toEqual(["wait", "toast+audit success", "refresh"]);
  });

  it("a refused or unconfirmed send is reported as such, and a failing refresh never hides the report", async () => {
    const order: string[] = [];
    const report = {
      confirmed: () => void order.push("confirmed"),
      failed: () => void order.push("failed"),
      unconfirmed: (o: string) => void order.push(`unconfirmed:${o}`),
      settled: async () => {
        order.push("refresh");
        throw new Error("refresh failed");
      },
    };
    expect(await confirmThenReport(async () => "failed", report)).toBe("failed");
    expect(await confirmThenReport(async () => "timeout", report)).toBe("timeout");
    expect(await confirmThenReport(async () => "unknown", report)).toBe("unknown");
    expect(order).toEqual(["failed", "refresh", "unconfirmed:timeout", "refresh", "unconfirmed:unknown", "refresh"]);
  });

  it("the panels use it: toast and audit after the confirmation, refresh after the report", () => {
    const transfer = src("components/share-transfer-panel.tsx");
    const body = transfer.slice(transfer.indexOf("await confirmThenReport("));
    expect(body.indexOf("waitForSignature(rpc, sig")).toBeGreaterThan(-1);
    expect(body.indexOf('audit("success", sig)')).toBeGreaterThan(body.indexOf("confirmed: () => {"));
    expect(body.indexOf("await onSent?.()")).toBeGreaterThan(body.indexOf("settled: async () => {"));
    expect(transfer.indexOf("await confirmThenReport(")).toBeGreaterThan(transfer.indexOf("sig = await tx.send("));

    const mint = src("lib/treasury-mint.ts");
    expect(mint.indexOf("confirmThenReport(() => waitForSignature(rpc, sig")).toBeGreaterThan(mint.indexOf("signature = await input.send("));
    expect(mint).toContain('confirmed: () => void audit("success")');

    // Review (#56): the mint panel refreshed right after submission; now after runTreasuryMint's confirmation.
    const panel = src("components/treasury-mint-panel.tsx");
    const run = panel.indexOf("const result = await runTreasuryMint({");
    expect(run).toBeGreaterThan(-1);
    expect(panel.indexOf("await onRefresh()")).toBeGreaterThan(run);
    expect(panel.indexOf('result.outcome === "confirmed"')).toBeGreaterThan(run);
    expect(panel.indexOf('toast.showTx(result.signature, { title: "Minted to treasury" })')).toBeGreaterThan(run);
  });
});

describe("the treasury mint transaction (S4)", () => {
  async function build(repause: boolean) {
    const signer = await generateKeyPairSigner();
    const addr = async () => (await generateKeyPairSigner()).address as Address;
    return {
      signer,
      ...(await buildTreasuryMintIxs({
        signer,
        issuerPda: await addr(),
        asset: await addr(),
        scPda: await addr(),
        mint: await addr(),
        amount: BigInt(157),
        // An Admin issuer key's proof is its Admin record, the same account set_pause_flags reads.
        adminRecord: (await findAdminRecordPda({ authority: signer.address }))[0],
        repause,
      })),
    };
  }

  it("is one transaction: create the treasury account, mint, then close Primary issuance again (626 B)", async () => {
    const { signer, instructions } = await build(true);
    expect(instructions).toHaveLength(3);
    const [ata, mint, pause] = instructions;
    expect(ata.programAddress).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    expect(mint.programAddress).toBe(pause.programAddress);
    // set_pause_flags(set 0x02, clear 0): after the mint, which reads 0x02 when it runs.
    expect(Array.from(pause.data!.slice(8))).toEqual([PAUSE_PRIMARY, 0]);
    expect(sentSize(signer.address, instructions)).toBe(626);
    expect((await build(false)).instructions).toHaveLength(2);
  });

  it("values the created tokens: units × USD per token × the USDC rate, rounded up to the cent, at least €1", () => {
    expect(treasuryMintEur({ units: BigInt(157), usdPerTokenE6: BigInt(10_000_000), eurPerUsdc: 0.86 })).toBe(1350.2);
    expect(treasuryMintEur({ units: BigInt(7), usdPerTokenE6: BigInt(1_234_567), eurPerUsdc: 0.86 })).toBe(7.44);
    expect(treasuryMintEur({ units: BigInt(1), usdPerTokenE6: BigInt(333_333), eurPerUsdc: 0.9 })).toBe(1);
    expect(() => treasuryMintEur({ units: BigInt(1), usdPerTokenE6: BigInt(1), eurPerUsdc: 0 })).toThrow(/rate/);
  });

  it("reads the one 'Value per token (USD)' field strictly", () => {
    expect(parseUsdPerToken("10")).toBe(BigInt(10_000_000));
    expect(parseUsdPerToken("$0.5")).toBe(BigInt(500_000));
    expect(parseUsdPerToken("1.234567")).toBe(BigInt(1_234_567));
    for (const bad of ["", "0", "1.2345678", "1,5", "abc", "-1"]) expect(parseUsdPerToken(bad), bad).toBeNull();
  });
});
