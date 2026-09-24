"use client";

import { WALLET_CONNECT_LABEL, WALLET_CONNECT_DESCRIPTION } from "@/lib/wallet-copy";

import { WalletRequired } from "@/components/wallet-required";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { isAddress, type Address } from "@solana/kit";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { RequireRole } from "@/components/require-role";
import { Kpi } from "@/components/kpi";
import { SkeletonTable } from "@/components/skeleton";
import { ConfirmModal } from "@/components/confirm-modal";
import { ClawbackPanel } from "./clawback-panel";
import { KycRegistryPanel } from "@/components/kyc-registry-panel";
import { JurisdictionSelector } from "@/components/jurisdiction-selector";
import { toggleJurisdiction } from "@/lib/kyc-registry-rotation";
import { invalidateRoles, useRole } from "@/lib/auth";
import { explainRoleRefusal } from "@/lib/role-resolution";
import { walletSigner } from "@/lib/wallet-signer";
import { useToast } from "@/lib/toast";
import { countryName } from "@/lib/countries";
import {
  DEFAULT_APPROVED_JURISDICTIONS,
  buildCreateRegistry,
  buildIssuePassport,
  dossierHash,
  getRegistryPda,
  isJurisdictionRepresentable,
  issueBlockers as computeIssueBlockers,
  jurisdictionBitmap,
  listPassportRequests,
  updatePassportRequest,
  type PassportRequest,
  type PassportRequestStatus,
} from "@/lib/passport";
import { type KycRegistry } from "@/lib/generated/asset_registry";
import {
  invalidateKycAuthorityContext,
  kycGates,
  kycRegistryUnavailableReason,
  loadKycAuthorityContext,
  waitForKycRegistry,
} from "@/lib/kyc-authority";
import {
  listClients,
  syncPassportToClient,
  KYC_VALIDITY_DAYS,
  type ClientKycStatus,
  type ClientRow,
} from "@/lib/clients";
import { fetchBlockEntries, fetchBlockEntry } from "@/lib/blocklist";
import { listWalletsWithOpenAlerts } from "@/lib/compliance";
import { recordAudit } from "@/lib/supabase";
import { explainSendError } from "@/lib/tx-error";
import { detectNetwork } from "@/lib/network";
import {
  parseUnsyncedIssues,
  pendingUnsyncedIssue,
  serializeUnsyncedIssues,
  type UnsyncedIssueMap,
} from "./unsynced-issues";

// Default approved set for the registry bootstrap — single source in
// lib/passport.ts (shared with /api/passport/submit validation), rendered
// here as zero-padded ISO strings for the country checkboxes.
const EU_DEFAULTS: string[] = DEFAULT_APPROVED_JURISDICTIONS.map((c) =>
  String(c).padStart(3, "0"),
);

/**
 * Dossier states only compliance can lift (mirrors TERMINAL_KYC_STATUSES in
 * app/api/clients/_helpers.ts). When one wallet carries several dossiers the
 * terminal one must win every lookup, or a suspension recorded on the newer
 * row becomes invisible to the issue gate.
 */
const TERMINAL_KYC_STATUSES = new Set<string>(["suspended", "rejected"]);

const KYC_BADGE: Record<ClientKycStatus, string> = {
  pending: "bg-amber-100 text-amber-800 border-amber-200",
  verified: "bg-emerald-100 text-emerald-800 border-emerald-200",
  rejected: "bg-red-100 text-red-800 border-red-200",
  suspended: "bg-slate-300 text-slate-700 border-slate-400",
  expired: "bg-orange-100 text-orange-700 border-orange-200",
  more_info: "bg-brand-100 text-brand-800 border-brand-200",
};

type Tab = "pending" | "expiring" | "expired" | "rejected" | "all";

export default function KycPage() {
  // Bumped after any on-chain registry change made on this page (create,
  // rotation propose/accept/cancel, jurisdictions): every card that caches
  // the registry context re-reads it, so no card keeps a stale authority.
  const [registryVersion, setRegistryVersion] = useState(0);
  const registryChanged = useCallback(() => setRegistryVersion((v) => v + 1), []);
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          KYC
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          KYC operations
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Review queue, re-KYC schedule and rejection rate. Click any client to
          jump to the detail view where approve / reject / suspend live. Admins
          triage requests and dossiers; only the KYC provider (the on-chain
          registry authority — a separate role from the Super Admin) can issue
          or revoke the on-chain passport.
        </p>
      </div>
      <RequireRole role="superAdmin" fallback={<></>}>
        <KycRegistryBootstrap registryVersion={registryVersion} onChanged={registryChanged} />
      </RequireRole>
      {/* Admins and the KYC provider (registry authority, possibly without an
          Admin record — Talas 3.1 K6). The routes behind these cards accept
          both; issuing stays gated on the live registry authority. */}
      <RequireRole anyOf={["admin", "kycProvider"]}>
        <KycRegistryAuthorityCard registryVersion={registryVersion} onChanged={registryChanged} />
        <PassportRequests registryVersion={registryVersion} />
        <KycOps />
      </RequireRole>
      {/* Clawback needs an Admin (clawback_blocklisted_holder signer). */}
      <RequireRole role="admin" fallback={<></>}>
        <ClawbackPanel />
      </RequireRole>
    </section>
  );
}

// ── KYC Registry bootstrap ────────────────────────────────────────────────────

type RegistryState =
  | { status: "loading" }
  | {
      status: "exists";
      entries: bigint;
      pda: Address;
      authority: Address;
      platformAdmin: Address | null;
    }
  | { status: "missing"; pda: Address }
  | { status: "error"; message: string };

type RegistryChangeProps = {
  /** Page-level version; a change re-reads the registry context. */
  registryVersion: number;
  /** Signals the page that the registry changed on-chain. */
  onChanged: () => void;
};

function KycRegistryBootstrap({ registryVersion, onChanged }: RegistryChangeProps) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const { isSuperAdmin } = useRole();
  const wallet = conn.wallet?.account.address;

  const [registryState, setRegistryState] = useState<RegistryState>({ status: "loading" });
  const [approvedCodes, setApprovedCodes] = useState<Set<string>>(
    () => new Set(EU_DEFAULTS),
  );
  const [blockedCodes, setBlockedCodes] = useState<Set<string>>(new Set());
  const [showSelector, setShowSelector] = useState(false);

  const refreshRegistry = useCallback(async (afterCreate = false) => {
    if (!wallet) {
      setRegistryState({ status: "error", message: "No wallet connected" });
      return;
    }
    try {
      // The registry is resolved BY ADDRESS — the NEXT_PUBLIC_KYC_REGISTRY
      // pin, or (unpinned) a scan of KycRegistry accounts — never derived
      // from the connected wallet, the platform admin or the registry's
      // current (rotatable) authority. Right after create_kyc_registry the tx
      // is only "confirmed", so poll a few fresh reads instead of flipping
      // back to the Create form.
      const ctx = afterCreate
        ? await waitForKycRegistry(client.runtime.rpc)
        : await loadKycAuthorityContext(client.runtime.rpc);
      if (ctx.registry) {
        setRegistryState({
          status: "exists",
          entries: ctx.registry.registry.entriesCount,
          pda: ctx.registry.address,
          authority: ctx.registry.registry.authority,
          platformAdmin: ctx.platformAdmin,
        });
      } else if (ctx.pinnedMissing && ctx.pinned) {
        // Fail closed: never offer Create for some OTHER address. Only the
        // wallet whose seed slot IS the pinned address may create it.
        const pda = await getRegistryPda(wallet as Address);
        if (pda === ctx.pinned) {
          setRegistryState({ status: "missing", pda });
        } else {
          setRegistryState({
            status: "error",
            message: `Pinned registry ${ctx.pinned} not found on ${detectNetwork()}. Check NEXT_PUBLIC_KYC_REGISTRY, or connect the wallet that creates it.`,
          });
        }
      } else if (ctx.ambiguous) {
        setRegistryState({
          status: "error",
          message: `${ctx.registries.length} KYC registries exist and none belongs to the platform admin — resolve the KYC authority before triaging passports.`,
        });
      } else {
        const pda = await getRegistryPda(wallet as Address);
        setRegistryState({ status: "missing", pda });
      }
    } catch (err) {
      setRegistryState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [wallet, client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshRegistry();
  }, [refreshRegistry, registryVersion]);

  async function createRegistry() {
    if (!wallet || !conn.wallet || !isSuperAdmin) return;
    const pendingId = toast.showPending("Creating KYC registry on-chain…");
    try {
      const signer = walletSigner(conn.wallet);
      const approved = jurisdictionBitmap(
        Array.from(approvedCodes).map((c) => parseInt(c, 10)),
      );
      const blocked = jurisdictionBitmap(
        Array.from(blockedCodes).map((c) => parseInt(c, 10)),
      );
      // adminSigner defaults to the same wallet: on the platform registry the
      // super admin is both the provider authority and the admin co-signer
      // the program requires (create_kyc_registry: admin_authority +
      // admin_record). A separate provider key would pass its own signer here.
      const ix = await buildCreateRegistry({
        authoritySigner: signer,
        approvedJurisdictions: approved,
        blockedJurisdictions: blocked,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "KYC registry created" });
      invalidateKycAuthorityContext(client.runtime.rpc);
      invalidateRoles();
      await refreshRegistry(true);
      onChanged();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Failed to create registry",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  function toggleCode(code: string, target: "approved" | "blocked") {
    const next = toggleJurisdiction(approvedCodes, blockedCodes, code, target);
    setApprovedCodes(next.approved);
    setBlockedCodes(next.blocked);
  }

  // jurisdictionBitmap SILENTLY drops codes outside the on-chain bitmap
  // (128 bytes = codes 0–1023). Every assigned ISO-3166-1 numeric code fits
  // since the 2026-08-10 widening, so with the canonical COUNTRIES list this
  // never fires — kept as a loud defence against a malformed code sneaking
  // in, or the admin would think they approved N countries while the chain
  // stores fewer.
  const droppedApproved = useMemo(
    () =>
      Array.from(approvedCodes)
        .map((c) => parseInt(c, 10))
        .filter((c) => !isJurisdictionRepresentable(c)),
    [approvedCodes],
  );
  const droppedBlocked = useMemo(
    () =>
      Array.from(blockedCodes)
        .map((c) => parseInt(c, 10))
        .filter((c) => !isJurisdictionRepresentable(c)),
    [blockedCodes],
  );
  const encodedApproved = approvedCodes.size - droppedApproved.length;

  return (
    <div className="mt-8 rounded-xl border border-brand-200 bg-brand-50 p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-600">
            On-chain · Super Admin
          </p>
          <h2 className="mt-0.5 text-base font-semibold text-brand-900">
            Platform KYC Registry
          </h2>
          <p className="mt-1 text-[13px] text-brand-800/80">
            The global registry must be created once. It stores approved and
            blocked jurisdiction bitmaps used by the transfer hook.
          </p>
          <p className="mt-1 text-[11px] text-brand-800/70">
            The connected wallet signs twice: as the registry&apos;s KYC-provider
            authority and as the platform admin co-signer the program now
            requires (its on-chain <code className="font-mono">Admin</code>{" "}
            record is derived from that key — grant one on /admin/admins first).
          </p>
        </div>
      </div>

      {/* Registry status */}
      <div className="mt-4">
        {registryState.status === "loading" && (
          <p className="text-sm text-brand-700">Checking registry…</p>
        )}
        {registryState.status === "error" && (
          <p className="text-sm text-red-600">{registryState.message}</p>
        )}
        {registryState.status === "exists" && (
          <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
            <div>
              <p className="text-sm font-semibold text-emerald-900">
                Registry live — {String(registryState.entries)} passport{registryState.entries !== BigInt(1) ? "s" : ""}
              </p>
              <p className="mt-0.5 font-mono text-[11px] text-emerald-700">
                {registryState.pda.toString()}
              </p>
              <p className="mt-1 text-[11px] text-emerald-800/80">
                KYC provider (registry authority):{" "}
                <span className="font-mono">{registryState.authority.toString()}</span>
              </p>
              {registryState.platformAdmin &&
                registryState.platformAdmin.toString() !==
                  registryState.authority.toString() && (
                  <p className="mt-1 text-[11px] text-amber-800">
                    The registry authority differs from the Super Admin (the
                    registry was handed to a separate key, or the platform
                    admin was rotated). Passports are issued and revoked only
                    by the registry authority above. That key reaches this
                    queue and the client detail pages as the KYC provider,
                    without an Admin record; Admins are managed on
                    /admin/admins. The registry authority itself moves only
                    through the propose/accept rotation below.
                  </p>
                )}
            </div>
          </div>
        )}

        {registryState.status === "missing" && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-sm font-semibold text-amber-900">
              No registry yet
            </p>
            <p className="mt-0.5 text-xs text-amber-800/80">
              PDA: {registryState.pda.toString()}
            </p>
          </div>
        )}
      </div>

      {/* Create form — only when missing */}
      {registryState.status === "missing" && (
        <div className="mt-5 space-y-4 border-t border-brand-200 pt-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-brand-700">
            Configure jurisdictions
          </p>
          <div className="flex flex-wrap gap-3 text-sm">
            <span className="text-slate-700">
              <strong>{approvedCodes.size}</strong> approved
              {droppedApproved.length > 0 && (
                <span className="text-amber-700">
                  {" "}
                  (only {encodedApproved} encodable on-chain)
                </span>
              )}
            </span>
            <span className="text-slate-700">
              <strong>{blockedCodes.size}</strong> blocked
              {droppedBlocked.length > 0 && (
                <span className="text-amber-700">
                  {" "}
                  (only {blockedCodes.size - droppedBlocked.length} encodable
                  on-chain)
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => setShowSelector((s) => !s)}
              className="rounded-md border border-brand-300 bg-white px-2.5 py-1 text-xs text-brand-700 hover:bg-brand-50"
            >
              {showSelector ? "Hide" : "Edit"} jurisdiction list
            </button>
          </div>

          {(droppedApproved.length > 0 || droppedBlocked.length > 0) && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-[12px] leading-relaxed text-amber-900">
              <p className="font-semibold">
                ⚠ {droppedApproved.length} of {approvedCodes.size} selected
                approved jurisdictions cannot be encoded on-chain
              </p>
              <p className="mt-1">
                The registry bitmap holds 128 bytes (codes 0–1023).
                Selections with codes ≥ 1024 —{" "}
                {droppedApproved
                  .slice(0, 4)
                  .map((c) => countryName(String(c).padStart(3, "0")))
                  .join(", ")}
                {droppedApproved.length > 4
                  ? ` and ${droppedApproved.length - 4} more`
                  : ""}{" "}
                — are silently dropped by the program, so the registry will be
                created with <strong>{encodedApproved}</strong> approved{" "}
                {encodedApproved === 1 ? "country" : "countries"} on-chain.
                {droppedBlocked.length > 0 && (
                  <>
                    {" "}
                    Likewise {droppedBlocked.length} BLOCKED selection
                    {droppedBlocked.length === 1 ? "" : "s"} cannot be encoded
                    — those sanctions will NOT be enforced on-chain.
                  </>
                )}{" "}
                Widening the bitmap requires a program upgrade.
              </p>
            </div>
          )}

          {showSelector && (
            <JurisdictionSelector
              approved={approvedCodes}
              blocked={blockedCodes}
              onToggle={toggleCode}
            />
          )}

          <button
            type="button"
            disabled={tx.isSending || !wallet}
            onClick={() => void createRegistry()}
            className="rounded-lg bg-brand-700 px-5 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-50"
          >
            {tx.isSending ? "Sending…" : "Create KYC registry"}
          </button>
          {!wallet && (
            <WalletRequired />
          )}
        </div>
      )}
    </div>
  );
}

// ── KYC registry authority + jurisdictions (2C-1) ─────────────────────────────

/**
 * Rendered for every Admin, not just the Super Admin: the registry authority
 * (e.g. a separate compliance key) acts here, and the panel gates each action
 * on on-chain state only (registry.authority / the staged new_authority).
 */
function KycRegistryAuthorityCard({ registryVersion, onChanged }: RegistryChangeProps) {
  const client = useSolanaClient();
  const [record, setRecord] = useState<{ address: Address; registry: KycRegistry } | null>(null);
  // Why the card cannot show the registry (load error, missing pin, ambiguous
  // scan). Shown in the card: a non-Super-Admin does not see the bootstrap
  // card, so this is its only feedback.
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const ctx = await loadKycAuthorityContext(client.runtime.rpc, { fresh: true });
      setRecord(ctx.registry);
      setProblem(kycRegistryUnavailableReason(ctx, detectNetwork()));
    } catch (err) {
      console.warn("[admin/kyc] registry load failed:", err);
      setRecord(null);
      setProblem(`Could not load the KYC registry: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [client]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, registryVersion]);
  if (!record && !problem) return null; // no registry yet: the bootstrap card handles creation
  if (!record) {
    return (
      <div className="mt-8 rounded-xl border border-red-200 bg-red-50 p-6 shadow-sm">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-red-700">
          On-chain · KYC registry authority
        </p>
        <p className="mt-1 text-sm text-red-700">{problem}</p>
      </div>
    );
  }
  return (
    <div className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        On-chain · KYC registry authority
      </p>
      <h2 className="mt-0.5 text-base font-semibold text-slate-900">
        Registry authority and jurisdictions
      </h2>
      <KycRegistryPanel
        key={`${record.address}:${record.registry.authority}`}
        registryAddress={record.address}
        registry={record.registry}
        onChanged={onChanged}
      />
    </div>
  );
}

// ── Investor passport requests ────────────────────────────────────────────────

type ReqTab = "new" | "in_review" | "approved" | "rejected" | "all";

const REQ_BADGE: Record<PassportRequestStatus, string> = {
  new: "bg-amber-100 text-amber-800 border-amber-200",
  in_review: "bg-brand-100 text-brand-800 border-brand-200",
  approved: "bg-emerald-100 text-emerald-800 border-emerald-200",
  rejected: "bg-red-100 text-red-800 border-red-200",
};

const REQ_LABEL: Record<PassportRequestStatus, string> = {
  new: "new",
  in_review: "in review",
  approved: "approved",
  rejected: "rejected",
};

// Per-network key: a devnet signature must never be replayed as a mainnet
// sync (the route would reject the client anyway — fetchClientOr404 is
// network-bound — but the queue must not even offer it). Entry shape and
// matching rules live in ./unsynced-issues.ts (keyed by request id, expired
// entries dropped on read).
const UNSYNCED_STORAGE_KEY = `mancipatio.admin.kyc.unsynced-issues.${detectNetwork()}`;

// Tiny external store over localStorage (useSyncExternalStore): the raw JSON
// string is the snapshot, the server snapshot is null (empty map), and every
// write notifies subscribers — so the queue reads persisted repairs without a
// setState-in-effect and without a hydration mismatch. Falls back to memory
// when storage is unavailable (private mode, blocked site data).
let unsyncedRaw: string | null | undefined; // undefined = not read yet
const unsyncedListeners = new Set<() => void>();

function readUnsyncedSnapshot(): string | null {
  if (unsyncedRaw === undefined) {
    try {
      unsyncedRaw = window.localStorage.getItem(UNSYNCED_STORAGE_KEY);
    } catch {
      unsyncedRaw = null;
    }
  }
  return unsyncedRaw;
}

function subscribeUnsynced(listener: () => void): () => void {
  unsyncedListeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === UNSYNCED_STORAGE_KEY) {
      unsyncedRaw = e.newValue;
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    unsyncedListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function writeUnsyncedIssues(map: UnsyncedIssueMap): void {
  const raw = serializeUnsyncedIssues(map);
  unsyncedRaw = raw;
  try {
    if (raw === null) window.localStorage.removeItem(UNSYNCED_STORAGE_KEY);
    else window.localStorage.setItem(UNSYNCED_STORAGE_KEY, raw);
  } catch {
    // Best-effort persistence; the in-memory snapshot still guards this session.
  }
  unsyncedListeners.forEach((l) => l());
}

/** Wallets whose status was read (`checked`) and those that were hits. */
type GateCheck = { checked: Set<string>; hits: Set<string> };

/** true / false for a checked wallet; null (unknown → blocks) otherwise. */
function gateValue(check: GateCheck | null, wallet: string): boolean | null {
  if (!check || !check.checked.has(wallet)) return null;
  return check.hits.has(wallet);
}

function errorText(err: unknown): string {
  return explainRoleRefusal(err instanceof Error ? err.message : String(err));
}

function shortWallet(w: string): string {
  return `${w.slice(0, 6)}…${w.slice(-4)}`;
}

function PassportRequests({ registryVersion }: { registryVersion: number }) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  const [rows, setRows] = useState<PassportRequest[] | null>(null);
  const [clientByWallet, setClientByWallet] = useState<Map<string, ClientRow>>(
    () => new Map(),
  );
  // On-chain pre-checks for the issue gate (null = could not load → skip that
  // particular check but say so).
  const [registry, setRegistry] = useState<KycRegistry | null>(null);
  // Live registry authority — the only key allowed to issue passports. It is
  // resolved from the registry account itself, never from Platform.admin.
  const [registryAuthority, setRegistryAuthority] = useState<Address | null>(null);
  // The live registry's ADDRESS (pinned / resolved). approve_holder targets
  // it directly: after a rotation it is not derivable from the authority.
  const [registryAddress, setRegistryAddress] = useState<Address | null>(null);
  const [platformAdmin, setPlatformAdmin] = useState<Address | null>(null);
  const { isKycProvider } = kycGates(wallet, registryAuthority, platformAdmin);
  // Issue-gate checks over the queue's wallets. `checked` = wallets whose
  // status was read; a wallet outside it (or a failed read → null) is
  // UNKNOWN and blocks issuing (fail closed, Talas 3.1 OD3).
  const [blockCheck, setBlockCheck] = useState<GateCheck | null>(null);
  const [alertCheck, setAlertCheck] = useState<GateCheck | null>(null);
  // A list that did not load says so instead of looking empty.
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [tab, setTab] = useState<ReqTab>("new");
  const [confirm, setConfirm] = useState<
    { action: "issue" | "reject"; req: PassportRequest } | null
  >(null);
  const [busy, setBusy] = useState(false);
  // Requests whose approve_holder LANDED on-chain while the off-chain
  // write-back failed: the request row still says "undecided", so the queue
  // would happily offer "Issue passport" again — a second on-chain emission
  // for the same wallet. Keyed request id → { wallet, tx signature, on-chain
  // expiry }; the expiry travels with the signature because the passport-sync
  // route REQUIRES it for an "issued" event (e2e §4 — the old retry dropped it
  // and every retry was a 400). Keyed by request id — never by wallet — so a
  // stale entry cannot attach to a later re-KYC request for the same wallet
  // and replay an old signature/expiry onto it. Persisted per network in
  // localStorage so a reload does not lose the pending repairs; cleared by a
  // successful retry, and expired entries are dropped on read.
  const unsyncedSnapshot = useSyncExternalStore(
    subscribeUnsynced,
    readUnsyncedSnapshot,
    () => null,
  );
  const unsyncedIssues = useMemo(
    () => parseUnsyncedIssues(unsyncedSnapshot),
    [unsyncedSnapshot],
  );
  const setUnsyncedIssues = useCallback(
    (update: (prev: UnsyncedIssueMap) => UnsyncedIssueMap) =>
      writeUnsyncedIssues(update(parseUnsyncedIssues(readUnsyncedSnapshot()))),
    [],
  );
  const [retrying, setRetrying] = useState<string | null>(null);

  // Registry authority / address / bitmaps only — no signed admin read, so a
  // registry change elsewhere on the page re-runs just this (no wallet
  // prompt), and the Issue gate follows the live authority immediately.
  const loadRegistryContext = useCallback(async () => {
    try {
      const ctx = await loadKycAuthorityContext(client.runtime.rpc);
      setPlatformAdmin(ctx.platformAdmin);
      setRegistry(ctx.registry?.registry ?? null);
      setRegistryAuthority(ctx.registry?.registry.authority ?? null);
      setRegistryAddress(ctx.registry?.address ?? null);
    } catch (err) {
      console.warn("[admin/kyc] registry load failed:", err);
      setRegistry(null);
      setRegistryAuthority(null);
      setRegistryAddress(null);
      setPlatformAdmin(null);
    }
  }, [client]);

  const refresh = useCallback(async () => {
    // The queue is no longer anon-readable — the signed admin read needs the
    // connected wallet (one signature per refresh, same as /admin/fees).
    if (!conn.wallet) return;
    // Each list reports its own failure (a failed dossier read must not look
    // like "no dossier", nor a failed queue read like an empty queue).
    const [requestsResult, clientsResult] = await Promise.allSettled([
      listPassportRequests(conn.wallet),
      listClients(conn.wallet),
    ]);
    const errors: string[] = [];
    const requests = requestsResult.status === "fulfilled" ? requestsResult.value : [];
    if (requestsResult.status === "rejected") {
      errors.push(`Passport requests could not be loaded: ${errorText(requestsResult.reason)}`);
    }
    const clients = clientsResult.status === "fulfilled" ? clientsResult.value : [];
    if (clientsResult.status === "rejected") {
      errors.push(
        `Client dossiers could not be loaded — issuing is blocked until they load: ${errorText(clientsResult.reason)}`,
      );
    }
    setLoadErrors(errors);
    setRows(requests);
    // wallet → client row. FAIL-CLOSED when a wallet carries several dossiers
    // (historic duplicates: 0041's unique index is skipped when they already
    // exist): a terminal dossier (suspended / rejected) always wins, so the
    // issue gate below sees the compliance verdict instead of an older
    // `pending` row. Otherwise the oldest row wins, mirroring
    // findClientByWallet / /api/clients/me (clients come newest-first, so
    // later — older — entries overwrite).
    const map = new Map<string, ClientRow>();
    for (const c of clients) {
      if (!c.wallet) continue;
      const current = map.get(c.wallet);
      if (current && TERMINAL_KYC_STATUSES.has(current.kyc_status)) continue;
      map.set(c.wallet, c);
    }
    setClientByWallet(map);

    // Issue-gate context. The blocklist is sender-only on-chain: the hook
    // derives ["blocked", source_owner] and never checks the receiver, so
    // THIS gate is what keeps a blocklisted wallet from receiving a passport.
    // Each source degrades independently to "unknown", and unknown blocks
    // issuing (fail closed) while triage keeps working. Both are re-read for
    // the single wallet at send time (issueFromRequest).
    await loadRegistryContext();
    const queueWallets = [...new Set(requests.map((r) => r.wallet))].filter((w) =>
      isAddress(w),
    ) as Address[];
    try {
      const entries = await fetchBlockEntries(client.runtime.rpc, queueWallets);
      setBlockCheck({ checked: new Set(queueWallets), hits: new Set(entries.keys()) });
    } catch (err) {
      console.warn("[admin/kyc] blocklist load failed:", err);
      setBlockCheck(null);
    }
    try {
      const open = await listWalletsWithOpenAlerts(conn.wallet, queueWallets);
      setAlertCheck({ checked: new Set(queueWallets), hits: open });
    } catch (err) {
      console.warn("[admin/kyc] compliance alert status load failed:", err);
      setAlertCheck(null);
    }
  }, [conn.wallet, client, loadRegistryContext]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // A registry change on this page (rotation, jurisdictions, create): re-read
  // the registry context only. Version 0 is the initial load, done by refresh.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (registryVersion > 0) void loadRegistryContext();
  }, [registryVersion, loadRegistryContext]);

  /**
   * The issue gate: every reason why approve_holder must NOT be sent for this
   * request. Empty array = safe to issue. The rules live in the SHARED
   * lib/passport.ts issueBlockers() — the /admin/clients/[id] issuance path
   * runs the exact same gate, so neither path can drift.
   */
  const issueBlockers = useCallback(
    (
      req: PassportRequest,
      fresh?: { walletBlocked: boolean; hasOpenAlert: boolean },
    ): string[] => {
      const linked = clientByWallet.get(req.wallet);
      const blockers = computeIssueBlockers({
        client: linked ?? null,
        jurisdiction: req.jurisdiction,
        registry,
        walletBlocked: fresh ? fresh.walletBlocked : gateValue(blockCheck, req.wallet),
        hasOpenAlert: fresh ? fresh.hasOpenAlert : gateValue(alertCheck, req.wallet),
      });
      // Idempotency stop: an on-chain passport already exists for THIS
      // request — only the off-chain write-back is missing. A pending entry
      // for an older request of the same wallet does not block a re-KYC.
      const pending = pendingUnsyncedIssue(unsyncedIssues, req);
      if (pending) {
        blockers.unshift(
          `A passport was already issued on-chain for this wallet (tx ${pending.sig.slice(0, 8)}…) but the off-chain sync failed — retry the sync instead of issuing again.`,
        );
      }
      return blockers;
    },
    [clientByWallet, registry, blockCheck, alertCheck, unsyncedIssues],
  );

  const counts = useMemo(() => {
    const base = { new: 0, in_review: 0, approved: 0, rejected: 0, all: 0 };
    for (const r of rows ?? []) {
      base[r.status] += 1;
      base.all += 1;
    }
    return base;
  }, [rows]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    if (tab === "all") return rows;
    return rows.filter((r) => r.status === tab);
  }, [rows, tab]);

  async function markInReview(req: PassportRequest) {
    if (!wallet) return;
    const ok = await updatePassportRequest(conn.wallet, req.id, {
      status: "in_review",
    });
    if (ok) {
      await refresh();
    } else {
      toast.showError("Update failed", "Could not mark the request in review.");
    }
  }

  async function issueFromRequest(req: PassportRequest, reason: string) {
    if (!isKycProvider || !registryAuthority || !registryAddress) {
      toast.showError(
        "Not the KYC provider",
        "Only the registry authority wallet can issue passports.",
      );
      return;
    }
    if (!wallet || !conn.wallet) {
      toast.showError(
        WALLET_CONNECT_LABEL, WALLET_CONNECT_DESCRIPTION,
      );
      return;
    }
    // Hard gate re-checked at send time — the button being enabled is UI
    // convenience, this is the authoritative client-side stop. The blocklist
    // entry and the alert status of THIS wallet are re-read now (not the
    // queue snapshot); any read error aborts.
    let fresh: { walletBlocked: boolean; hasOpenAlert: boolean };
    try {
      const [entry, open] = await Promise.all([
        fetchBlockEntry(client.runtime.rpc, req.wallet as Address),
        listWalletsWithOpenAlerts(conn.wallet, [req.wallet]),
      ]);
      fresh = { walletBlocked: entry !== null, hasOpenAlert: open.has(req.wallet) };
    } catch (err) {
      toast.showError(
        "Cannot issue passport",
        `The blocklist and compliance alert status could not be re-checked — retry. ${errorText(err)}`,
      );
      return;
    }
    const blockers = issueBlockers(req, fresh);
    if (blockers.length > 0) {
      toast.showError("Cannot issue passport", blockers[0]);
      return;
    }
    const linked = clientByWallet.get(req.wallet);
    if (!linked) return; // unreachable — issueBlockers covers it
    setBusy(true);
    const pendingId = toast.showPending("Issuing on-chain passport…");
    try {
      const signer = walletSigner(conn.wallet);
      // On-chain expiry mirrors the off-chain verdict's kyc_expires_at (set at
      // verification, +365d policy); fall back to the policy window when the
      // stored date is missing/past (approve_holder requires expiry > now).
      const nowSec = Math.floor(Date.now() / 1000);
      const storedExpirySec = linked.kyc_expires_at
        ? Math.floor(new Date(linked.kyc_expires_at).getTime() / 1000)
        : 0;
      const expirySec =
        storedExpirySec > nowSec
          ? storedExpirySec
          : nowSec + KYC_VALIDITY_DAYS * 24 * 3600;
      const expiry = BigInt(expirySec);
      const expiresAtIso = new Date(expirySec * 1000).toISOString();
      // The external ref binds the passport to the off-chain dossier (client
      // id + verification stamp), not just to the request row.
      const externalRefHash = await dossierHash(
        `${linked.id}:${linked.kyc_verified_at ?? req.id}`,
      );
      const ix = await buildIssuePassport({
        authoritySigner: signer,
        registry: registryAddress,
        holder: req.wallet as Address,
        jurisdiction: req.jurisdiction ?? 0,
        accreditationLevel: 0,
        expiry,
        providerId: 0,
        externalRefHash,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "On-chain passport issued" });
      // Mirror the outcome into the off-chain dossier (kyc_provider_ref = tx,
      // kyc_expires_at = on-chain expiry) + decision stamp on the request.
      // Both write-backs return false on failure — that MUST be loud: a
      // silent divergence leaves the request re-issuable (double emission)
      // and the dossier without the on-chain expiry/tx reference.
      const [syncOk, updateOk] = await Promise.all([
        syncPassportToClient(
          conn.wallet,
          linked.id,
          "issued",
          sig,
          expiresAtIso,
        ),
        updatePassportRequest(
          conn.wallet,
          req.id,
          {
            status: "approved",
            handled_by: wallet.toString(),
            handled_at: new Date().toISOString(),
          },
          reason,
        ),
      ]);
      if (!syncOk || !updateOk) {
        // Block any further "Issue passport" for this wallet until the
        // write-back is repaired — the toast alone disappears on reload.
        setUnsyncedIssues((prev) =>
          new Map(prev).set(req.id, {
            wallet: req.wallet,
            sig,
            expiresAt: expiresAtIso,
          }),
        );
        const failures = [
          !syncOk
            ? "the client dossier was NOT updated (missing kyc_provider_ref / kyc_expires_at, no approval email)"
            : null,
          !updateOk
            ? "the request still shows as undecided — do NOT issue again for this wallet"
            : null,
        ]
          .filter(Boolean)
          .join("; ");
        // Persistent (duration 0) error toast carrying the tx signature.
        toast.show({
          kind: "error",
          title: "Passport issued on-chain but the off-chain sync FAILED",
          description: `${failures}. Reconcile the dossier manually against this transaction.`,
          signature: sig,
          duration: 0,
        });
        void recordAudit({
          ix_name: "passport_sync_failed",
          category: "issuers",
          actor_wallet: wallet.toString(),
          reason: `Off-chain write-back after approve_holder failed: ${failures}`,
          target_label: req.wallet,
          tx_signature: sig,
          status: "failed",
        });
      }
      void recordAudit({
        ix_name: "approve_holder",
        category: "issuers",
        actor_wallet: wallet.toString(),
        reason,
        target_label: req.wallet,
        tx_signature: sig,
      });
      setConfirm(null);
      await refresh();
    } catch (err) {
      toast.dismiss(pendingId);
      const msg = explainSendError(err);
      if (/AccountNotFound|not found|does not exist/i.test(msg)) {
        toast.showError(
          "Registry not found",
          "Create the platform KYC registry first.",
        );
      } else {
        toast.showError("Failed to issue passport", msg);
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * Repairs the off-chain write-back for a passport that is ALREADY on-chain
   * (approve_holder landed, the dossier/request sync did not). Never touches
   * the chain — the whole point is to avoid a second emission.
   */
  async function retrySync(req: PassportRequest) {
    // Only the entry produced by THIS request's approve_holder may be
    // replayed — an old wallet-level entry must never stamp a newer request.
    const pending = pendingUnsyncedIssue(unsyncedIssues, req);
    const linked = clientByWallet.get(req.wallet);
    if (!pending || !linked || !wallet || !conn.wallet) return;
    const { sig, expiresAt } = pending;
    setRetrying(req.id);
    try {
      // Same payload as the original write-back: the route rejects an
      // "issued" event without the on-chain expiry, so it is replayed here.
      const [syncOk, updateOk] = await Promise.all([
        syncPassportToClient(conn.wallet, linked.id, "issued", sig, expiresAt),
        updatePassportRequest(conn.wallet, req.id, {
          status: "approved",
          handled_by: wallet.toString(),
          handled_at: new Date().toISOString(),
        }),
      ]);
      if (syncOk && updateOk) {
        setUnsyncedIssues((prev) => {
          const next = new Map(prev);
          next.delete(req.id);
          return next;
        });
        toast.show({ kind: "success", title: "Off-chain sync repaired" });
        await refresh();
      } else {
        toast.show({
          kind: "error",
          title: "Sync still failing",
          description:
            "The dossier / request row could not be updated. Keep this queue open — issuing again would emit a SECOND on-chain passport.",
          signature: sig,
          duration: 0,
        });
      }
    } finally {
      setRetrying(null);
    }
  }

  async function rejectRequest(req: PassportRequest, reason: string) {
    if (!wallet) return;
    setBusy(true);
    try {
      const ok = await updatePassportRequest(
        conn.wallet,
        req.id,
        {
          status: "rejected",
          handled_by: wallet.toString(),
          handled_at: new Date().toISOString(),
        },
        reason,
      );
      if (!ok) throw new Error("Update returned false");
      void recordAudit({
        ix_name: "passport_request_rejected",
        category: "other",
        actor_wallet: wallet.toString(),
        reason,
        target_label: req.wallet,
      });
      toast.show({ kind: "success", title: "Request rejected" });
      setConfirm(null);
      await refresh();
    } catch (err) {
      toast.showError(
        "Failed to reject request",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Passport requests
        </h2>
        <p className="mt-1 text-[13px] text-slate-600">
          Self-service applications submitted by investors from their portfolio.
          Every application is linked to a client dossier (auto-provisioned on
          submit). Admins and the KYC provider triage here — open the dossier,
          request documents, approve the off-chain KYC — and the KYC provider
          (the registry authority) issues the on-chain passport
          (approve_holder) only once the dossier is{" "}
          <span className="font-semibold">verified</span> and the wallet is
          neither blocklisted nor under an unresolved compliance alert.
        </p>
      </div>

      {loadErrors.length > 0 && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800" role="alert">
          {loadErrors.map((e) => (
            <p key={e}>{e}</p>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="mt-4 flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-1 text-xs">
        {(
          [
            ["new", `New (${counts.new})`],
            ["in_review", `In review (${counts.in_review})`],
            ["approved", `Approved (${counts.approved})`],
            ["rejected", `Rejected (${counts.rejected})`],
            ["all", `All (${counts.all})`],
          ] as [ReqTab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1.5 transition-colors ${
              tab === t
                ? "bg-slate-900 text-white"
                : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Table */}
      {rows === null ? (
        <div className="mt-4">
          <SkeletonTable rows={3} cols={5} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-8 text-center shadow-card">
          <p className="text-sm text-slate-600">No requests in this tab.</p>
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Wallet</th>
                <th className="px-4 py-3 font-medium">Jurisdiction</th>
                <th className="px-4 py-3 font-medium">Note</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((r) => {
                const linked = clientByWallet.get(r.wallet);
                const clientId = linked?.id;
                const blockers = issueBlockers(r);
                const handled = r.status === "approved" || r.status === "rejected";
                return (
                  <tr key={r.id} className="text-slate-700">
                    <td className="px-4 py-3">
                      <p className="font-mono text-xs text-slate-900" title={r.wallet}>
                        {shortWallet(r.wallet)}
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        {new Date(r.created_at).toISOString().slice(0, 10)}
                      </p>
                      {linked && (
                        <span
                          className={`mt-1 inline-flex rounded-full border px-1.5 py-px text-[10px] font-semibold ${KYC_BADGE[linked.kyc_status]}`}
                          title={`Client dossier KYC status: ${linked.kyc_status}`}
                        >
                          KYC: {linked.kyc_status}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {r.jurisdiction != null
                        ? countryName(String(r.jurisdiction).padStart(3, "0"))
                        : "—"}
                    </td>
                    <td className="max-w-[16rem] px-4 py-3">
                      <p className="truncate text-xs text-slate-600" title={r.note ?? ""}>
                        {r.note || "—"}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${REQ_BADGE[r.status]}`}
                      >
                        {REQ_LABEL[r.status]}
                      </span>
                      {handled && r.handled_by && (
                        <p
                          className="mt-1 text-[11px] text-slate-400"
                          title={r.handled_by}
                        >
                          by {shortWallet(r.handled_by)}
                          {r.handled_at &&
                            ` · ${new Date(r.handled_at).toISOString().slice(0, 10)}`}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {handled ? (
                        clientId ? (
                          <Link
                            href={`/admin/clients/${clientId}`}
                            className="text-xs text-slate-600 underline-offset-2 hover:underline"
                          >
                            Open client →
                          </Link>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )
                      ) : (
                        <div className="flex flex-col items-end gap-1.5">
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            {r.status === "new" && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void markInReview(r)}
                                className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                              >
                                Mark in review
                              </button>
                            )}
                            {clientId && (
                              <Link
                                href={`/admin/clients/${clientId}`}
                                className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50"
                              >
                                Open client →
                              </Link>
                            )}
                            {isKycProvider && (
                              <button
                                type="button"
                                disabled={busy || tx.isSending || blockers.length > 0}
                                title={blockers[0]}
                                onClick={() => setConfirm({ action: "issue", req: r })}
                                className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                Issue passport
                              </button>
                            )}
                            <button
                              type="button"
                              // Rejecting a request whose passport is already
                              // on-chain would record the opposite of chain
                              // reality — repair the sync first.
                              disabled={busy || pendingUnsyncedIssue(unsyncedIssues, r) !== null}
                              title={
                                pendingUnsyncedIssue(unsyncedIssues, r)
                                  ? "A passport for this wallet is already on-chain — repair the off-chain sync first."
                                  : undefined
                              }
                              onClick={() => setConfirm({ action: "reject", req: r })}
                              className="rounded-md border border-red-200 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                            >
                              Reject
                            </button>
                          </div>
                          {pendingUnsyncedIssue(unsyncedIssues, r) && (
                            <button
                              type="button"
                              disabled={retrying === r.id || !clientId}
                              onClick={() => void retrySync(r)}
                              className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                            >
                              {retrying === r.id
                                ? "Retrying sync…"
                                : "Retry off-chain sync"}
                            </button>
                          )}
                          {blockers.length > 0 && (
                            <p className="max-w-[22rem] text-right text-[11px] leading-snug text-amber-700">
                              {blockers[0]}
                            </p>
                          )}
                          {!isKycProvider && blockers.length === 0 && (
                            <p className="text-[11px] text-slate-400">
                              Ready — only the KYC provider (registry authority
                              {registryAuthority
                                ? ` ${registryAuthority.toString().slice(0, 4)}…${registryAuthority.toString().slice(-4)}`
                                : ""}
                              ) issues the passport; the Super Admin role does not.
                            </p>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmModal
        open={confirm?.action === "issue"}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) =>
          confirm ? issueFromRequest(confirm.req, reason) : undefined
        }
        title="Issue on-chain passport"
        description={
          confirm && (
            <>
              Issue an investor passport (approve_holder) for{" "}
              <code className="font-mono text-xs">{confirm.req.wallet}</code>
              {confirm.req.jurisdiction != null && (
                <>
                  {" "}
                  in{" "}
                  {countryName(
                    String(confirm.req.jurisdiction).padStart(3, "0"),
                  )}
                </>
              )}
              {" "}(retail tier). Expiry follows the verified dossier&apos;s
              kyc_expires_at
              {(() => {
                const linked = clientByWallet.get(confirm.req.wallet);
                return linked?.kyc_expires_at
                  ? ` (${new Date(linked.kyc_expires_at).toISOString().slice(0, 10)})`
                  : ` (${KYC_VALIDITY_DAYS}-day default)`;
              })()}
              . The client record is updated with the transaction reference.
            </>
          )
        }
        confirmLabel="Issue passport"
        kind="info"
        busy={busy || tx.isSending}
      />
      <ConfirmModal
        open={confirm?.action === "reject"}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) =>
          confirm ? rejectRequest(confirm.req, reason) : undefined
        }
        title="Reject passport request"
        description={
          confirm && (
            <>
              Reject the passport request from{" "}
              <code className="font-mono text-xs">{confirm.req.wallet}</code>.
              The applicant can reapply later.
            </>
          )
        }
        confirmLabel="Reject"
        kind="destructive"
        busy={busy}
      />
    </div>
  );
}

function KycOps() {
  const conn = useWalletConnection();
  const [rows, setRows] = useState<ClientRow[] | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [tab, setTab] = useState<Tab>("pending");

  const refresh = useCallback(async () => {
    if (!conn.wallet) return;
    setRows(await listClients(conn.wallet));
    setNow(Date.now());
  }, [conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const counts = useMemo(() => {
    if (!rows)
      return { total: 0, verified: 0, pending: 0, rejected: 0, expired: 0, expiringSoon: 0 };
    const horizon = now + 30 * 24 * 60 * 60 * 1000;
    let expiringSoon = 0;
    for (const r of rows) {
      if (
        r.kyc_status === "verified" &&
        r.kyc_expires_at &&
        new Date(r.kyc_expires_at).getTime() < horizon
      ) {
        expiringSoon += 1;
      }
    }
    return {
      total: rows.length,
      verified: rows.filter((r) => r.kyc_status === "verified").length,
      pending: rows.filter((r) => r.kyc_status === "pending").length,
      rejected: rows.filter((r) => r.kyc_status === "rejected").length,
      expired: rows.filter((r) => r.kyc_status === "expired").length,
      expiringSoon,
    };
  }, [rows, now]);

  const totalReviewed = counts.verified + counts.rejected;
  const rejectionRate =
    totalReviewed === 0
      ? 0
      : Math.round((counts.rejected / totalReviewed) * 100);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const horizon = now + 30 * 24 * 60 * 60 * 1000;
    switch (tab) {
      case "pending":
        return rows
          .filter((r) => r.kyc_status === "pending")
          .sort((a, b) => a.created_at.localeCompare(b.created_at));
      case "expiring":
        return rows
          .filter(
            (r) =>
              r.kyc_status === "verified" &&
              r.kyc_expires_at &&
              new Date(r.kyc_expires_at).getTime() < horizon,
          )
          .sort((a, b) =>
            (a.kyc_expires_at ?? "").localeCompare(b.kyc_expires_at ?? ""),
          );
      case "expired":
        return rows.filter((r) => r.kyc_status === "expired");
      case "rejected":
        return rows
          .filter((r) => r.kyc_status === "rejected")
          .sort((a, b) => b.created_at.localeCompare(a.created_at));
      case "all":
        return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
  }, [rows, tab, now]);

  return (
    <div className="mt-8 space-y-6">
      {/* KPIs */}
      <section className="grid gap-3 sm:grid-cols-5">
        <Kpi label="Total" value={String(counts.total)} />
        <Kpi label="Verified" value={String(counts.verified)} />
        <Kpi label="Pending review" value={String(counts.pending)} tone={counts.pending > 0 ? "warn" : "default"} />
        <Kpi label="Expiring 30d" value={String(counts.expiringSoon)} tone={counts.expiringSoon > 0 ? "warn" : "default"} />
        <Kpi label="Rejection rate" value={`${rejectionRate}%`} />
      </section>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-1 text-xs">
        {(
          [
            ["pending", `Pending (${counts.pending})`],
            ["expiring", `Expiring 30d (${counts.expiringSoon})`],
            ["expired", `Expired (${counts.expired})`],
            ["rejected", `Rejected (${counts.rejected})`],
            ["all", `All (${counts.total})`],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1.5 transition-colors ${
              tab === t
                ? "bg-slate-900 text-white"
                : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Table */}
      {rows === null ? (
        <SkeletonTable rows={5} cols={5} />
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
          <p className="text-sm text-slate-600">
            Nothing in this tab — clean queue 🎉
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Client</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Submitted / Expires</th>
                <th className="px-4 py-3 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((r) => (
                <tr key={r.id} className="text-slate-700">
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">
                      {r.display_name || "(unnamed)"}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {r.email ?? "—"}{r.company_name && ` · ${r.company_name}`}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-xs">{r.type}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${KYC_BADGE[r.kyc_status]}`}
                    >
                      {r.kyc_status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {tab === "expiring" || tab === "expired"
                      ? r.kyc_expires_at
                        ? new Date(r.kyc_expires_at).toISOString().slice(0, 10)
                        : "—"
                      : new Date(r.created_at).toISOString().slice(0, 10)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/admin/clients/${r.id}`}
                      className="text-xs text-slate-600 underline-offset-2 hover:underline"
                    >
                      Review →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
