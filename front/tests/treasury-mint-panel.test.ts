// The admin "Mint to treasury" panel (components/treasury-mint-panel.tsx) and
// the declared EUR value it reads (lib/treasury-mint parseDeclaredEur):
//   F003 the room counted from lifetime_minted (a conversion burn never
//        reopens it), refused before any signature and shown as
//        "cap · created so far · at most N more";
//   F047 one mint at a time from the click, the reservation prompt included
//        (a ref, never a state alone), the button saying what it waits for;
//   F046 a mint not confirmed in time clears the form and keeps it disabled
//        until the operator checked the explorer;
//   F054 "1.000" and "1,000" are refused, never read as €1 while the
//        confirmation echoes "€1.000"; the parsed value is echoed instead;
//   F048 KYC-only mode disables the button up front with the one notice;
//   F049 Primary issuance (0x02) is read fresh before the reservation and
//        closed again in the mint's own transaction unless a sale needs it.
// The panel is a client component and vitest runs in Node, so its wiring is
// checked on the source (the pattern of tests/send-outcome.test.ts); the
// parser is pure.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DECLARED_EUR_MAX, DECLARED_EUR_MIN, formatDeclaredEur, parseDeclaredEur } from "@/lib/treasury-mint";

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const panel = src("components/treasury-mint-panel.tsx");

/** `text` from `start` to the next `end` (both must exist, in that order). */
function between(text: string, start: string, end: string): string {
  const a = text.indexOf(start);
  expect(a, start).toBeGreaterThan(-1);
  const b = text.indexOf(end, a + start.length);
  expect(b, end).toBeGreaterThan(a);
  return text.slice(a, b);
}

/** mintToTreasury(reason), the click handler, up to the next function. */
const handler = between(panel, "async function mintToTreasury(", "async function checkAgain(");
/** The Mint button's `disabled` list (the first one in the file). */
const button = between(panel, "disabled={", "onClick={() => setConfirmMint(true)}");
const run = handler.indexOf("const result = await runTreasuryMint({");

describe("the declared EUR value (F054)", () => {
  it("reads digits with at most two decimals after a dot, exactly as typed, in whole cents", () => {
    const accepted: Array<[string, number]> = [
      ["1000", 1000], ["1000.5", 1000.5], ["1000.50", 1000.5], ["€ 1000", 1000], ["€1000", 1000], [" 1 ", 1], ["1.00", 1],
      ["1.07", 1.07], ["999999.99", 999999.99], [`1${"0".repeat(12)}`, 1e12],
    ];
    for (const [text, eur] of accepted) expect(parseDeclaredEur(text), text).toEqual({ ok: true, eur });
  });

  it("refuses grouping separators, a third decimal, letters, signs, exponents and values outside the ledger's bounds", () => {
    const refused = [
      "", "0", "0.99", "1.000", "12.345", "3.000.000", "1,000", "8,90", "5.865,19", "1 000", "abc", "-1", "1e3", "1.", ".5",
      "9".repeat(13), `1${"0".repeat(13)}`,
    ];
    for (const text of refused) expect(parseDeclaredEur(text).ok, text).toBe(false);
  });

  it("says under the field what to type instead", () => {
    const error = (text: string) => {
      const r = parseDeclaredEur(text);
      return r.ok ? "" : r.error;
    };
    expect(error("")).toBe("Enter the EUR value this mint counts against the raise limit.");
    expect(error("1,000")).toMatch(/^Use "\." for cents and no thousands separators/);
    expect(error("1 000")).toMatch(/no thousands separators/);
    for (const grouped of ["1.000", "12.345", "3.000.000"]) {
      expect(error(grouped), grouped).toMatch(/^At most 2 decimals \(cents\)\. For one thousand type 1000/);
    }
    expect(error("0.99")).toBe("At least €1 (the raise-limit ledger's floor).");
    expect(error("0")).toMatch(/^At least €1/);
    expect(error("9".repeat(13))).toBe("Too large.");
    expect(error(`1${"0".repeat(13)}`)).toBe("Too large.");
    for (const text of ["abc", "-1", "1e3", "1.", ".5"]) expect(error(text), text).toMatch(/^Enter the EUR value as a number/);
    expect(DECLARED_EUR_MIN).toBe(1);
    expect(DECLARED_EUR_MAX).toBe(1e12);
  });

  it("echoes the parsed value in the en-IE EUR style", () => {
    expect(formatDeclaredEur(1000)).toBe("€1,000.00");
    expect(formatDeclaredEur(1)).toBe("€1.00");
    expect(formatDeclaredEur(1000.5)).toBe("€1,000.50");
  });

  it("the panel keeps the text as typed, re-parses it at the click and echoes the parsed value, never the raw text", () => {
    expect(panel).not.toContain("replace(/[^\\d.]/g");
    expect(panel).toContain("onChange={(e) => setMintEur(e.target.value)}");
    expect(panel).toContain("const eur = parseDeclaredEur(mintEur);");
    expect(panel).not.toContain("€{mintEur");
    expect(panel).toContain('<strong>{eur.ok ? formatDeclaredEur(eur.eur) : "—"}</strong>');
    expect(panel).toContain("= {formatDeclaredEur(eur.eur)} against the raise limit");
    expect(panel).toContain("{eur.error}");
    expect(button).toContain("!eur.ok");
    // Re-parsed in the handler (never a stale closure), before the reservation.
    const parsed = handler.indexOf("const parsed = parseDeclaredEur(mintEur);");
    expect(parsed).toBeGreaterThan(-1);
    expect(parsed).toBeLessThan(run);
    expect(handler).toContain("amountEur: parsed.eur,");
  });
});

describe("the room counted from lifetime_minted (F003)", () => {
  it("shows cap · created so far · at most N more, and refuses more than that before any signature", () => {
    expect(panel).toContain("const notCreated = remainingFromLifetime(cap, sc.lifetimeMinted);");
    expect(panel).toContain("const overRoom = notCreated !== null && units !== null && units > notCreated;");
    expect(panel).toContain("Cap {formatTokens(cap)} · created so far {formatTokens(sc.lifetimeMinted)} (converted tokens included) · at most");
    // Under the field and again in the confirmation.
    expect(panel.match(/\{roomLine\}/g)).toHaveLength(2);
    expect(button).toContain("overRoom");
    expect(handler).toMatch(/if \([^)]*overRoom[^)]*\) return;/);
    expect(panel).not.toMatch(/maxSupply[^;\n]*-\s*sc\.circulatingSupply/);
    expect(panel).not.toContain("defaultUnits");
    expect(panel).not.toContain("receiver-KYC gated");
  });
});

describe("one mint at a time, from the click (F047)", () => {
  it("locks with a ref before the reservation prompt and unlocks only when the mint settled or failed", () => {
    expect(panel).toContain("const mintLock = useRef(false);");
    expect(handler).toMatch(/if \([^)]*mintLock\.current\) return;/);
    const lock = handler.indexOf("mintLock.current = true;");
    const stage = handler.indexOf('setStage("check");');
    expect(lock).toBeGreaterThan(-1);
    expect(stage).toBeGreaterThan(lock);
    expect(run).toBeGreaterThan(stage);
    const finallyBlock = handler.slice(handler.lastIndexOf("} finally {"));
    expect(finallyBlock).toContain("mintLock.current = false;");
    expect(finallyBlock).toContain("setStage(null);");
    expect(panel).toContain("const busy = tx.isSending || stage !== null || checking;");
    expect(panel).toContain("busy={busy}");
    expect(button).toContain("busy ||");
  });

  it("says what the wallet or the network is waited for", () => {
    expect(panel).toContain(
      'stage === "confirm" ? "Confirming…" : stage === "check" ? "Checking…" : stage ? "Waiting for your wallet…" : "Mint to treasury"',
    );
    expect(panel).toContain('"Confirm in your wallet: reserve the value of the new tokens (a message)"');
    expect(panel).toContain("`Confirm in your wallet: mint ${mintAmount} units to the treasury`");
    expect(panel).toMatch(/aria-live="polite">\s*\{stageLine\}/);
    expect(handler).toContain("setStage(next);");
  });
});

describe("a mint not confirmed in time (F046)", () => {
  it("clears the form and keeps it disabled until the operator checked the explorer", () => {
    const failed = handler.indexOf('result.outcome === "failed"');
    expect(failed).toBeGreaterThan(-1);
    const unconfirmed = handler.slice(handler.indexOf("} else {", failed), handler.indexOf("await onRefresh()", failed));
    expect(unconfirmed).toContain('setMintAmount("");');
    expect(unconfirmed).toContain('setMintEur("");');
    expect(unconfirmed).toContain("setUnsettled({ key: unsettledKey, signature: result.signature, amount });");
    expect(unconfirmed).toContain("Outcome unknown — check the explorer before minting again.");
    // The confirmed branch settles it; the refused branch changes nothing (a retry is safe).
    const confirmed = handler.slice(handler.indexOf('result.outcome === "confirmed"'), failed);
    expect(confirmed).toContain("setUnsettled(null);");
    expect(handler).toMatch(/if \([^)]*\bpending\b[^)]*\) return;/);
    expect(button).toContain("pending");
    expect(panel).toContain("I checked the explorer — allow minting again");
    expect(panel).toContain('{checking ? "Checking…" : "Check again"}');
    expect(panel).toContain("const outcome = await readSignatureOutcome(rpc, signature);");
    expect(panel).toContain("minting again may create the units twice");
  });
});

describe("KYC-only mode and the 0x02 pause, said before anything is signed (F048, F049)", () => {
  it("disables the button in KYC-only mode with the one notice", () => {
    expect(panel).toContain('const issuanceOn = scopeEnabled("issuance");');
    expect(button).toContain("!issuanceOn");
    expect(handler).toMatch(/if \([^)]*!issuanceOn[^)]*\) return;/);
    expect(panel).toContain('{!issuanceOn && <p className="text-xs text-slate-500">{KYC_ONLY_MESSAGE}</p>}');
  });

  it("reads Primary issuance fresh, decides the re-pause and clears the gate's cache before the reservation; never `repause: false`", () => {
    expect(panel).not.toContain("repause: false");
    const order = [
      "readPlatformPause(rpc)",
      "listOpenSalesWithFreezes(rpc)",
      "listShareClassSaleApprovals(rpc, scPda)",
      "isPaused(platform.flags, PAUSE_PRIMARY)",
      "mintRepausesPrimary({",
      "clearPauseFlagsCache();",
    ];
    let last = -1;
    for (const step of order) {
      const at = handler.indexOf(step);
      expect(at, step).toBeGreaterThan(last);
      last = at;
    }
    expect(run).toBeGreaterThan(last);
    expect(handler).toMatch(/\n\s*repause,\n/);
    expect(handler).toContain("Could not read the platform's pause flags; nothing was reserved or sent.");
    expect(handler).toContain("throw new Error(pausedNote(platform.superAdmin.toString()));");
  });

  it("shows the 0x02 state with the reopen link, disables the button meanwhile, and says the mint closes 0x02 again", () => {
    expect(panel).toContain("const flags = usePauseFlags();");
    expect(panel).toContain("const primaryPaused = flags !== null && isPaused(flags, PAUSE_PRIMARY);");
    expect(button).toContain("primaryPaused");
    expect(panel).toMatch(/\{pausedNote\(superAdmin\)\}\s*<PrimaryReopenLink publicSale=\{false\}/);
    expect(panel).toContain("Minting is paused platform-wide (Primary issuance, bit 0x02).");
    // Send to wallets' own note (pinned in tests/tokenize-shares.test.ts) is about sends and is not reused here.
    expect(panel).not.toContain("Creating tokens is paused platform-wide");
    expect(panel).toContain("The same transaction closes Primary issuance (0x02) again, unless an Open sale can still");
    expect(panel).toContain('title: "Primary issuance (0x02) stays open"');
    expect(src("lib/treasury-mint.ts")).toContain("when the caller asks for it (Send to wallets and the");
  });
});
