"use client";

import { WalletRequired } from "@/components/wallet-required";

import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useWalletConnection } from "@solana/react-hooks";
import { SkeletonCard } from "@/components/skeleton";
import { AppShell } from "@/components/app-shell";
import {
  acceptTos,
  getClientForOnboarding,
  linkClientWallet,
  listRequirementsForOnboarding,
  uploadClientDocumentWithToken,
  TOS_VERSION,
  type ClientRow,
  type KycRequirement,
} from "@/lib/clients";
import { useToast } from "@/lib/toast";

const TYPE_LABEL: Record<string, string> = {
  issuer: "Issuer",
  investor: "Investor",
  delegate: "Delegate",
  officer: "Officer",
};

const NEXT_STEP: Record<string, { title: string; body: string; href: string }> = {
  issuer: {
    title: "Finish on-chain registration",
    body: "Run register_issuer to anchor your entity on Solana. The wallet you just linked becomes the permanent issuer authority.",
    href: "/issuer/onboarding",
  },
  investor: {
    title: "Apply for your investor passport",
    body: "Upload any requested documents above, then apply for your on-chain investor passport from the portfolio page — gated offerings require it. The compliance team reviews your dossier and issues the passport.",
    href: "/portfolio",
  },
  delegate: {
    title: "Wait for an operating role",
    body: "Your wallet is now tied to your invitation. The platform Super Admin will grant any operational role from /admin/admins.",
    href: "/",
  },
  officer: {
    title: "Wait for assignment",
    body: "Your wallet is linked. The relevant issuer will grant officer permissions from their issuer console.",
    href: "/",
  },
};

export default function OnboardingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <AppShell section="onboarding">
      <div className="w-full max-w-3xl">
        <Consumer id={id} />
      </div>
    </AppShell>
  );
}

function Consumer({ id }: { id: string }) {
  const sp = useSearchParams();
  const token = sp.get("t") ?? "";
  const conn = useWalletConnection();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  const [client, setClient] = useState<ClientRow | null | undefined>(undefined);
  const [tokenValid, setTokenValid] = useState<boolean | null>(null);
  const [linking, setLinking] = useState(false);
  const [linked, setLinked] = useState(false);

  // ToS acceptance state (doc flow step 1: onboarding includes accepting ToS)
  const [tosChecked, setTosChecked] = useState(false);
  const [tosAccepting, setTosAccepting] = useState(false);

  // KYC requirements state
  const [requirements, setRequirements] = useState<KycRequirement[]>([]);
  const [uploading, setUploading] = useState<Record<number, boolean>>({});
  // Per-requirement file selections: requirementId → File
  const [selectedFiles, setSelectedFiles] = useState<Record<number, File>>({});
  // Refs for file inputs (one per requirement row, keyed by id)
  const fileInputRefs = useRef<Record<number, HTMLInputElement | null>>({});

  const refresh = useCallback(async () => {
    // Validate the magic-link token SERVER-SIDE — onboarding_token is a bearer
    // secret the browser must never read (getClientForOnboarding returns the
    // row without it, and tokenValid=false for a missing/invalid token).
    const { client: row, tokenValid: valid } = await getClientForOnboarding(
      id,
      token,
    );
    setClient(row);
    setTokenValid(valid);
  }, [id, token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const refreshRequirements = useCallback(
    async (clientId: string) => {
      const reqs = await listRequirementsForOnboarding(clientId, token);
      setRequirements(reqs);
    },
    [token],
  );

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void listRequirementsForOnboarding(client.id, token).then((reqs) => {
      if (!cancelled) setRequirements(reqs);
    });
    return () => { cancelled = true; };
  }, [client, token]);

  async function linkWallet() {
    if (!conn.wallet || !wallet || !client) return;
    setLinking(true);
    try {
      // The signature proves control of this exact wallet and invitation.
      // The server atomically links it once and records the system note.
      await linkClientWallet(conn.wallet, client.id, token);
      setLinked(true);

      // Record ToS acceptance alongside the link (checkbox gated the button).
      if (!client.tos_accepted_at) {
        const accepted = await acceptTos(client.id, token, wallet.toString());
        if (!accepted) {
          await refresh();
          throw new Error("Your wallet is linked. Terms acceptance could not be saved — retry the Terms step.");
        }
      }

      toast.show({
        kind: "success",
        title: "Wallet linked",
        description: "Onboarding step complete.",
      });
      await refresh();
    } catch (err) {
      toast.showError(
        "Failed to link wallet",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setLinking(false);
    }
  }

  // Standalone acceptance for clients whose wallet is already linked but who
  // predate the ToS gate (no tos_accepted_at yet).
  async function acceptTosNow() {
    if (!wallet || !client) return;
    setTosAccepting(true);
    try {
      const ok = await acceptTos(client.id, token, wallet.toString());
      if (!ok) throw new Error("Could not record the acceptance");
      toast.show({
        kind: "success",
        title: "Terms accepted",
        description: `Terms of Service v${TOS_VERSION} recorded.`,
      });
      await refresh();
    } catch (err) {
      toast.showError(
        "Failed to accept Terms of Service",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setTosAccepting(false);
    }
  }

  async function handleUpload(req: KycRequirement) {
    const file = selectedFiles[req.id];
    if (!file || !client || !wallet) return;
    const walletStr = wallet.toString();
    setUploading((prev) => ({ ...prev, [req.id]: true }));
    try {
      const { ok } = await uploadClientDocumentWithToken(
        client.id,
        token,
        walletStr,
        file,
        req.doc_kind,
        req.id,
      );
      if (ok) {
        toast.show({
          kind: "success",
          title: "Document uploaded",
          description: `${req.label} submitted for review.`,
        });
        // Clear the file selection for this requirement.
        setSelectedFiles((prev) => {
          const next = { ...prev };
          delete next[req.id];
          return next;
        });
        // Reset the file input element.
        const el = fileInputRefs.current[req.id];
        if (el) el.value = "";
        await refreshRequirements(client.id);
      } else {
        toast.showError("Upload failed", "Could not upload the document. Please try again.");
      }
    } catch (err) {
      toast.showError(
        "Upload failed",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setUploading((prev) => ({ ...prev, [req.id]: false }));
    }
  }

  if (client === undefined) {
    return <SkeletonCard rows={6} />;
  }

  if (!client || !tokenValid) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center">
        <p className="text-xs font-semibold uppercase tracking-widest text-red-700">
          Invalid link
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-red-900">
          This onboarding link isn&apos;t valid
        </h1>
        <p className="mt-3 text-sm text-red-800/90">
          Either the token is wrong, the link has been consumed, or the
          client record was deleted. Ask the platform operator for a fresh
          link.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-lg bg-red-900 px-4 py-2 text-sm font-medium text-white hover:bg-red-950"
        >
          Back to home
        </Link>
      </div>
    );
  }

  const next = NEXT_STEP[client.type];
  const alreadyConnected =
    client.onboarding_status !== "invited" && !!client.wallet;
  const sameWallet =
    !!wallet && !!client.wallet && wallet.toString() === client.wallet;
  const tosAccepted = !!client.tos_accepted_at;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Mancipatio onboarding
        </p>
        <h1 className="mt-1 text-3xl font-semibold text-slate-900">
          Welcome, {client.display_name}
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          You&apos;ve been invited to onboard as a{" "}
          <strong>{TYPE_LABEL[client.type] ?? client.type}</strong> on
          Mancipatio. One step here: connect the Solana wallet you want to use
          long-term, and we&apos;ll link it to your account.
        </p>
      </div>

      {/* Stepper */}
      <ol className="flex flex-wrap items-center gap-2 text-xs">
        <Step n={1} active={!wallet} done={!!wallet} label="Connect wallet" />
        <Sep />
        <Step
          n={2}
          active={!!wallet && !tosAccepted}
          done={tosAccepted}
          label="Accept ToS"
        />
        <Sep />
        <Step
          n={3}
          active={!!wallet && tosAccepted && !alreadyConnected && !linked}
          done={alreadyConnected || linked}
          label="Link to account"
        />
        <Sep />
        <Step
          n={4}
          active={(alreadyConnected || linked) && tosAccepted}
          done={false}
          label="Next steps"
        />
      </ol>

      {/* Step 1 — connect */}
      {!wallet && (
        <WalletRequired />
      )}

      {/* Step 2 — Terms of Service */}
      {!!wallet && (
        <Card>
          <h2 className="text-lg font-semibold text-slate-900">
            Terms of Service
          </h2>
          {tosAccepted ? (
            <p className="mt-2 flex items-center gap-2 text-sm text-emerald-700">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-xs">
                ✓
              </span>
              ToS v{client.tos_version ?? TOS_VERSION} accepted on{" "}
              {client.tos_accepted_at
                ? new Date(client.tos_accepted_at).toISOString().slice(0, 10)
                : "—"}
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm text-slate-600">
                Onboarding requires accepting the Mancipatio Terms of Service.
                Please read them before continuing:{" "}
                <a
                  href="/legal/terms"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-slate-900 underline underline-offset-2 hover:text-slate-700"
                >
                  Terms of Service (v{TOS_VERSION}) ↗
                </a>
              </p>
              <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={tosChecked}
                  onChange={(e) => setTosChecked(e.target.checked)}
                  disabled={linking || tosAccepting}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-slate-900"
                />
                <span className="text-sm text-slate-700">
                  I have read and accept the Mancipatio Terms of Service.
                </span>
              </label>
              {/* Already-linked clients (pre-ToS-gate) accept in place. */}
              {alreadyConnected && sameWallet && (
                <button
                  type="button"
                  disabled={!tosChecked || tosAccepting}
                  onClick={() => void acceptTosNow()}
                  className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {tosAccepting ? "Accepting…" : "Accept"}
                </button>
              )}
            </>
          )}
        </Card>
      )}

      {/* Step 3 — link wallet to account */}
      {!!wallet && !alreadyConnected && !linked && (
        <Card>
          <h2 className="text-lg font-semibold text-slate-900">
            Link this wallet to your Mancipatio account
          </h2>
          <p className="mt-2 text-sm text-slate-600">
            Connecting this wallet will associate it with your invitation. After
            this, every interaction (sale, OTC, claim, vote) is tied to the
            address below.
          </p>
          <p className="mt-4 break-all rounded-md bg-slate-50 px-3 py-2 font-mono text-xs">
            {wallet.toString()}
          </p>
          <button
            type="button"
            disabled={linking || (!tosAccepted && !tosChecked)}
            onClick={() => void linkWallet()}
            className="mt-5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {linking ? "Confirm in wallet…" : "Sign to link wallet"}
          </button>
          {!tosAccepted && !tosChecked && (
            <p className="mt-2 text-xs text-slate-500">
              Accept the Terms of Service above to enable linking.
            </p>
          )}
        </Card>
      )}

      {/* Step 3.5 — already linked but wrong wallet */}
      {!!wallet && alreadyConnected && !sameWallet && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
          <p className="font-semibold text-amber-900">
            Different wallet already linked
          </p>
          <p className="mt-1 text-xs text-amber-900/90">
            This account is already tied to{" "}
            <code className="font-mono">
              {client.wallet?.slice(0, 6)}…{client.wallet?.slice(-4)}
            </code>
            . Disconnect this wallet and reconnect the original one, or ask the
            platform operator to reset the invitation.
          </p>
        </div>
      )}

      {/* Step 4 — next */}
      {(alreadyConnected || linked) && sameWallet && next && (
        <Card>
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-lg text-emerald-700">
              ✓
            </span>
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                {next.title}
              </h2>
              <p className="mt-1 text-sm text-slate-600">{next.body}</p>
            </div>
          </div>
          <Link
            href={next.href}
            className="mt-5 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Continue →
          </Link>
        </Card>
      )}

      {/* Requested documents — only shown when there are requirements */}
      {requirements.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-base font-semibold text-slate-900">
            Requested documents
          </h2>
          <div className="space-y-3">
            {requirements.map((req) => {
              const needsUpload =
                req.status === "requested" || req.status === "rejected";
              const isUploading = uploading[req.id] ?? false;
              const chosenFile = selectedFiles[req.id] ?? null;
              const canUpload =
                needsUpload && !!wallet && (alreadyConnected || linked);

              return (
                <div
                  key={req.id}
                  className={`rounded-xl border p-4 ${
                    req.status === "approved"
                      ? "border-emerald-200 bg-emerald-50"
                      : req.status === "submitted"
                        ? "border-brand-200 bg-brand-50"
                        : req.status === "rejected"
                          ? "border-red-200 bg-red-50"
                          : "border-brand-100 bg-brand-50/60"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900">
                        {req.label}
                      </p>
                      {req.note && (
                        <p className="mt-0.5 text-xs text-slate-600">
                          {req.note}
                        </p>
                      )}
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                        req.status === "approved"
                          ? "bg-emerald-100 text-emerald-800"
                          : req.status === "submitted"
                            ? "bg-brand-100 text-brand-800"
                            : req.status === "rejected"
                              ? "bg-red-100 text-red-800"
                              : "bg-slate-100 text-slate-700"
                      }`}
                    >
                      {req.status === "approved"
                        ? "Approved"
                        : req.status === "submitted"
                          ? "Under review"
                          : req.status === "rejected"
                            ? "Rejected — re-upload"
                            : "Requested"}
                    </span>
                  </div>

                  {req.status === "submitted" && (
                    <p className="mt-2 text-xs text-brand-700">
                      Submitted — under review by the platform team.
                    </p>
                  )}

                  {req.status === "approved" && (
                    <p className="mt-2 text-xs text-emerald-700">
                      Approved.
                    </p>
                  )}

                  {canUpload && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-brand-200 bg-white px-3 py-1.5 text-xs font-medium text-brand-800 hover:bg-brand-50">
                        <span>Choose file</span>
                        <input
                          ref={(el) => {
                            fileInputRefs.current[req.id] = el;
                          }}
                          type="file"
                          className="sr-only"
                          accept="image/*,.pdf,.doc,.docx"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            setSelectedFiles((prev) =>
                              f
                                ? { ...prev, [req.id]: f }
                                : (() => {
                                    const next = { ...prev };
                                    delete next[req.id];
                                    return next;
                                  })(),
                            );
                          }}
                        />
                      </label>
                      {chosenFile && (
                        <span className="max-w-[160px] truncate text-xs text-slate-500">
                          {chosenFile.name}
                        </span>
                      )}
                      <button
                        type="button"
                        disabled={!chosenFile || isUploading}
                        onClick={() => void handleUpload(req)}
                        className="rounded-lg bg-brand-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-800 disabled:opacity-40"
                      >
                        {isUploading ? "Uploading…" : "Upload"}
                      </button>
                    </div>
                  )}

                  {needsUpload && !canUpload && (
                    <p className="mt-2 text-xs text-slate-500">
                      Connect and link your wallet above to upload this document.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p className="text-xs text-slate-400">
        Reference: <code className="font-mono">{client.id.slice(0, 8)}…</code> ·
        {" "}KYC status: <strong>{client.kyc_status}</strong>
      </p>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      {children}
    </div>
  );
}

function Step({
  n,
  active,
  done,
  label,
}: {
  n: number;
  active: boolean;
  done: boolean;
  label: string;
}) {
  return (
    <li className="flex items-center gap-2">
      <span
        className={`flex h-6 w-6 items-center justify-center rounded-full border text-xs font-semibold ${
          done
            ? "border-emerald-300 bg-emerald-50 text-emerald-700"
            : active
              ? "border-slate-900 bg-slate-900 text-white"
              : "border-slate-200 bg-white text-slate-400"
        }`}
      >
        {done ? "✓" : n}
      </span>
      <span
        className={`uppercase tracking-wider ${
          done || active ? "text-slate-700" : "text-slate-400"
        }`}
      >
        {label}
      </span>
    </li>
  );
}

function Sep() {
  return <span className="text-slate-300">—</span>;
}
