"use client";

// Vesting series form — the full intake from spec §11.1.2: token, recipients,
// schedule, timing/delivery mode, approval window, recovery, cancellation and
// the pre-cliff percentage. Used both for the initial submit and for
// resubmit-after-fixes (needs_changes).

import { address, isAddress } from "@solana/kit";
import { useSolanaClient } from "@solana/react-hooks";
import { U64_MAX, MAX_VESTING_RECIPIENTS } from "@/lib/vesting-terms";
import { useEffect, useMemo, useState } from "react";
import { FieldError, FieldLabel } from "@/components/field";
import {
  preflightVestingMint,
  type VestingMintPreflight,
} from "@/lib/vesting-mint-preflight";
import {
  describeAmount,
  fetchMintDecimals,
  formatTokenAmount,
  formatUtc,
  groupDigits,
  parseLocalDateTime,
  localZoneLabel,
  parseAmountInUnit,
  unixToLocalDateTime,
  type AmountUnit,
} from "@/lib/vesting-amounts";
import {
  MAX_APPROVAL_WINDOW_SECS,
  MAX_VESTING_TRANCHES,
  MIN_APPROVAL_WINDOW_SECS,
  type CreateVestingSeriesInput,
  type RecipientEntry,
  type ScheduleEntry,
} from "@/lib/vesting-series";

/** `at` is a datetime-local value (browser zone); converted to unix UTC on
 *  submit — see parseLocalDateTime. */
type TrancheRow = { at: string; pct: string };

/** Per-recipient draft: `amount` is text in the form's current unit. */
type RecipientDraft = { wallet: string; amount: string };

export type SeriesFormValues = {
  tokenMint: string;
  tokenLabel: string;
  timingMode: "auto" | "approval";
  deliveryMode: "push" | "claim";
  approvalWindowSecs: number;
  recoveryEnabled: boolean;
  cancellationEnabled: boolean;
  preCliffBps: number;
  schedule: ScheduleEntry[];
  recipients: RecipientEntry[];
};

export const EMPTY_FORM: SeriesFormValues = {
  tokenMint: "",
  tokenLabel: "",
  timingMode: "auto",
  deliveryMode: "claim",
  approvalWindowSecs: 86_400,
  recoveryEnabled: false,
  cancellationEnabled: false,
  preCliffBps: 0,
  schedule: [],
  recipients: [],
};

/** Wall clock in unix seconds — read only inside event handlers. */
function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Percent-based schedule → absolute tranche amounts. The last tranche
 *  absorbs rounding dust so the schedule total EXACTLY equals the sum of
 *  allocations — an on-chain release-time invariant. */
export function scheduleFromPercents(
  rows: { unlockTs: number; pct: string }[],
  totalAllocated: bigint,
): ScheduleEntry[] {
  const out: ScheduleEntry[] = [];
  let assigned = BigInt(0);
  rows.forEach((r, i) => {
    const ts = r.unlockTs;
    let amount: bigint;
    if (i === rows.length - 1) {
      amount = totalAllocated - assigned;
    } else {
      const pct = Number(r.pct);
      amount =
        (totalAllocated * BigInt(Math.round(pct * 100))) / BigInt(10_000);
    }
    assigned += amount;
    out.push({ unlock_ts: ts, amount: amount.toString() });
  });
  return out;
}

export function SeriesForm({
  initial,
  submitting,
  onSubmit,
  onClose,
  title,
}: {
  initial?: SeriesFormValues;
  submitting: boolean;
  onSubmit: (input: CreateVestingSeriesInput) => Promise<void>;
  onClose: () => void;
  title: string;
}) {
  const client = useSolanaClient();
  const [tokenMint, setTokenMint] = useState(initial?.tokenMint ?? "");
  const [tokenLabel, setTokenLabel] = useState(initial?.tokenLabel ?? "");
  // Stored allocations are base units, so a resubmit starts in base-unit
  // mode; the issuer can switch to tokens once the mint decimals are known.
  const [amountUnit, setAmountUnit] = useState<AmountUnit>(
    initial ? "base" : "token",
  );
  const [decimals, setDecimals] = useState<number | null>(null);
  const [decimalsError, setDecimalsError] = useState<string | null>(null);
  const [decimalsLoading, setDecimalsLoading] = useState(() =>
    isAddress((initial?.tokenMint ?? "").trim()),
  );
  /** Mint edits reset the decimals so a stale value never applies to a new
   *  address; the effect below re-reads them for a valid address. */
  function changeMint(value: string) {
    setTokenMint(value);
    setDecimals(null);
    setDecimalsError(null);
    setDecimalsLoading(isAddress(value.trim()));
  }
  const [recipients, setRecipients] = useState<RecipientDraft[]>(
    initial?.recipients.map((r) => ({
      wallet: r.wallet,
      amount: r.allocation,
    })) ?? [],
  );
  const [tranches, setTranches] = useState<TrancheRow[]>(() => {
    if (initial && initial.schedule.length > 0) {
      // Convert absolute amounts back to percents of the total.
      const total = initial.recipients.reduce(
        (a, r) => a + BigInt(r.allocation || "0"),
        BigInt(0),
      );
      return initial.schedule.map((t) => ({
        at: unixToLocalDateTime(t.unlock_ts),
        pct:
          total > BigInt(0)
            ? String(Number((BigInt(t.amount) * BigInt(10_000)) / total) / 100)
            : "",
      }));
    }
    return [{ at: "", pct: "100" }];
  });
  // Payload fingerprint the issuer has already reviewed; any edit invalidates
  // it so the exact on-chain amounts are always confirmed before submit.
  const [reviewedFingerprint, setReviewedFingerprint] = useState<
    string | null
  >(null);

  // Load the mint's decimals whenever the address becomes valid. Until they
  // are known, token-unit amounts are refused (never assumed 0 decimals).
  const mintTrimmed = tokenMint.trim();
  useEffect(() => {
    if (!isAddress(mintTrimmed)) return;
    let cancelled = false;
    fetchMintDecimals(client.runtime.rpc, address(mintTrimmed))
      .then((d) => {
        if (cancelled) return;
        setDecimals(d);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDecimalsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setDecimalsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, mintTrimmed]);

  // Mint support preflight (F05): the same token-program / extension rules
  // prepare-creation enforces after approval, run while the issuer types.
  // An approved request cannot return to review, so an unsupported mint must
  // be refused here — before the terms are ever submitted.
  // The stored result is keyed by the mint it was computed for, so "idle" /
  // "checking" are derived at render time instead of set synchronously.
  const [mintResult, setMintResult] = useState<{
    mint: string;
    result: VestingMintPreflight;
  } | null>(null);
  const [mintCheckNonce, setMintCheckNonce] = useState(0);
  useEffect(() => {
    if (!isAddress(mintTrimmed)) return;
    let cancelled = false;
    void preflightVestingMint(client.runtime.rpc, mintTrimmed).then((r) => {
      if (!cancelled) setMintResult({ mint: mintTrimmed, result: r });
    });
    return () => {
      cancelled = true;
    };
  }, [client, mintTrimmed, mintCheckNonce]);
  const mintCheck:
    | { status: "idle" }
    | { status: "checking" }
    | { status: "done"; result: VestingMintPreflight } = !isAddress(
    mintTrimmed,
  )
    ? { status: "idle" }
    : mintResult?.mint === mintTrimmed
      ? { status: "done", result: mintResult.result }
      : { status: "checking" };
  function recheckMint() {
    setMintResult(null);
    setMintCheckNonce((n) => n + 1);
  }
  const [timingMode, setTimingMode] = useState<"auto" | "approval">(
    initial?.timingMode ?? "auto",
  );
  const [deliveryMode, setDeliveryMode] = useState<"push" | "claim">(
    initial?.deliveryMode ?? "claim",
  );
  const [windowDays, setWindowDays] = useState(
    String((initial?.approvalWindowSecs ?? 86_400) / 86_400),
  );
  const [recovery, setRecovery] = useState(initial?.recoveryEnabled ?? false);
  const [cancellation, setCancellation] = useState(
    initial?.cancellationEnabled ?? false,
  );
  const [preCliffPct, setPreCliffPct] = useState(
    String((initial?.preCliffBps ?? 0) / 100),
  );
  const [error, setError] = useState<string | null>(null);

  const parsedRecipients = useMemo(
    () => recipients.map((r) => parseAmountInUnit(r.amount, amountUnit, decimals)),
    [recipients, amountUnit, decimals],
  );
  const totalAllocated = useMemo(
    () =>
      parsedRecipients.reduce(
        (a, p) => (p.ok ? a + p.baseUnits : a),
        BigInt(0),
      ),
    [parsedRecipients],
  );
  const parsedTranches = useMemo(
    () =>
      tranches.map((t) => {
        const parsed = parseLocalDateTime(t.at);
        return {
          unlockTs: parsed.ok ? parsed.ts : null,
          timeError: parsed.ok ? null : parsed.error,
          pct: t.pct,
        };
      }),
    [tranches],
  );
  const zoneLabel = useMemo(() => localZoneLabel(), []);

  /** Switch the amount unit, converting every parseable amount EXACTLY;
   *  unparseable text is kept verbatim so nothing is silently changed. */
  function switchUnit(next: AmountUnit) {
    if (next === amountUnit) return;
    if (next === "token" && decimals === null) return;
    setRecipients((rs) =>
      rs.map((r) => {
        const p = parseAmountInUnit(r.amount, amountUnit, decimals);
        if (!p.ok) return r;
        return {
          ...r,
          amount:
            next === "base"
              ? p.baseUnits.toString()
              : formatTokenAmount(p.baseUnits, decimals as number),
        };
      }),
    );
    setAmountUnit(next);
  }
  const totalPct = useMemo(
    () => tranches.reduce((a, t) => a + (Number(t.pct) || 0), 0),
    [tranches],
  );

  /** Pure validation (safe during render). The "first unlock is in the
   *  future" check depends on the clock and lives in submit(). */
  function validate(): string | null {
    if (!isAddress(tokenMint.trim()))
      return "Token mint must be a base58 address.";
    if (mintCheck.status !== "done")
      return "The token mint is still being verified — wait a moment.";
    if (!mintCheck.result.ok) return mintCheck.result.reason;
    if (recipients.length === 0 || recipients.length > MAX_VESTING_RECIPIENTS)
      return `Add 1–${MAX_VESTING_RECIPIENTS} recipients.`;
    if (amountUnit === "token" && decimalsError)
      return `Token decimals could not be read (${decimalsError}). Fix the mint address or enter base units.`;
    if (amountUnit === "token" && decimals === null)
      return "Token decimals are still loading — wait a moment or enter base units.";
    for (const [i, r] of recipients.entries()) {
      if (!isAddress(r.wallet.trim()))
        return `Recipient #${i + 1}: invalid wallet address.`;
      const p = parsedRecipients[i];
      if (!p.ok) return `Recipient #${i + 1}: ${p.error}`;
    }
    if (totalAllocated > U64_MAX)
      return "The total allocation exceeds the token program limit.";
    if (tranches.length === 0 || tranches.length > MAX_VESTING_TRANCHES)
      return `Schedule must have 1–${MAX_VESTING_TRANCHES} entries.`;
    if (Math.abs(totalPct - 100) > 0.0001)
      return `Tranche percentages must add up to 100 (now ${totalPct.toFixed(2)}).`;
    let prev = 0;
    for (const [i, t] of parsedTranches.entries()) {
      const ts = t.unlockTs;
      if (ts === null || ts <= 0)
        return `Tranche #${i + 1}: ${t.timeError ?? "pick a date and time."}`;
      if (ts <= prev) return "Tranche times must be strictly ascending.";
      prev = ts;
    }
    if (timingMode === "approval") {
      const w = Math.round(Number(windowDays) * 86_400);
      if (!(w >= MIN_APPROVAL_WINDOW_SECS && w <= MAX_APPROVAL_WINDOW_SECS))
        return "Approval window must be between 1 hour and 90 days.";
    }
    const pc = Number(preCliffPct);
    if (Number.isNaN(pc) || pc < 0 || pc > 100)
      return "Pre-cliff percentage must be 0–100.";
    return null;
  }

  /** The exact payload that would be sent — base units + unix UTC. Built
   *  only when validation passes. */
  function buildPayload(): CreateVestingSeriesInput {
    const rows = parsedTranches.map((t) => ({
      unlockTs: t.unlockTs ?? 0,
      pct: t.pct,
    }));
    const outRecipients: RecipientEntry[] = recipients.map((r, i) => {
      const p = parsedRecipients[i];
      return {
        wallet: r.wallet.trim(),
        allocation: p.ok ? p.baseUnits.toString() : "0",
      };
    });
    return {
      tokenMint: tokenMint.trim(),
      tokenLabel: tokenLabel.trim(),
      timingMode,
      deliveryMode,
      approvalWindowSecs:
        timingMode === "approval" ? Math.round(Number(windowDays) * 86_400) : 0,
      recoveryEnabled: recovery,
      cancellationEnabled: cancellation,
      preCliffBps: Math.round(Number(preCliffPct) * 100),
      schedule: scheduleFromPercents(rows, totalAllocated),
      recipients: outRecipients,
    };
  }

  const validationError = validate();
  const payload = validationError ? null : buildPayload();
  const fingerprint = payload ? JSON.stringify(payload) : null;
  const reviewed = fingerprint !== null && fingerprint === reviewedFingerprint;

  async function submit() {
    const err = validate();
    if (err || !payload || !fingerprint) {
      setError(err ?? "Fix the form before submitting.");
      return;
    }
    const firstUnlock = payload.schedule[0]?.unlock_ts ?? 0;
    if (firstUnlock <= currentUnixSeconds()) {
      setError(
        "The first unlock must be in the future; allow time for review, creation and funding.",
      );
      return;
    }
    setError(null);
    if (fingerprint !== reviewedFingerprint) {
      // First click: show the exact on-chain amounts and times for review.
      setReviewedFingerprint(fingerprint);
      return;
    }
    await onSubmit(payload);
  }

  const inputCls =
    "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none";

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mx-auto my-8 w-full max-w-3xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            {title}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            One series = one token + one schedule. Timing, delivery, approval
            window, recovery, cancellation and the pre-cliff percentage are
            fixed forever at creation (only cancellation can later be turned OFF
            — never back ON).
          </p>
        </div>

        <div className="space-y-5 px-5 py-4">
          {/* Token */}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <FieldLabel>Token mint (address)</FieldLabel>
              <input
                className={`${inputCls} font-mono text-xs`}
                value={tokenMint}
                onChange={(e) => changeMint(e.target.value)}
                placeholder="Mint address of the token to vest"
                aria-invalid={
                  mintCheck.status === "done" && !mintCheck.result.ok
                }
                aria-describedby="vesting-mint-support"
              />
              <p
                id="vesting-mint-support"
                role="status"
                className={`mt-1 text-xs ${
                  mintCheck.status === "done" && !mintCheck.result.ok
                    ? "font-medium text-red-600"
                    : "text-slate-500"
                }`}
              >
                {mintCheck.status === "idle"
                  ? "Supported: Token program mints, and Token-2022 mints whose only extensions are close authority, metadata / metadata pointer, group / group member (or their pointers) or a Mancipatio registry transfer hook. Any other extension (transfer fee, confidential transfer, non-transferable, interest-bearing, default account state, a bare permanent delegate, a foreign hook, …) is refused."
                  : mintCheck.status === "checking"
                    ? "Verifying mint support…"
                    : mintCheck.result.ok
                      ? `Supported mint (${mintCheck.result.programLabel}).`
                      : mintCheck.result.reason}
                {mintCheck.status === "done" &&
                  !mintCheck.result.ok &&
                  mintCheck.result.retryable && (
                    <>
                      {" "}
                      <button
                        type="button"
                        onClick={recheckMint}
                        className="underline underline-offset-2"
                      >
                        Re-check
                      </button>
                    </>
                  )}
              </p>
            </label>
            <label className="block">
              <FieldLabel>Label</FieldLabel>
              <input
                className={inputCls}
                value={tokenLabel}
                onChange={(e) => setTokenLabel(e.target.value)}
                placeholder="e.g. ACME team allocation"
              />
            </label>
          </div>

          {/* Recipients */}
          <div>
            <FieldLabel>Recipients (wallet + amount)</FieldLabel>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-slate-500">Amount unit:</span>
              {(["token", "base"] as const).map((u) => (
                <button
                  key={u}
                  type="button"
                  disabled={u === "token" && decimals === null}
                  onClick={() => switchUnit(u)}
                  className={`rounded-md border px-2.5 py-1 font-medium disabled:opacity-40 ${
                    amountUnit === u
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-300 text-slate-700 hover:border-slate-400"
                  }`}
                >
                  {u === "token"
                    ? decimals === null
                      ? "Tokens"
                      : `Tokens (${decimals} decimals)`
                    : "Base units (raw u64)"}
                </button>
              ))}
              <span className="text-slate-500">
                {!isAddress(mintTrimmed)
                  ? "Enter a valid mint to load its decimals."
                  : decimalsLoading
                    ? "Reading mint decimals…"
                    : decimalsError
                      ? `Mint decimals unavailable: ${decimalsError}`
                      : decimals !== null
                        ? `Mint has ${decimals} decimals — 1 token = ${groupDigits(BigInt(10) ** BigInt(decimals))} base units.`
                        : null}
              </span>
            </div>
            <div className="mt-2 space-y-2">
              {recipients.map((r, i) => {
                const parsed = parsedRecipients[i];
                return (
                  <div key={i} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <input
                        className={`${inputCls} flex-1 font-mono text-xs`}
                        value={r.wallet}
                        onChange={(e) =>
                          setRecipients((rs) =>
                            rs.map((x, j) =>
                              j === i ? { ...x, wallet: e.target.value } : x,
                            ),
                          )
                        }
                        placeholder="Recipient wallet"
                      />
                      <input
                        className={`${inputCls} w-40 text-right`}
                        inputMode="decimal"
                        value={r.amount}
                        onChange={(e) =>
                          setRecipients((rs) =>
                            rs.map((x, j) =>
                              j === i ? { ...x, amount: e.target.value } : x,
                            ),
                          )
                        }
                        placeholder={
                          amountUnit === "token" ? "Amount in tokens" : "Base units"
                        }
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setRecipients((rs) => rs.filter((_, j) => j !== i))
                        }
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-slate-400"
                      >
                        ✕
                      </button>
                    </div>
                    {r.amount.trim() !== "" && (
                      <p
                        className={`pl-1 text-right text-[11px] ${parsed.ok ? "text-slate-500" : "text-red-600"}`}
                      >
                        {parsed.ok
                          ? `= ${describeAmount(parsed.baseUnits, decimals)}`
                          : parsed.error}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() =>
                setRecipients((rs) => [...rs, { wallet: "", amount: "" }])
              }
              className="mt-2 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400"
            >
              + Add recipient
            </button>
            <p className="mt-1 text-xs text-slate-500">
              Total allocated: {describeAmount(totalAllocated, decimals)}
              {parsedRecipients.some((p) => !p.ok) && (
                <span className="text-red-600">
                  {" "}
                  (excludes rows with invalid amounts)
                </span>
              )}
            </p>
          </div>

          {/* Schedule */}
          <div>
            <FieldLabel>Release schedule (% of total per unlock time)</FieldLabel>
            <p className="mt-1 text-xs text-slate-500">
              Times are entered in your zone, {zoneLabel}, and stored on-chain
              as unix seconds (UTC). The UTC reading is shown next to each
              tranche.
            </p>
            <div className="mt-2 space-y-2">
              {tranches.map((t, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <input
                    type="datetime-local"
                    step={60}
                    className={`${inputCls} w-auto`}
                    value={t.at}
                    onChange={(e) =>
                      setTranches((ts) =>
                        ts.map((x, j) =>
                          j === i ? { ...x, at: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  <span className="min-w-[10rem] text-[11px] text-slate-500">
                    {parsedTranches[i].unlockTs !== null
                      ? formatUtc(parsedTranches[i].unlockTs as number)
                      : "— pick date and time"}
                  </span>
                  <input
                    className={`${inputCls} w-28 text-right`}
                    value={t.pct}
                    onChange={(e) =>
                      setTranches((ts) =>
                        ts.map((x, j) =>
                          j === i ? { ...x, pct: e.target.value } : x,
                        ),
                      )
                    }
                    placeholder="%"
                  />
                  <span className="text-xs text-slate-500">%</span>
                  {tranches.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        setTranches((ts) => ts.filter((_, j) => j !== i))
                      }
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-slate-400"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                onClick={() =>
                  setTranches((ts) => [...ts, { at: "", pct: "" }])
                }
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400"
              >
                + Add tranche
              </button>
              <p
                className={`text-xs ${Math.abs(totalPct - 100) > 0.0001 ? "font-semibold text-red-600" : "text-slate-500"}`}
              >
                Total: {totalPct.toFixed(2)}% (must equal 100%)
              </p>
            </div>
          </div>

          {/* Modes */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <FieldLabel>Timing</FieldLabel>
              <div className="mt-1.5 flex gap-2">
                {(["auto", "approval"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setTimingMode(m)}
                    className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                      timingMode === m
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-300 text-slate-700 hover:border-slate-400"
                    }`}
                  >
                    {m === "auto"
                      ? "Auto — releases on schedule"
                      : "Approval — each tranche approved"}
                  </button>
                ))}
              </div>
              {timingMode === "approval" && (
                <label className="mt-2 block">
                  <FieldLabel>Approval window (days)</FieldLabel>
                  <input
                    className={`${inputCls} w-32`}
                    value={windowDays}
                    onChange={(e) => setWindowDays(e.target.value)}
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    After the window lapses, a vested tranche is delivered
                    anyway — approval can delay, never freeze.
                  </p>
                </label>
              )}
            </div>
            <div>
              <FieldLabel>Delivery</FieldLabel>
              <div className="mt-1.5 flex gap-2">
                {(["push", "claim"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setDeliveryMode(m)}
                    className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                      deliveryMode === m
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-300 text-slate-700 hover:border-slate-400"
                    }`}
                  >
                    {m === "push"
                      ? "Push — delivered to recipients"
                      : "Claim — recipients withdraw"}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Recovery / cancellation */}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-start gap-2 rounded-lg border border-slate-200 p-3">
              <input
                type="checkbox"
                checked={recovery}
                onChange={(e) => setRecovery(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="text-sm font-medium text-slate-900">
                  Recovery
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  Lets you re-point a recipient&apos;s position to a replacement
                  wallet if they lose their key. Fixed forever at creation.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 rounded-lg border border-slate-200 p-3">
              <input
                type="checkbox"
                checked={cancellation}
                onChange={(e) => setCancellation(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="text-sm font-medium text-slate-900">
                  Cancellation
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  Lets you cancel the series: recipients keep everything vested,
                  only the unvested remainder returns to you. Can later be
                  turned OFF — never back ON.
                </span>
              </span>
            </label>
          </div>
          {cancellation && (
            <label className="block">
              <FieldLabel>Pre-cliff percentage (%)</FieldLabel>
              <input
                className={`${inputCls} w-32`}
                value={preCliffPct}
                onChange={(e) => setPreCliffPct(e.target.value)}
              />
              <p className="mt-1 text-xs text-slate-500">
                If cancelled before anything vests, each recipient keeps this
                share of their allocation (0 unless set). Fixed at creation.
              </p>
            </label>
          )}

          {reviewed && payload && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <p className="font-semibold uppercase tracking-wide">
                Exact on-chain values — confirm before submitting
              </p>
              <p className="mt-1">
                Amounts are sent in base units of the mint
                {decimals !== null ? ` (${decimals} decimals)` : ""}; unlock
                times as unix seconds (UTC).
              </p>
              <table className="mt-2 min-w-full text-left">
                <thead className="text-[10px] uppercase tracking-wider text-amber-800">
                  <tr>
                    <th className="py-1 pr-3">Recipient</th>
                    <th className="py-1 pr-3 text-right">Base units</th>
                    <th className="py-1 text-right">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.recipients.map((r, i) => (
                    <tr key={i}>
                      <td className="py-0.5 pr-3 font-mono">
                        {r.wallet.slice(0, 6)}…{r.wallet.slice(-4)}
                      </td>
                      <td className="py-0.5 pr-3 text-right font-mono">
                        {groupDigits(r.allocation)}
                      </td>
                      <td className="py-0.5 text-right font-mono">
                        {decimals !== null
                          ? formatTokenAmount(BigInt(r.allocation), decimals)
                          : "unknown decimals"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <table className="mt-2 min-w-full text-left">
                <thead className="text-[10px] uppercase tracking-wider text-amber-800">
                  <tr>
                    <th className="py-1 pr-3">Tranche</th>
                    <th className="py-1 pr-3">Unlock (UTC)</th>
                    <th className="py-1 pr-3">Unlock (local)</th>
                    <th className="py-1 text-right">Base units</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.schedule.map((t, i) => (
                    <tr key={i}>
                      <td className="py-0.5 pr-3">#{i + 1}</td>
                      <td className="py-0.5 pr-3 font-mono">
                        {formatUtc(t.unlock_ts)}
                      </td>
                      <td className="py-0.5 pr-3 font-mono">
                        {unixToLocalDateTime(t.unlock_ts).replace("T", " ")}
                      </td>
                      <td className="py-0.5 text-right font-mono">
                        {groupDigits(t.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2">
                Total {groupDigits(totalAllocated)} base units
                {decimals !== null
                  ? ` = ${formatTokenAmount(totalAllocated, decimals)} tokens`
                  : ""}
                . Editing any field clears this confirmation.
              </p>
            </div>
          )}

          {error && <FieldError error={error} />}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void submit()}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {submitting
              ? "Submitting…"
              : reviewed
                ? "Confirm & submit for review"
                : "Review exact amounts"}
          </button>
        </div>
      </div>
    </div>
  );
}
