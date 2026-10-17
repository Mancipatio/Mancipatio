"use client";

import { WalletRequired } from "@/components/wallet-required";

import Link from "next/link";
import { createNoopSigner, type Address } from "@solana/kit";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { useEffect, useState } from "react";
import {
  fetchMaybeIssuer,
  findIssuerPda,
  getRegisterIssuerInstructionAsync,
} from "@/lib/generated/asset_registry";
import { fromBytes32, KYB_LABEL, toBytes32 } from "@/lib/format";
import { walletSigner } from "@/lib/wallet-signer";
import { explainSendError } from "@/lib/tx-error";
import { useToast } from "@/lib/toast";
import { detectNetwork } from "@/lib/network";
import { startFinalityPoll } from "@/lib/finality-poll";
import type { NewIssuerProfile } from "@/lib/issuer-profiles";
import {
  createSignedRequest,
  postSignedRequest,
  type SiwsRequestBody,
} from "@/lib/siws-client";

void createNoopSigner; // tree-shake guard while we keep noop available for future flows

const ISSUER_PROFILE_ROUTE = "/api/issuer-profiles/upsert";
const ADD_LATER = "Add it from your issuer dashboard (Company profile, 1 signature).";
/** The whole finality wait, inside the signed envelope's 300 s window (lib/siws-client SIWS_MAX_AGE_MS). */
const FINALITY_WAIT_MS = 240_000;

/**
 * Resolves true once the Issuer account is visible at `finalized` — what
 * /api/issuer-profiles/upsert checks ownership at (lib/server/profile-read
 * requireProfileOwner) — false after `attempts` polls or when `signal`
 * aborts. `tx.send` returns on submission, so a profile write right after
 * it was refused ("Profile access denied") moments after register_issuer.
 * The same poll as lib/tokenize-shares-chain waitForFinalizedAsset, with an
 * 8 s cap per read so a hanging RPC never holds the wait open.
 */
function waitForFinalizedIssuer(
  rpc: Parameters<typeof fetchMaybeIssuer>[0],
  issuerPda: Address,
  opts: { intervalMs?: number; attempts?: number; signal?: AbortSignal } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const stop = startFinalityPoll(
      async () => {
        const issuer = await fetchMaybeIssuer(rpc, issuerPda, {
          commitment: "finalized",
          abortSignal: AbortSignal.timeout(8_000),
        });
        if (issuer.exists) finish(true);
        return issuer.exists;
      },
      { intervalMs: opts.intervalMs ?? 4_000, attempts: opts.attempts ?? 45, onGiveUp: () => finish(false) },
    );
    opts.signal?.addEventListener("abort", () => {
      stop();
      finish(false);
    });
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The company profile's save, shown on the "Submitted" step. */
type ProfileState =
  | { kind: "idle" }
  /** Nothing was entered on the Entity step: no prompt and no wait. */
  | { kind: "skipped" }
  | { kind: "working"; text: string }
  | { kind: "saved" }
  | { kind: "failed"; message: string };

const JURISDICTIONS = [
  { code: "688", label: "Serbia (688)" },
  { code: "070", label: "Bosnia & Herzegovina (070)" },
  { code: "499", label: "Montenegro (499)" },
  { code: "191", label: "Croatia (191)" },
  { code: "784", label: "United Arab Emirates (784)" },
  { code: "826", label: "United Kingdom (826)" },
  { code: "840", label: "United States (840)" },
  { code: "276", label: "Germany (276)" },
];

type Step = 1 | 2 | 3 | 4;

export default function IssuerOnboardingPage() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();

  const [step, setStep] = useState<Step>(1);
  const [legalId, setLegalId] = useState("");
  const [jurisdiction, setJurisdiction] = useState("688");
  const [companyName, setCompanyName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [acknowledgedKyb, setAcknowledgedKyb] = useState(false);
  const [existing, setExisting] = useState<null | "pending" | "verified" | "rejected">(null);
  const [checking, setChecking] = useState(true);
  const [profileState, setProfileState] = useState<ProfileState>({ kind: "idle" });
  // A registration whose company profile is not saved yet: the save alone is offered again.
  const [pendingProfile, setPendingProfile] = useState<{ issuerPda: Address; profile: NewIssuerProfile } | null>(null);

  const wallet = conn.wallet?.account.address;

  // If already registered, skip past step 1 and surface status.
  useEffect(() => {
    let cancelled = false;
    async function check() {
      if (!legalId.trim() || !conn.isReady) {
        setChecking(false);
        return;
      }
      try {
        const [pda] = await findIssuerPda({
          legalEntityId: toBytes32(legalId.trim()),
        });
        const maybe = await fetchMaybeIssuer(client.runtime.rpc, pda);
        if (cancelled) return;
        if (maybe.exists) {
          const k = maybe.data.kybStatus;
          setExisting(k === 0 ? "pending" : k === 1 ? "verified" : "rejected");
        } else {
          setExisting(null);
        }
      } catch {
        if (!cancelled) setExisting(null);
      } finally {
        if (!cancelled) setChecking(false);
      }
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChecking(true);
    void check();
    return () => {
      cancelled = true;
    };
  }, [legalId, conn.isReady, client]);

  /**
   * Signs the company profile (one prompt), waits until the Issuer is visible
   * at `finalized`, then posts it. Reports its own outcome on the "Submitted"
   * step and in a toast, and never throws: a profile that is not saved is
   * never "Failed to register issuer" — the registration is on chain.
   */
  async function saveProfile(issuerPda: Address, profile: NewIssuerProfile): Promise<void> {
    if (!conn.wallet) return;
    const fail = (title: string, message: string) => {
      setProfileState({ kind: "failed", message });
      setPendingProfile({ issuerPda, profile });
      toast.showError(title, `${message} ${ADD_LATER}`);
    };
    setProfileState({ kind: "working", text: "Confirm in your wallet: save the company profile" });
    let envelope: SiwsRequestBody;
    try {
      // created_by / network are stamped server-side from the signed wallet.
      envelope = await createSignedRequest(conn.wallet, "issuer-profiles.upsert", { profile });
    } catch (err) {
      fail("Company profile not saved", errorText(err));
      return;
    }
    setProfileState({
      kind: "working",
      text: "Waiting for the network to finalize the registration (usually under a minute)…",
    });
    const finalized = await waitForFinalizedIssuer(client.runtime.rpc, issuerPda, {
      signal: AbortSignal.timeout(FINALITY_WAIT_MS),
    });
    if (!finalized) {
      // Nothing was posted, so no nonce is spent: the same details can be saved again.
      fail(
        "Company profile not saved yet",
        "The registration is not final on the network yet. Save it again in a minute (1 signature).",
      );
      return;
    }
    setProfileState({ kind: "working", text: "Saving the company profile…" });
    try {
      await postSignedRequest(ISSUER_PROFILE_ROUTE, envelope);
      setProfileState({ kind: "saved" });
      setPendingProfile(null);
      toast.show({ kind: "success", title: "Company profile saved" });
    } catch (err) {
      fail("Company profile not saved", errorText(err));
    }
  }

  async function register() {
    if (!wallet || !conn.wallet || !legalId.trim()) return;
    const trimmedId = legalId.trim();
    const pendingId = toast.showPending(
      `Registering ${trimmedId}…`,
      `Jurisdiction ${jurisdiction}`,
    );
    let issuerPda: Address;
    try {
      [issuerPda] = await findIssuerPda({ legalEntityId: toBytes32(trimmedId) });
      const signer = walletSigner(conn.wallet);
      const ix = await getRegisterIssuerInstructionAsync({
        authority: signer,
        legalEntityId: toBytes32(trimmedId),
        jurisdiction: Number(jurisdiction) || 0,
        kybDocHash: new Uint8Array(32),
      });
      // Returns once the transaction is submitted (not confirmed): the step
      // below says "sent", and the profile waits for finality.
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Registration sent" });
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Failed to register issuer",
        explainSendError(err),
      );
      console.error("[register_issuer]", err);
      return;
    }
    setStep(4);

    // The off-chain onboarding profile (company / contact / website), keyed
    // by the Issuer PDA. The route reads the Issuer at `finalized`, so the
    // write waits for it (saveProfile) instead of failing moments after the
    // send; its outcome is reported on its own, never as a registration error.
    const profile: NewIssuerProfile = {
      issuer_pda: issuerPda.toString(),
      legal_entity_id: trimmedId,
      company_name: companyName.trim() || null,
      contact_email: contactEmail.trim() || null,
      website: website.trim() || null,
    };
    if (!profile.company_name && !profile.contact_email && !profile.website) {
      // Nothing to save: no second wallet prompt and no finality wait. The
      // dashboard adds the details later; the archive route keeps its own row.
      setProfileState({ kind: "skipped" });
      return;
    }
    await saveProfile(issuerPda, profile);
  }

  if (!wallet) return <main><WalletRequired context="This wallet becomes your issuer authority. Choose the wallet you intend to use to manage the entity." /></main>;

  return (
    <main className="min-w-0 flex-1">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Onboarding
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900">
          Become a Manci issuer
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Register the issuer wallet and company after completing verification.
          Follow KYC / KYB, review and the issuance request in your issuer workspace.
        </p>
      </div>

      {/* Stepper */}
      <ol className="mt-8 flex items-center gap-2 text-xs">
        {[1, 2, 3, 4].map((n) => (
          <li key={n} className="flex items-center gap-2">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full border text-xs font-semibold ${
                step === n
                  ? "border-slate-900 bg-slate-900 text-white"
                  : step > n
                    ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                    : "border-slate-200 bg-white text-slate-400"
              }`}
            >
              {step > n ? "✓" : n}
            </span>
            <span className={`uppercase tracking-wider ${step >= n ? "text-slate-700" : "text-slate-400"}`}>
              {["Wallet", "Entity", "Confirm", "Submitted"][n - 1]}
            </span>
            {n < 4 && <span className="text-slate-300">—</span>}
          </li>
        ))}
      </ol>

      <div className="mt-8 max-w-2xl">
        {/* Step 1 — wallet */}
        {step === 1 && (!wallet ? (
          <WalletRequired context="This wallet becomes your issuer authority. Choose the wallet you intend to use to manage the entity." />
        ) : (
          <Card>
            <h2 className="text-lg font-semibold text-slate-900">Issuer authority</h2>
            <p className="mt-2 text-sm text-slate-600">
              This wallet will manage assets, share classes and primary sales for your entity.
            </p>
            <div className="mt-5 flex items-center gap-3 text-sm">
              <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">Connected</span>
              <span className="font-mono text-xs text-slate-600">{wallet.toString().slice(0, 8)}…{wallet.toString().slice(-6)}</span>
            </div>
            <div className="mt-6 flex justify-end">
              <button type="button" onClick={() => setStep(2)}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
                Continue →
              </button>
            </div>
          </Card>
        ))}

        {/* Step 2 — entity */}
        {step === 2 && (
          <Card>
            <h2 className="text-lg font-semibold text-slate-900">Legal entity</h2>
            <p className="mt-2 text-sm text-slate-600">
              The legal entity identifier (max 32 chars) is the PDA seed —
              choose something stable and unique, e.g. <code className="rounded bg-slate-100 px-1">ACME-DOO-2026</code>.
              It cannot be changed once registered.
            </p>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="block sm:col-span-2">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Legal entity ID
                </span>
                <input
                  value={legalId}
                  maxLength={32}
                  onChange={(e) => setLegalId(e.target.value)}
                  placeholder="e.g. ACME-DOO-2026"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                />
                {!checking && existing && (
                  <p className={`mt-1 text-[11px] ${existing === "verified" ? "text-emerald-700" : "text-amber-700"}`}>
                    Already registered on-chain — KYB status: <strong>{existing}</strong>.
                  </p>
                )}
              </label>
              <label className="block sm:col-span-2">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Jurisdiction of incorporation
                </span>
                <select
                  value={jurisdiction}
                  onChange={(e) => setJurisdiction(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                >
                  {JURISDICTIONS.map((j) => (
                    <option key={j.code} value={j.code}>
                      {j.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Company name
                </span>
                <input
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="ACME DOO"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                />
                <span className="mt-1 block text-[11px] text-slate-400">
                  Off-chain only — used for the public profile.
                </span>
              </label>
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Contact email
                </span>
                <input
                  type="email"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  placeholder="founders@acme.io"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Website
                </span>
                <input
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  placeholder="https://acme.io"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                />
              </label>
            </div>
            <div className="mt-6 flex justify-between">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="text-sm text-slate-500 hover:text-slate-700"
              >
                ← Back
              </button>
              <button
                type="button"
                disabled={!legalId.trim() || existing === "verified"}
                onClick={() => setStep(3)}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                Continue →
              </button>
            </div>
          </Card>
        )}

        {/* Step 3 — confirm + register */}
        {step === 3 && (
          <Card>
            <h2 className="text-lg font-semibold text-slate-900">Confirm & register</h2>
            <p className="mt-2 text-sm text-slate-600">
              This calls <code className="rounded bg-slate-100 px-1">register_issuer</code> on-chain.
              The issuer starts in <strong>Pending KYB</strong> status — the platform&apos;s Super
              Admin verifies KYB documents off-chain and then approves the entity.
            </p>
            <dl className="mt-5 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-2">
              <Field label="Legal entity ID" value={legalId} />
              <Field label="Jurisdiction" value={jurisdiction} />
              <Field label="Company" value={companyName || "—"} />
              <Field label="Email" value={contactEmail || "—"} />
              <Field label="Website" value={website || "—"} />
              <Field
                label="Authority wallet"
                value={wallet?.toString() ?? "—"}
                mono
              />
            </dl>
            <label className="mt-5 flex items-start gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={acknowledgedKyb}
                onChange={(e) => setAcknowledgedKyb(e.target.checked)}
                className="mt-1"
              />
              <span>
                I understand the entity will start as <strong>Pending KYB</strong> and
                cannot create assets until Super Admin verifies the documents
                off-chain. Submit and track the required documents in{" "}
                <Link href="/issuer/verification?type=kyb" className="underline">company verification</Link>.
              </span>
            </label>
            <div className="mt-6 flex justify-between">
              <button
                type="button"
                onClick={() => setStep(2)}
                className="text-sm text-slate-500 hover:text-slate-700"
              >
                ← Back
              </button>
              <button
                type="button"
                disabled={tx.isSending || !acknowledgedKyb}
                onClick={() => void register()}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {tx.isSending ? "Sending…" : "Register on-chain"}
              </button>
            </div>
          </Card>
        )}

        {/* Step 4 — submitted */}
        {step === 4 && (
          <Card>
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-lg text-emerald-700">
                ✓
              </span>
              <div>
                <h2 className="text-lg font-semibold text-slate-900">
                  Registration submitted
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Your transaction was sent to {detectNetwork()}. The platform&apos;s Super Admin will
                  review KYB documents and approve the entity. KYB status:{" "}
                  <strong>{KYB_LABEL[0]}</strong>.
                </p>
                {profileState.kind === "working" && (
                  <p className="mt-3 text-sm text-slate-600" aria-live="polite">
                    {profileState.text}
                  </p>
                )}
                {profileState.kind === "skipped" && (
                  <p className="mt-3 text-sm text-slate-600">
                    No company details were entered. Add them later from your issuer dashboard (Company profile, 1 signature).
                  </p>
                )}
                {profileState.kind === "saved" && (
                  <p className="mt-3 text-sm text-emerald-700">Company profile saved.</p>
                )}
                {profileState.kind === "failed" && (
                  <div role="alert" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    <p className="font-medium">Company profile not saved</p>
                    <p className="mt-1 text-[13px]">
                      {profileState.message} {ADD_LATER}
                    </p>
                    {pendingProfile && (
                      <button
                        type="button"
                        onClick={() => void saveProfile(pendingProfile.issuerPda, pendingProfile.profile)}
                        className="mt-2 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:border-amber-400"
                      >
                        Save company profile — 1 signature
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link
                href="/issuer"
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
              >
                View issuer process →
              </Link>
              <Link
                href="/issuer/status"
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:border-slate-400"
              >
                Check status
              </Link>
            </div>
            <p className="mt-6 text-xs text-slate-400">
              Reference legal entity ID: <code className="rounded bg-slate-100 px-1">{fromBytes32(toBytes32(legalId))}</code>
            </p>
          </Card>
        )}
      </div>
    </main>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd
        className={`mt-0.5 break-all text-slate-800 ${mono ? "font-mono text-xs" : "text-sm"}`}
      >
        {value}
      </dd>
    </div>
  );
}
