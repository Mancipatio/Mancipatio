// Off-chain profile writes right after a submission-only send: `tx.send`
// returns once the transaction is SUBMITTED, while /api/issuer-profiles/upsert
// and /api/profiles/upsert read the on-chain owner at `finalized`
// (lib/server/profile-read requireProfileOwner). The issuer onboarding page
// wrote the company profile the moment register_issuer was sent, so external
// issuers got "Profile not saved" and the reviewer saw no onboarding profile.
// The page now signs the profile, waits until the Issuer is visible at
// `finalized`, and only then posts it; a save that did not happen is offered
// again on the "Submitted" step (1 signature) and never reads as a failed
// registration. The Create-asset modal is checked in tests/tokenize-shares.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SIWS_MAX_AGE_MS } from "@/lib/siws-client";

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("/issuer/onboarding company profile after register_issuer", () => {
  const page = src("app/issuer/onboarding/page.tsx");

  it("sends, signs, waits for the Issuer at finalized, then posts — and never calls upsertIssuerProfile", () => {
    const send = page.indexOf("await tx.send(");
    const sign = page.indexOf("await createSignedRequest(");
    const wait = page.indexOf("await waitForFinalizedIssuer(");
    const post = page.indexOf("await postSignedRequest(");
    expect(send).toBeGreaterThan(-1);
    // The helper is defined above the component; its call sits after the sign.
    expect(sign).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(sign);
    expect(post).toBeGreaterThan(wait);
    // register() sends first, then hands over to saveProfile (defined above it).
    expect(page.indexOf("await saveProfile(issuerPda, {")).toBeGreaterThan(send);
    expect(page).not.toContain("upsertIssuerProfile(");
    expect(page).toContain('commitment: "finalized"');
    expect(page).toContain("abortSignal: AbortSignal.timeout(8_000)");
  });

  it("bounds the whole wait inside the signed envelope's window", () => {
    expect(page).toContain("const FINALITY_WAIT_MS = 240_000;");
    expect(page).toContain("signal: AbortSignal.timeout(FINALITY_WAIT_MS)");
    expect(240_000).toBeLessThan(SIWS_MAX_AGE_MS);
    // Polls every 4 s, at most 45 times (3 min), as waitForFinalizedAsset does.
    expect(page).toContain("intervalMs: opts.intervalMs ?? 4_000, attempts: opts.attempts ?? 45");
  });

  it("a profile that is not saved never falls into 'Failed to register issuer' and can be saved again", () => {
    const registerFn = page.slice(page.indexOf("async function register()"), page.indexOf("if (!wallet) return <main>"));
    const registerCatch = registerFn.indexOf('"Failed to register issuer"');
    expect(registerCatch).toBeGreaterThan(-1);
    // The catch returns before step 4; the profile save comes after it.
    expect(registerFn.indexOf("return;", registerCatch)).toBeLessThan(registerFn.indexOf("setStep(4);"));
    expect(registerFn.indexOf("await saveProfile(")).toBeGreaterThan(registerFn.indexOf("setStep(4);"));
    // saveProfile reports on its own and keeps the details for a retry (1 signature, no nonce spent before the post).
    expect(page).toContain("setPendingProfile({ issuerPda, profile });");
    expect(page).toContain("Save company profile — 1 signature");
    expect(page).toContain("Waiting for the network to finalize the registration (usually under a minute)…");
    expect(page).toContain("Company profile saved");
  });

  it("does not claim the registration landed before finality", () => {
    expect(page).toContain('toast.showTx(sig, { title: "Registration sent" })');
    expect(page).not.toContain("Issuer registered");
    expect(page).not.toContain("succeeded on-chain");
    expect(page).toContain("Your transaction was sent to {detectNetwork()}.");
  });
});
