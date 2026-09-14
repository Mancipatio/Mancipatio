"use client";

import { WalletRequired } from "@/components/wallet-required";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import type { Address } from "@solana/kit";
import { merkleRoot, snapshotLeaf } from "@/lib/merkle";
import { FieldError, FieldLabel } from "@/components/field";
import { RequireRole } from "@/components/require-role";
import {
  base58Pubkey,
  combine,
  required,
  validateAll,
} from "@/lib/form-validation";
import { recordAudit } from "@/lib/supabase";
import { useToast } from "@/lib/toast";
import { buildVestingMerkle, saveVestingSchedule } from "@/lib/vesting";

type CurveType = "cliff" | "linear" | "step" | "custom";

type Milestone = {
  index: number;
  date: string; // ISO yyyy-mm-dd
  amount: bigint;
};

type Beneficiary = {
  wallet: string;
  entitlement: bigint;
};

const CURVE_LABELS: Record<CurveType, string> = {
  cliff: "Cliff (one unlock)",
  linear: "Linear (monthly steps)",
  step: "Step (custom intervals)",
  custom: "Custom (editable table)",
};

function parseBigIntSafe(s: string, def = BigInt(0)): bigint {
  try {
    return BigInt(s.replace(/[^0-9]/g, "") || "0");
  } catch {
    return def;
  }
}

function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()),
  );
  return target.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function scheduleWithCumulative(
  rows: Milestone[],
): (Milestone & { cumulative: bigint })[] {
  const out: (Milestone & { cumulative: bigint })[] = [];
  let total = BigInt(0);
  for (const r of rows) {
    total = total + r.amount;
    out.push({ ...r, cumulative: total });
  }
  return out;
}

export default function VestingBuilderPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Rights Token
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Vesting curve builder
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">
          Generate a milestone schedule and a per-beneficiary Merkle root that
          can be pasted into{" "}
          <Link
            href="/admin/rights"
            className="text-slate-700 underline-offset-2 hover:underline"
          >
            /admin/rights
          </Link>{" "}
          for on-chain publish. v0.1 — schedule and beneficiaries live only in
          this page, so save the CSV before leaving.
        </p>
      </div>
      <RequireRole role="admin">
        <Builder />
      </RequireRole>
    </section>
  );
}

function Builder() {
  const router = useRouter();
  const conn = useWalletConnection();
  const wallet = conn.wallet?.account.address;
  const toast = useToast();

  // Persistence meta
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assetMint, setAssetMint] = useState("");
  const [assetLabel, setAssetLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const metaValidation = useMemo(
    () =>
      validateAll(
        { title, assetMint },
        {
          title: required("Title"),
          assetMint: combine(required("Asset mint"), base58Pubkey),
        },
      ),
    [title, assetMint],
  );
  const metaErrors = metaValidation.errors;
  const touch = (k: string) =>
    setTouched((t) => (t[k] ? t : { ...t, [k]: true }));

  // Curve config
  const [curve, setCurve] = useState<CurveType>("linear");
  const [totalAmount, setTotalAmount] = useState("100000");
  const [startDate, setStartDate] = useState(todayIso());
  const [durationMonths, setDurationMonths] = useState("12");
  const [stepCount, setStepCount] = useState("4");
  const [stepIntervalMonths, setStepIntervalMonths] = useState("3");
  const [cliffDate, setCliffDate] = useState(addMonths(todayIso(), 12));
  const [customRows, setCustomRows] = useState<Milestone[]>([
    { index: 0, date: addMonths(todayIso(), 3), amount: BigInt(25000) },
    { index: 1, date: addMonths(todayIso(), 6), amount: BigInt(25000) },
    { index: 2, date: addMonths(todayIso(), 9), amount: BigInt(25000) },
    { index: 3, date: addMonths(todayIso(), 12), amount: BigInt(25000) },
  ]);

  // Beneficiaries
  const [csv, setCsv] = useState("");

  // Computed schedule
  const schedule: Milestone[] = useMemo(() => {
    const total = parseBigIntSafe(totalAmount);
    if (curve === "cliff") {
      return [{ index: 0, date: cliffDate, amount: total }];
    }
    if (curve === "linear") {
      const months = Math.max(1, Number(durationMonths) || 12);
      const perStep = total / BigInt(months);
      const remainder = total - perStep * BigInt(months);
      const rows: Milestone[] = [];
      for (let i = 0; i < months; i += 1) {
        const date = addMonths(startDate, i + 1);
        const amount = i === months - 1 ? perStep + remainder : perStep;
        rows.push({ index: i, date, amount });
      }
      return rows;
    }
    if (curve === "step") {
      const n = Math.max(1, Number(stepCount) || 4);
      const interval = Math.max(1, Number(stepIntervalMonths) || 3);
      const perStep = total / BigInt(n);
      const remainder = total - perStep * BigInt(n);
      const rows: Milestone[] = [];
      for (let i = 0; i < n; i += 1) {
        const date = addMonths(startDate, (i + 1) * interval);
        const amount = i === n - 1 ? perStep + remainder : perStep;
        rows.push({ index: i, date, amount });
      }
      return rows;
    }
    // custom
    return customRows
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r, i) => ({ ...r, index: i }));
  }, [
    curve,
    totalAmount,
    startDate,
    durationMonths,
    stepCount,
    stepIntervalMonths,
    cliffDate,
    customRows,
  ]);

  const scheduleTotal = useMemo(
    () => schedule.reduce((acc, m) => acc + m.amount, BigInt(0)),
    [schedule],
  );

  // Beneficiaries — parse CSV
  const { beneficiaries, csvNote }: {
    beneficiaries: Beneficiary[];
    csvNote: string | null;
  } = useMemo(() => {
    if (!csv.trim()) return { beneficiaries: [], csvNote: null };
    const out: Beneficiary[] = [];
    const seen = new Set<string>();
    let note: string | null = null;
    let lineNo = 0;
    for (const raw of csv.split(/\r?\n/)) {
      lineNo += 1;
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(",").map((s) => s.trim());
      if (parts.length < 2) continue;
      const wallet = parts[0];
      const entStr = parts[1];
      if (!wallet || !entStr) continue;
      let ent: bigint;
      try {
        ent = BigInt(entStr.replace(/[^0-9]/g, "") || "0");
      } catch {
        continue;
      }
      if (ent === BigInt(0)) continue;
      if (seen.has(wallet)) {
        if (!note) note = `Duplicate wallet on line ${lineNo} ignored.`;
        continue;
      }
      seen.add(wallet);
      out.push({ wallet, entitlement: ent });
    }
    return { beneficiaries: out, csvNote: note };
  }, [csv]);

  const beneficiariesTotal = useMemo(
    () => beneficiaries.reduce((acc, b) => acc + b.entitlement, BigInt(0)),
    [beneficiaries],
  );

  // Per-milestone pool = beneficiaries split by their share, scaled by milestone amount.
  // Each milestone has the same Merkle root (the per-wallet entitlement is the
  // total entitlement; the on-chain claim pool varies per milestone).
  const [merkleHex, setMerkleHex] = useState<string>("");
  const [computing, setComputing] = useState(false);

  async function computeRoot() {
    if (beneficiaries.length === 0) {
      setMerkleHex("");
      return;
    }
    setComputing(true);
    try {
      const leaves = await Promise.all(
        beneficiaries.map((b) =>
          snapshotLeaf(b.wallet as Address, b.entitlement),
        ),
      );
      const root = await merkleRoot(leaves);
      setMerkleHex(
        Array.from(root)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
      );
    } finally {
      setComputing(false);
    }
  }

  async function saveToDb() {
    if (!conn.wallet || !wallet) return;
    if (!title.trim()) {
      toast.showError("Title required", "Give the schedule a name first");
      return;
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(assetMint)) {
      toast.showError("Asset mint required", "Paste the base58 mint address");
      return;
    }
    setSaving(true);
    try {
      const total = parseBigIntSafe(totalAmount);
      const built =
        beneficiaries.length > 0
          ? await buildVestingMerkle(
              beneficiaries.map((b) => ({
                wallet: b.wallet,
                entitlement: b.entitlement,
              })),
            )
          : null;

      // Signed admin-only route — author/status are stamped server-side.
      const scheduleId = await saveVestingSchedule(conn.wallet, {
        assetMint: assetMint.trim(),
        assetLabel: assetLabel.trim() || assetMint.slice(0, 8),
        title: title.trim(),
        description,
        curve,
        totalAmount: total,
        startDate: curve !== "cliff" && curve !== "custom" ? startDate : null,
        durationMonths:
          curve === "linear" ? Number(durationMonths) || null : null,
        stepCount: curve === "step" ? Number(stepCount) || null : null,
        stepIntervalMonths:
          curve === "step" ? Number(stepIntervalMonths) || null : null,
        cliffDate: curve === "cliff" ? cliffDate : null,
        merkleRootHex: built?.rootHex ?? null,
        milestones: schedule.map((m) => ({
          idx: m.index,
          unlockDate: m.date,
          amount: m.amount,
        })),
        beneficiaries: built
          ? built.perWallet.map((b) => ({
              wallet: b.wallet,
              entitlement: b.entitlement,
              merkleIndex: b.index,
              merkleProofHex: b.proofHex,
            }))
          : [],
      });
      if (built) setMerkleHex(built.rootHex);

      void recordAudit({
        ix_name: "save_vesting_schedule",
        category: "rights",
        actor_wallet: wallet,
        reason: title,
        target_label: assetLabel || assetMint.slice(0, 8),
        metadata: {
          schedule_id: scheduleId,
          curve,
          milestones: schedule.length,
          beneficiaries: beneficiaries.length,
        },
      });

      toast.show({
        kind: "success",
        title: "Schedule saved",
        description: built
          ? `${schedule.length} milestones, ${beneficiaries.length} beneficiaries, Merkle root computed.`
          : `${schedule.length} milestones saved. Add beneficiaries to build the Merkle tree.`,
      });
      router.push(`/issuer/vesting/${scheduleId}`);
    } catch (err) {
      toast.showError(
        "Save failed",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-8 space-y-8">
      {/* Step 0 — meta */}
      <Section
        title="0. Schedule meta"
        subtitle="Name and target asset. Required for save."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <FieldLabel required>Title</FieldLabel>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => touch("title")}
              placeholder="Founder vesting Q3"
              aria-invalid={touched.title && !!metaErrors.title}
              className={`mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none ${
                touched.title && metaErrors.title
                  ? "border-red-400 focus:border-red-500"
                  : "border-slate-300 focus:border-slate-400"
              }`}
            />
            <FieldError error={touched.title ? metaErrors.title : null} />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Asset label
            </span>
            <input
              value={assetLabel}
              onChange={(e) => setAssetLabel(e.target.value)}
              placeholder="ACME Series A"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
          <label className="block sm:col-span-2">
            <FieldLabel required>Asset mint (base58)</FieldLabel>
            <input
              value={assetMint}
              onChange={(e) => setAssetMint(e.target.value)}
              onBlur={() => touch("assetMint")}
              placeholder="Base58 mint address"
              aria-invalid={touched.assetMint && !!metaErrors.assetMint}
              className={`mt-1 w-full rounded-md border px-3 py-2 font-mono text-xs focus:outline-none ${
                touched.assetMint && metaErrors.assetMint
                  ? "border-red-400 focus:border-red-500"
                  : "border-slate-300 focus:border-slate-400"
              }`}
            />
            <FieldError
              error={touched.assetMint ? metaErrors.assetMint : null}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Description (optional)
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Quarterly grants for engineering hires"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
        </div>
      </Section>

      {/* Step 1 — curve */}
      <Section title="1. Vesting curve" subtitle="How the underlying unlocks over time.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {(["cliff", "linear", "step", "custom"] as CurveType[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setCurve(t)}
              className={`rounded-lg border px-4 py-3 text-left transition-colors ${
                curve === t
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
              }`}
            >
              <p className="text-xs font-semibold uppercase tracking-wider opacity-80">
                {t}
              </p>
              <p className="mt-1 text-sm font-medium">{CURVE_LABELS[t]}</p>
            </button>
          ))}
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Total amount (underlying base units)
            </span>
            <input
              value={totalAmount}
              inputMode="numeric"
              onChange={(e) =>
                setTotalAmount(e.target.value.replace(/[^0-9]/g, ""))
              }
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>

          {curve === "cliff" && (
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Cliff date
              </span>
              <input
                type="date"
                value={cliffDate}
                onChange={(e) => setCliffDate(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
          )}

          {curve !== "cliff" && curve !== "custom" && (
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Start date
              </span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
          )}

          {curve === "linear" && (
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Duration (months)
              </span>
              <input
                value={durationMonths}
                inputMode="numeric"
                onChange={(e) =>
                  setDurationMonths(e.target.value.replace(/[^0-9]/g, ""))
                }
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
          )}

          {curve === "step" && (
            <>
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Number of steps
                </span>
                <input
                  value={stepCount}
                  inputMode="numeric"
                  onChange={(e) =>
                    setStepCount(e.target.value.replace(/[^0-9]/g, ""))
                  }
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Interval (months between steps)
                </span>
                <input
                  value={stepIntervalMonths}
                  inputMode="numeric"
                  onChange={(e) =>
                    setStepIntervalMonths(e.target.value.replace(/[^0-9]/g, ""))
                  }
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                />
              </label>
            </>
          )}
        </div>

        {curve === "custom" && (
          <CustomEditor rows={customRows} onChange={setCustomRows} />
        )}
      </Section>

      {/* Step 2 — schedule preview */}
      <Section
        title="2. Schedule preview"
        subtitle={`${schedule.length} milestone${schedule.length === 1 ? "" : "s"} · total ${String(scheduleTotal)}`}
      >
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Unlock date</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 text-right font-medium">Cumulative</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {scheduleWithCumulative(schedule).map((m) => (
                <tr key={m.index} className="text-slate-700">
                  <td className="px-3 py-2 font-mono">#{m.index}</td>
                  <td className="px-3 py-2">{m.date}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {String(m.amount)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-500">
                    {String(m.cumulative)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Mancipatio&apos;s on-chain Rights program publishes one milestone at a
          time. Use the dates above to drive your publish cadence — paste each
          row&apos;s amount into &quot;Publish milestone&quot; in{" "}
          <Link href="/admin/rights" className="underline">
            /admin/rights
          </Link>
          .
        </p>
      </Section>

      {/* Step 3 — beneficiaries */}
      <Section
        title="3. Beneficiaries"
        subtitle={`${beneficiaries.length} entries · total entitlement ${String(beneficiariesTotal)}`}
      >
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
            CSV (wallet,entitlement — one per line; # starts a comment)
          </span>
          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            rows={8}
            placeholder="wallet1,100&#10;wallet2,250&#10;wallet3,75"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none"
          />
        </label>
        {csvNote && (
          <p className="mt-1 text-[11px] text-amber-700">{csvNote}</p>
        )}

        {beneficiaries.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Wallet</th>
                  <th className="px-3 py-2 text-right font-medium">Entitlement</th>
                  <th className="px-3 py-2 text-right font-medium">% of total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {beneficiaries.map((b) => {
                  const pct =
                    beneficiariesTotal > BigInt(0)
                      ? Number(
                          (b.entitlement * BigInt(10000)) /
                            beneficiariesTotal,
                        ) / 100
                      : 0;
                  return (
                    <tr key={b.wallet} className="text-slate-700">
                      <td className="px-3 py-2 font-mono text-xs">
                        {b.wallet.length > 16
                          ? `${b.wallet.slice(0, 6)}…${b.wallet.slice(-4)}`
                          : b.wallet}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {String(b.entitlement)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-500">
                        {pct.toFixed(2)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Step 4 — Merkle root */}
      <Section
        title="4. Generate Merkle root"
        subtitle="One root per milestone (same set of beneficiaries; amount varies per milestone)."
      >
        <button
          type="button"
          disabled={beneficiaries.length === 0 || computing}
          onClick={() => void computeRoot()}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {computing
            ? "Computing…"
            : beneficiaries.length === 0
              ? "Add beneficiaries first"
              : "Compute Merkle root"}
        </button>

        {merkleHex && (
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
            <p className="text-xs font-semibold text-emerald-900">
              Snapshot root (32 bytes, hex):
            </p>
            <p className="mt-2 break-all font-mono text-xs text-emerald-900">
              {merkleHex}
            </p>
            <p className="mt-3 text-xs text-emerald-900/80">
              Copy this and paste it into the &quot;Snapshot root&quot; field of{" "}
              <code className="rounded bg-emerald-100 px-1">publish_milestone</code>{" "}
              in <Link href="/admin/rights" className="underline">/admin/rights</Link>.
              Beneficiaries will run their claim from{" "}
              <Link href="/portfolio/rights" className="underline">
                /portfolio/rights
              </Link>
              .
            </p>
          </div>
        )}
      </Section>

      {/* Step 5 — save to DB */}
      <Section
        title="5. Save schedule"
        subtitle="Persist everything to the database. You can re-open and publish milestones from /issuer/vesting."
      >
        <p className="text-xs text-slate-600">
          Saves curve config, the {schedule.length} computed milestone
          {schedule.length === 1 ? "" : "s"}, and{" "}
          {beneficiaries.length === 0
            ? "(no beneficiaries yet)"
            : `${beneficiaries.length} beneficiaries with Merkle proofs`}
          .
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              // Touch everything so any pending validation surfaces on first
              // submit attempt instead of after the user moves on.
              setTouched({ title: true, assetMint: true });
              if (metaValidation.isValid) void saveToDb();
            }}
            disabled={saving || !wallet || !metaValidation.isValid}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save to /issuer/vesting"}
          </button>
          {!wallet && (
            <WalletRequired />
          )}
        </div>
      </Section>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function CustomEditor({
  rows,
  onChange,
}: {
  rows: Milestone[];
  onChange: (rows: Milestone[]) => void;
}) {
  function update(i: number, patch: Partial<Milestone>) {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function add() {
    onChange([
      ...rows,
      {
        index: rows.length,
        date: addMonths(todayIso(), (rows.length + 1) * 3),
        amount: BigInt(0),
      },
    ]);
  }
  function remove(i: number) {
    onChange(rows.filter((_, idx) => idx !== i));
  }
  return (
    <div className="mt-6 overflow-hidden rounded-lg border border-slate-200">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-3 py-2 font-medium">#</th>
            <th className="px-3 py-2 font-medium">Unlock date</th>
            <th className="px-3 py-2 font-medium">Amount</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="px-3 py-2 font-mono text-xs text-slate-500">
                #{i}
              </td>
              <td className="px-3 py-2">
                <input
                  type="date"
                  value={r.date}
                  onChange={(e) => update(i, { date: e.target.value })}
                  className="rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </td>
              <td className="px-3 py-2">
                <input
                  value={String(r.amount)}
                  inputMode="numeric"
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^0-9]/g, "") || "0";
                    update(i, { amount: BigInt(v) });
                  }}
                  className="w-32 rounded border border-slate-300 px-2 py-1 font-mono text-sm"
                />
              </td>
              <td className="px-3 py-2 text-right">
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="text-xs text-red-600 hover:text-red-800"
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-slate-100 bg-slate-50 px-3 py-2">
        <button
          type="button"
          onClick={add}
          className="text-xs font-medium text-slate-700 hover:text-slate-900"
        >
          + Add row
        </button>
      </div>
    </div>
  );
}
