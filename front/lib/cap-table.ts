// Cap table: the chain side of a share class next to the company register
// (register_entries, migration 0086), and the checks that tie them together.
//
// Pure and node-safe (no React, no browser or server-only import), so the
// same code builds the admin and issuer reconciliation (lib/server/cap-table
// reads the inputs), the CSV export and the public "Supply and conversions"
// panel: tests/cap-table.test.ts.
//
// What the program does (program/programs/asset_registry/src, read only):
//   - mint_to_treasury and buy raise circulating_supply AND lifetime_minted;
//   - realize_custody_vault and revert_custody_vault burn the whole escrow and
//     lower circulating_supply only: lifetime_minted never goes down;
//   - locked_supply is set to 0 when the class is created and nothing changes it.
// So lifetime_minted − circulating_supply is every unit the program burned:
// the conversions (a DeliveryEscrow realize), plus any clawback quarantine
// realize or revert. A holder can also burn units with the token program
// directly; the mint's supply then drops while the registry counters do not.
// Units are integers (mint decimals 0) and max_supply is 100 % of the company.
//
// Percentages: the register records the stake as written in the decision, in
// basis points with up to four decimals (percent_bps: 250 = 2.5 %). A figure
// is consistent with units ÷ max_supply when it equals that ratio rounded up
// or down at the precision written.

export type CheckState = "pass" | "warn" | "fail";

/** Display order of the checks. */
export const CHECK_IDS = [
  "units_balance",
  "entries_for_conversions",
  "entries_match_chain",
  "supply_identity",
  "mint_supply",
  "within_cap",
  "entry_percentages",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export const CHECK_TITLES: Record<CheckId, string> = {
  units_balance: "Converted units equal registered units",
  entries_for_conversions: "Every conversion has a register entry",
  entries_match_chain: "Every register entry matches a conversion on chain",
  supply_identity: "Issued minus burned equals outstanding",
  mint_supply: "Mint supply matches the counters and the holder accounts",
  within_cap: "Outstanding plus registered stays within 100 %",
  entry_percentages: "Recorded percentages match units ÷ max supply",
};

export type CapTableCheck = { id: CheckId; state: CheckState; title: string; detail: string };

/**
 * Who holds units, by the owner of the token account: the issuer authority's
 * own wallet (the treasury mint_to_treasury mints into), a custody vault of
 * the class, another registry escrow (OTC deal, offer, distribution, vesting,
 * rights), an account of another program, or any other wallet.
 */
export type HolderKind = "treasury" | "wallet" | "custody" | "escrow" | "program";

export const HOLDER_KIND_LABEL: Record<HolderKind, string> = {
  treasury: "Issuer treasury",
  wallet: "Wallet",
  custody: "Custody vault",
  escrow: "Registry escrow",
  program: "Program account",
};

export type VaultKind = "vesting" | "conversion_pending" | "delivery_escrow" | "redemption_queue";
export type VaultStateName = "active" | "triggered" | "realized" | "reverted" | "expired" | "returned";

/** The asset_registry VaultType and VaultState enums, in declaration order. */
export const VAULT_KINDS: readonly VaultKind[] = ["vesting", "conversion_pending", "delivery_escrow", "redemption_queue"];
export const VAULT_STATES: readonly VaultStateName[] = ["active", "triggered", "realized", "reverted", "expired", "returned"];

export type CustodyVaultFacts = {
  pda: string;
  vaultId: string;
  kind: VaultKind;
  state: VaultStateName;
  escrow: string;
  /** The escrow's balance; null when the escrow account is gone. */
  escrowUnits: bigint | null;
};

export type ChainHolder = { owner: string; units: bigint; kind: HolderKind };

export type ClassChainFacts = {
  shareClassPda: string;
  classIndex: number;
  mint: string;
  /** null = uncapped. */
  maxSupply: bigint | null;
  cumulativeCap: boolean;
  lifetimeMinted: bigint;
  circulatingSupply: bigint;
  lockedSupply: bigint;
  /** The Token-2022 mint's supply. */
  mintSupply: bigint;
  /** Live custody vaults of the class. */
  custodyVaults: CustodyVaultFacts[];
  /** Every holder of the mint; null when the holder list was not read (public view). */
  holders: ChainHolder[] | null;
};

export type ConversionStatusRead = "vault_opened" | "deposited" | "converted";

export type ConversionFacts = {
  id: string;
  shareClassPda: string;
  status: ConversionStatusRead;
  /** The requested (and deposited) units. */
  units: bigint;
  /** A converted request's proven burn (outcome evidence), when stored. */
  burned: bigint | null;
  realizeTx: string | null;
  vaultPda: string | null;
  holderWallet: string;
  /** The holder's dossier: admin views only. */
  clientId?: string | null;
  decidedAt: string | null;
};

export type RegisterEntryFacts = {
  id: string;
  shareClassPda: string;
  units: bigint;
  /** Basis points as a decimal string ("250", "12.34"). */
  percentBps: string;
  registry: string;
  /** Case number: admin and issuer views only. */
  decisionRef?: string;
  decisionDate: string;
  decisionDocSha256: string;
  conversionRequestId: string | null;
  realizeTx: string | null;
  status: "recorded" | "voided";
  createdAt?: string;
  // Admin views only:
  holderClientId?: string | null;
  note?: string;
  voidReason?: string | null;
  voidedBy?: string | null;
  voidedAt?: string | null;
  createdBy?: string;
};

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TEN = BigInt(10);
const HUNDRED = BigInt(100);
const BPS = BigInt(10_000);
/** Basis points are kept with four decimals (numeric(10, 4)). */
const BPS_SCALE = 4;

// ── Numbers ────────────────────────────────────────────────────────────────

const pow10 = (n: number) => TEN ** BigInt(n);

/** `value / 10^scale` as a decimal string without trailing zeros ("2.5", "250", "0.0001"). */
export function formatScaled(value: bigint, scale: number): string {
  const negative = value < ZERO;
  const abs = negative ? -value : value;
  const unit = pow10(scale);
  const whole = abs / unit;
  const fraction = (abs % unit).toString().padStart(scale, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** numerator / denominator, rounded half up to `decimals` places, as a trimmed decimal string. */
export function ratioText(numerator: bigint, denominator: bigint, decimals: number): string {
  if (denominator <= ZERO) throw new Error("ratioText needs a positive denominator");
  const scaled = numerator * pow10(decimals);
  const rounded = (scaled * BigInt(2) + denominator) / (denominator * BigInt(2));
  return formatScaled(rounded, decimals);
}

/** Percent of the company `units` are (max_supply = 100 %), up to six decimals; null when uncapped. */
export function percentOfSupply(units: bigint, maxSupply: bigint | null): string | null {
  if (maxSupply === null || maxSupply <= ZERO) return null;
  return ratioText(units * HUNDRED, maxSupply, 6);
}

/** Integer units with thousands separators ("10,000"). */
export function formatUnits(units: bigint | string): string {
  const text = typeof units === "bigint" ? units.toString() : units;
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export type ParsedBps = { scaled: bigint; decimals: number };

const BPS_RE = /^(0|[1-9]\d{0,4})(?:\.(\d{1,4}))?$/;

/**
 * Basis points (0 < bps ≤ 10,000, up to four decimals) from their decimal
 * text ("250", "12.34", "250.0000" as the database returns it); null when
 * malformed or out of range. `decimals` is the precision written, trailing
 * zeros dropped.
 */
export function parseBps(text: string): ParsedBps | null {
  const match = BPS_RE.exec(text.trim());
  if (!match) return null;
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  const scaled = BigInt(match[1]) * pow10(BPS_SCALE) + BigInt(fraction.padEnd(BPS_SCALE, "0") || "0");
  if (scaled <= ZERO || scaled > BPS * pow10(BPS_SCALE)) return null;
  return { scaled, decimals: fraction.length };
}

/** The normalized text of valid basis points ("250", "12.34"); null when invalid. */
export function normalizeBps(text: string): string | null {
  const parsed = parseBps(text);
  return parsed ? formatScaled(parsed.scaled, BPS_SCALE) : null;
}

const PERCENT_RE = /^(0|[1-9]\d{0,2})(?:\.(\d{1,6}))?$/;

/**
 * The percent written in a registry decision ("2.5", "2,5", "0.0037") as
 * basis points ("250", "0.37"); null when malformed, zero, above 100 % or
 * finer than four decimals of a basis point (six of a percent).
 */
export function percentToBps(percent: string): string | null {
  const match = PERCENT_RE.exec(percent.trim().replace(/\s*%$/, "").replace(",", "."));
  if (!match) return null;
  // percent × 10^6 is basis points × 10^4.
  const scaled = BigInt(match[1]) * pow10(6) + BigInt((match[2] ?? "").padEnd(6, "0") || "0");
  if (scaled <= ZERO || scaled > HUNDRED * pow10(6)) return null;
  return formatScaled(scaled, BPS_SCALE);
}

/** Basis points text as a percent ("250" → "2.5"); "" when invalid. */
export function bpsToPercent(bps: string): string {
  const parsed = parseBps(bps);
  return parsed ? formatScaled(parsed.scaled, 6) : "";
}

/** The exact share `units / maxSupply` in basis points, up to four decimals, rounded half up. */
export function unitsToBps(units: bigint, maxSupply: bigint): string {
  return ratioText(units * BPS, maxSupply, BPS_SCALE);
}

/**
 * Whether `bps` (as written) equals units ÷ max_supply rounded up or down at
 * the precision written: 250 for 250 of 10,000; 3333.33 or 3333.34 for 1 of 3.
 */
export function bpsConsistent(bps: string, units: bigint, maxSupply: bigint): boolean {
  const parsed = parseBps(bps);
  if (!parsed || maxSupply <= ZERO) return false;
  const written = parsed.scaled / pow10(BPS_SCALE - parsed.decimals);
  const exact = units * BPS * pow10(parsed.decimals);
  const low = exact / maxSupply;
  const high = exact % maxSupply === ZERO ? low : low + ONE;
  return written >= low && written <= high;
}

function sum(values: Iterable<bigint>): bigint {
  let total = ZERO;
  for (const v of values) total += v;
  return total;
}

const STATE_RANK: Record<CheckState, number> = { pass: 0, warn: 1, fail: 2 };

/** The most severe of `states` ("pass" for none). */
export function worstState(states: Iterable<CheckState>): CheckState {
  let worst: CheckState = "pass";
  for (const s of states) if (STATE_RANK[s] > STATE_RANK[worst]) worst = s;
  return worst;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const short = (value: string) => (value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value);

// ── Reconciliation ─────────────────────────────────────────────────────────

export type HolderView = { owner: string; units: string; percent: string | null; kind: HolderKind };

export type ConversionView = {
  id: string;
  status: ConversionStatusRead;
  units: string;
  burned: string | null;
  realize_tx: string | null;
  vault_pda: string | null;
  holder_wallet: string;
  decided_at: string | null;
  /** The chain balance of an open request's vault escrow. */
  escrow_units: string | null;
  /** The recorded register entry that covers it. */
  register_entry_id: string | null;
  /** Admin views only. */
  client_id?: string | null;
};

export type RegisterEntryView = {
  id: string;
  units: string;
  percent_bps: string;
  percent: string;
  registry: string;
  decision_ref?: string;
  decision_date: string;
  decision_doc_sha256: string;
  conversion_request_id: string | null;
  realize_tx: string | null;
  status: "recorded" | "voided";
  created_at?: string;
  holder_client_id?: string | null;
  note?: string;
  void_reason?: string | null;
  voided_by?: string | null;
  voided_at?: string | null;
  created_by?: string;
};

export type ClassReconciliation = {
  share_class_pda: string;
  class_index: number;
  mint: string;
  chain: {
    max_supply: string | null;
    /** Percent of the company one unit is; null when uncapped. */
    unit_percent: string | null;
    cumulative_cap: boolean;
    lifetime_minted: string;
    circulating: string;
    locked: string;
    /** lifetime_minted − circulating: every unit the program burned. */
    burned: string;
    burned_by_conversions: string;
    mint_supply: string;
    /** Units in the escrows of open conversion requests. */
    in_conversion: string;
    /** Units in every custody vault escrow of the class. */
    custody_escrow: string;
    treasury: string | null;
    other_wallets: string | null;
    program_escrows: string | null;
    holder_count: number | null;
    holders_total: string | null;
  };
  register: {
    entries: number;
    units: string;
    percent_bps: string;
    percent: string;
    decision_refs?: string[];
  };
  holders: HolderView[] | null;
  conversions: ConversionView[];
  entries: RegisterEntryView[];
  checks: CapTableCheck[];
  state: CheckState;
};

export type AssetIdentity = {
  asset_pda: string;
  asset_id: string;
  name: string;
  symbol: string;
  issuer_pda: string;
};

export type AssetReconciliation = AssetIdentity & {
  network: string;
  generated_at: string;
  classes: ClassReconciliation[];
  state: CheckState;
};

const OPEN_VAULT_STATES: ReadonlySet<VaultStateName> = new Set(["active", "triggered"]);

function check(id: CheckId, state: CheckState, detail: string): CapTableCheck {
  return { id, state, title: CHECK_TITLES[id], detail };
}

/** The recorded entry covering each converted request: linked by id first, else by realize signature. */
function coverage(converted: ConversionFacts[], recorded: RegisterEntryFacts[]): Map<string, RegisterEntryFacts[]> {
  const byRequest = new Map<string, RegisterEntryFacts[]>(converted.map((c) => [c.id, []]));
  const byTx = new Map(converted.filter((c) => c.realizeTx).map((c) => [c.realizeTx as string, c.id]));
  for (const entry of recorded) {
    const requestId = entry.conversionRequestId ?? (entry.realizeTx ? byTx.get(entry.realizeTx) : undefined);
    if (requestId && byRequest.has(requestId)) byRequest.get(requestId)!.push(entry);
  }
  return byRequest;
}

/**
 * The reconciliation of one share class: chain facts, conversion requests and
 * register entries of THAT class (the caller filters), with every check.
 */
export function reconcileShareClass(
  chain: ClassChainFacts,
  conversions: ConversionFacts[],
  entries: RegisterEntryFacts[],
): ClassReconciliation {
  const max = chain.maxSupply;
  const converted = conversions.filter((c) => c.status === "converted");
  const open = conversions.filter((c) => c.status !== "converted");
  const recorded = entries.filter((e) => e.status === "recorded");
  const covered = coverage(converted, recorded);
  const convertedIds = new Set(converted.map((c) => c.id));
  const convertedByTx = new Map(converted.filter((c) => c.realizeTx).map((c) => [c.realizeTx as string, c]));
  const vaultByPda = new Map(chain.custodyVaults.map((v) => [v.pda, v]));

  // ── Chain figures ──
  const burned = chain.lifetimeMinted - chain.circulatingSupply;
  const burnedByConversions = sum(converted.map((c) => c.burned ?? c.units));
  const openVaults = new Set(open.map((c) => c.vaultPda).filter((p): p is string => Boolean(p)));
  const escrowOf = (pda: string | null): bigint | null => {
    const vault = pda ? vaultByPda.get(pda) : undefined;
    return vault && OPEN_VAULT_STATES.has(vault.state) ? vault.escrowUnits ?? ZERO : null;
  };
  const inConversion = sum([...openVaults].map((pda) => escrowOf(pda) ?? ZERO));
  const custodyEscrow = sum(chain.custodyVaults.map((v) => v.escrowUnits ?? ZERO));
  const holders = chain.holders;
  const byKind = (kinds: HolderKind[]) => (holders ? sum(holders.filter((h) => kinds.includes(h.kind)).map((h) => h.units)) : null);
  const holdersTotal = holders ? sum(holders.map((h) => h.units)) : null;

  // ── Register figures ──
  const registeredUnits = sum(recorded.map((e) => e.units));
  const registeredBps = sum(recorded.map((e) => parseBps(e.percentBps)?.scaled ?? ZERO));

  const checks: CapTableCheck[] = [];
  const missing = converted.filter((c) => (covered.get(c.id) ?? []).length === 0);
  const missingUnits = sum(missing.map((c) => c.units));

  // 1. Converted units == registered units.
  const convertedUnits = sum(converted.map((c) => c.units));
  if (converted.length === 0 && recorded.length === 0) {
    checks.push(check("units_balance", "pass", "No conversions and no register entries yet."));
  } else if (convertedUnits === registeredUnits) {
    checks.push(check("units_balance", "pass",
      `${formatUnits(convertedUnits)} units converted and burned; ${formatUnits(registeredUnits)} units registered.`));
  } else if (registeredUnits < convertedUnits && convertedUnits - registeredUnits === missingUnits) {
    checks.push(check("units_balance", "warn",
      `${formatUnits(convertedUnits)} units converted, ${formatUnits(registeredUnits)} registered: the ${formatUnits(missingUnits)} still to register belong to conversions without an entry.`));
  } else {
    checks.push(check("units_balance", "fail",
      `${formatUnits(convertedUnits)} units converted and burned, but ${formatUnits(registeredUnits)} units registered.`));
  }

  // 2. Every converted request has a recorded entry.
  if (converted.length === 0) {
    checks.push(check("entries_for_conversions", "pass", "No converted requests yet."));
  } else if (missing.length === 0) {
    checks.push(check("entries_for_conversions", "pass", `${plural(converted.length, "converted request")}, each with a register entry.`));
  } else {
    checks.push(check("entries_for_conversions", "warn",
      `${plural(missing.length, "converted request")} without a register entry (${missing.map((c) => short(c.id)).join(", ")}): record the entry after the registry decision.`));
  }

  // 3. Every recorded entry matches a converted request of this class.
  const problems: string[] = [];
  const notes: string[] = [];
  for (const entry of recorded) {
    const label = `Entry ${short(entry.id)}`;
    if (entry.conversionRequestId) {
      const request = converted.find((c) => c.id === entry.conversionRequestId);
      if (!request) {
        problems.push(`${label} links request ${short(entry.conversionRequestId)}, which is not a converted request of this class.`);
        continue;
      }
      if (request.units !== entry.units) {
        problems.push(`${label} registers ${formatUnits(entry.units)} units; its conversion moved ${formatUnits(request.units)}.`);
      }
      if (entry.realizeTx && request.realizeTx !== entry.realizeTx) {
        problems.push(`${label} names a realize transaction other than its conversion's.`);
      }
    } else if (entry.realizeTx) {
      const request = convertedByTx.get(entry.realizeTx);
      if (!request) {
        problems.push(`${label} names realize transaction ${short(entry.realizeTx)}, which no converted request of this class recorded.`);
      } else if (request.units !== entry.units) {
        problems.push(`${label} registers ${formatUnits(entry.units)} units; the conversion of its realize transaction moved ${formatUnits(request.units)}.`);
      }
    } else {
      notes.push(`${label} is not linked to a conversion or a realize transaction.`);
    }
  }
  for (const [requestId, list] of covered) {
    if (list.length > 1) problems.push(`${plural(list.length, "entry", "entries")} register request ${short(requestId)}.`);
  }
  if (recorded.length === 0) {
    checks.push(check("entries_match_chain", "pass", "No register entries yet."));
  } else if (problems.length > 0) {
    checks.push(check("entries_match_chain", "fail", [...problems, ...notes].join(" ")));
  } else if (notes.length > 0) {
    checks.push(check("entries_match_chain", "warn", notes.join(" ")));
  } else {
    checks.push(check("entries_match_chain", "pass", `${plural(recorded.length, "register entry", "register entries")}, each matching a converted request.`));
  }

  // 4. lifetime_minted − burned == circulating.
  if (burned < ZERO) {
    checks.push(check("supply_identity", "fail",
      `Circulating supply ${formatUnits(chain.circulatingSupply)} exceeds the lifetime minted ${formatUnits(chain.lifetimeMinted)}.`));
  } else if (burned === burnedByConversions) {
    checks.push(check("supply_identity", "pass",
      `${formatUnits(chain.lifetimeMinted)} issued − ${formatUnits(burnedByConversions)} burned through conversions = ${formatUnits(chain.circulatingSupply)} outstanding.`));
  } else if (burned > burnedByConversions) {
    checks.push(check("supply_identity", "warn",
      `${formatUnits(burned - burnedByConversions)} of the ${formatUnits(burned)} burned units were not burned by a recorded conversion (a clawback quarantine, a revert, or a realize the platform did not record).`));
  } else {
    checks.push(check("supply_identity", "fail",
      `Recorded conversions burned ${formatUnits(burnedByConversions)} units, but the chain shows only ${formatUnits(burned)} burned (${formatUnits(chain.lifetimeMinted)} issued, ${formatUnits(chain.circulatingSupply)} outstanding).`));
  }

  // 5. Mint supply == circulating (== the holder accounts).
  {
    const parts: CapTableCheck["state"][] = [];
    const details: string[] = [];
    if (chain.mintSupply === chain.circulatingSupply) {
      parts.push("pass");
      details.push(`Mint supply ${formatUnits(chain.mintSupply)} = circulating supply.`);
    } else if (chain.mintSupply < chain.circulatingSupply) {
      parts.push("warn");
      details.push(`Mint supply ${formatUnits(chain.mintSupply)} is ${formatUnits(chain.circulatingSupply - chain.mintSupply)} below the circulating supply: units were burned with the token program directly, outside the registry's counters.`);
    } else {
      parts.push("fail");
      details.push(`Mint supply ${formatUnits(chain.mintSupply)} exceeds the circulating supply ${formatUnits(chain.circulatingSupply)}.`);
    }
    if (holdersTotal !== null && holders) {
      if (holdersTotal === chain.mintSupply) {
        parts.push("pass");
        details.push(`${plural(holders.length, "holder")} hold ${formatUnits(holdersTotal)} units.`);
      } else {
        parts.push("warn");
        details.push(`The holder accounts read add up to ${formatUnits(holdersTotal)}, not ${formatUnits(chain.mintSupply)}: refresh; an account may have changed during the read.`);
      }
    }
    checks.push(check("mint_supply", worstState(parts), details.join(" ")));
  }

  // 6. circulating + registered ≤ max_supply.
  if (max === null) {
    checks.push(check("within_cap", "warn", "The class has no max supply, so 100 % is not defined on chain."));
  } else {
    const represented = chain.circulatingSupply + registeredUnits;
    const text = `${formatUnits(chain.circulatingSupply)} outstanding + ${formatUnits(registeredUnits)} registered = ${formatUnits(represented)} of ${formatUnits(max)} units`;
    checks.push(represented <= max
      ? check("within_cap", "pass", `${text} (${percentOfSupply(represented, max)} %).`)
      : check("within_cap", "fail", `${text}: more than 100 % of the company is represented.`));
  }

  // 7. Each entry's percent matches units ÷ max_supply.
  if (recorded.length === 0) {
    checks.push(check("entry_percentages", "pass", "No register entries yet."));
  } else if (max === null || max <= ZERO) {
    checks.push(check("entry_percentages", "warn", "The class has no max supply, so the recorded percentages cannot be checked."));
  } else {
    const off = recorded.filter((e) => !bpsConsistent(e.percentBps, e.units, max));
    checks.push(off.length === 0
      ? check("entry_percentages", "pass", `Every recorded percentage matches units ÷ ${formatUnits(max)}.`)
      : check("entry_percentages", "warn", off.map((e) =>
          `Entry ${short(e.id)}: ${bpsToPercent(e.percentBps)} % recorded, ${formatUnits(e.units)} ${e.units === ONE ? "unit is" : "units are"} ${percentOfSupply(e.units, max)} %.`).join(" ")));
  }

  const coveringEntry = new Map<string, string>();
  for (const [requestId, list] of covered) if (list.length > 0) coveringEntry.set(requestId, list[0].id);

  return {
    share_class_pda: chain.shareClassPda,
    class_index: chain.classIndex,
    mint: chain.mint,
    chain: {
      max_supply: max === null ? null : max.toString(),
      unit_percent: percentOfSupply(ONE, max),
      cumulative_cap: chain.cumulativeCap,
      lifetime_minted: chain.lifetimeMinted.toString(),
      circulating: chain.circulatingSupply.toString(),
      locked: chain.lockedSupply.toString(),
      burned: (burned < ZERO ? ZERO : burned).toString(),
      burned_by_conversions: burnedByConversions.toString(),
      mint_supply: chain.mintSupply.toString(),
      in_conversion: inConversion.toString(),
      custody_escrow: custodyEscrow.toString(),
      treasury: byKind(["treasury"])?.toString() ?? null,
      other_wallets: byKind(["wallet"])?.toString() ?? null,
      program_escrows: byKind(["escrow", "program"])?.toString() ?? null,
      holder_count: holders ? holders.length : null,
      holders_total: holdersTotal === null ? null : holdersTotal.toString(),
    },
    register: {
      entries: recorded.length,
      units: registeredUnits.toString(),
      percent_bps: formatScaled(registeredBps, BPS_SCALE),
      percent: formatScaled(registeredBps, 6),
      ...(recorded.some((e) => e.decisionRef !== undefined)
        ? { decision_refs: [...new Set(recorded.map((e) => e.decisionRef).filter((r): r is string => Boolean(r)))] }
        : {}),
    },
    holders: holders
      ? [...holders]
          .sort((a, b) => (a.units === b.units ? (a.owner < b.owner ? -1 : 1) : a.units > b.units ? -1 : 1))
          .map((h) => ({ owner: h.owner, units: h.units.toString(), percent: percentOfSupply(h.units, max), kind: h.kind }))
      : null,
    conversions: conversions.map((c) => {
      const escrow = c.status === "converted" ? null : escrowOf(c.vaultPda);
      return {
        id: c.id,
        status: c.status,
        units: c.units.toString(),
        burned: c.burned === null ? null : c.burned.toString(),
        realize_tx: c.realizeTx,
        vault_pda: c.vaultPda,
        holder_wallet: c.holderWallet,
        decided_at: c.decidedAt,
        escrow_units: escrow === null ? null : escrow.toString(),
        register_entry_id: convertedIds.has(c.id) ? coveringEntry.get(c.id) ?? null : null,
        ...(c.clientId !== undefined ? { client_id: c.clientId } : {}),
      };
    }),
    entries: entries.map((e) => registerEntryView(e)),
    checks,
    state: worstState(checks.map((c) => c.state)),
  };
}

/** The view of one register entry: the columns its facts carry (an audience's facts carry only its own). */
export function registerEntryView(e: RegisterEntryFacts): RegisterEntryView {
  const view: RegisterEntryView = {
    id: e.id,
    units: e.units.toString(),
    percent_bps: normalizeBps(e.percentBps) ?? e.percentBps,
    percent: bpsToPercent(e.percentBps),
    registry: e.registry,
    decision_date: e.decisionDate,
    decision_doc_sha256: e.decisionDocSha256,
    conversion_request_id: e.conversionRequestId,
    realize_tx: e.realizeTx,
    status: e.status,
  };
  if (e.decisionRef !== undefined) view.decision_ref = e.decisionRef;
  if (e.createdAt !== undefined) view.created_at = e.createdAt;
  if (e.holderClientId !== undefined) view.holder_client_id = e.holderClientId;
  if (e.note !== undefined) view.note = e.note;
  if (e.voidReason !== undefined) view.void_reason = e.voidReason;
  if (e.voidedBy !== undefined) view.voided_by = e.voidedBy;
  if (e.voidedAt !== undefined) view.voided_at = e.voidedAt;
  if (e.createdBy !== undefined) view.created_by = e.createdBy;
  return view;
}

/** One asset's reconciliation: each class with ITS conversions and entries. */
export function reconcileAsset(
  identity: AssetIdentity,
  network: string,
  classes: ClassChainFacts[],
  conversions: ConversionFacts[],
  entries: RegisterEntryFacts[],
  generatedAt: Date = new Date(),
): AssetReconciliation {
  const rows = classes.map((chain) => reconcileShareClass(
    chain,
    conversions.filter((c) => c.shareClassPda === chain.shareClassPda),
    entries.filter((e) => e.shareClassPda === chain.shareClassPda),
  ));
  return {
    ...identity,
    network,
    generated_at: generatedAt.toISOString(),
    classes: rows,
    state: worstState(rows.map((r) => r.state)),
  };
}

// ── Public view ────────────────────────────────────────────────────────────

/** A conversion record as the public sees it: no case number, no person, no request. */
export type PublicConversionRecord = {
  decision_date: string;
  units: string;
  percent: string;
  registry: string;
  decision_doc_sha256: string;
  realize_tx: string | null;
};

export type PublicSupplyClass = {
  share_class_pda: string;
  class_index: number;
  mint: string;
  max_supply: string | null;
  unit_percent: string | null;
  issued: string;
  outstanding: string;
  in_conversion: string;
  converted: { count: number; units: string; percent: string };
  records: PublicConversionRecord[];
};

export type PublicSupply = {
  network: string;
  asset_pda: string;
  generated_at: string;
  classes: PublicSupplyClass[];
};

/**
 * The public "Supply and conversions" figures of one class: built only from
 * public chain data and the non-personal columns of recorded entries. The
 * open conversions are used for their vaults only (the units in conversion).
 */
export function publicSupplyClass(
  chain: Omit<ClassChainFacts, "holders">,
  openConversions: Pick<ConversionFacts, "status" | "vaultPda">[],
  recorded: Pick<RegisterEntryFacts, "units" | "percentBps" | "registry" | "decisionDate" | "decisionDocSha256" | "realizeTx" | "status">[],
): PublicSupplyClass {
  const vaultByPda = new Map(chain.custodyVaults.map((v) => [v.pda, v]));
  const openVaults = new Set(openConversions
    .filter((c) => c.status === "vault_opened" || c.status === "deposited")
    .map((c) => c.vaultPda)
    .filter((p): p is string => Boolean(p)));
  const inConversion = sum([...openVaults].map((pda) => {
    const vault = vaultByPda.get(pda);
    return vault && OPEN_VAULT_STATES.has(vault.state) ? vault.escrowUnits ?? ZERO : ZERO;
  }));
  const entries = recorded
    .filter((e) => e.status === "recorded")
    .sort((a, b) => (a.decisionDate === b.decisionDate ? 0 : a.decisionDate < b.decisionDate ? -1 : 1));
  const bps = sum(entries.map((e) => parseBps(e.percentBps)?.scaled ?? ZERO));
  return {
    share_class_pda: chain.shareClassPda,
    class_index: chain.classIndex,
    mint: chain.mint,
    max_supply: chain.maxSupply === null ? null : chain.maxSupply.toString(),
    unit_percent: percentOfSupply(ONE, chain.maxSupply),
    issued: chain.lifetimeMinted.toString(),
    outstanding: chain.circulatingSupply.toString(),
    in_conversion: inConversion.toString(),
    converted: {
      count: entries.length,
      units: sum(entries.map((e) => e.units)).toString(),
      percent: formatScaled(bps, 6),
    },
    records: entries.map((e) => ({
      decision_date: e.decisionDate,
      units: e.units.toString(),
      percent: bpsToPercent(e.percentBps),
      registry: e.registry,
      decision_doc_sha256: e.decisionDocSha256,
      realize_tx: e.realizeTx,
    })),
  };
}

// ── Issuer view ────────────────────────────────────────────────────────────

/**
 * What the issuer sees: wallets, units and decision references. No dossier
 * link, no staff note or void reason, no voided entry, no staff wallet. The
 * server never reads those columns for the issuer (lib/server/cap-table.ts);
 * this strips them again in case a caller passes an admin reconciliation.
 */
export function issuerReconciliation(table: AssetReconciliation): AssetReconciliation {
  return {
    ...table,
    classes: table.classes.map((c) => ({
      ...c,
      conversions: c.conversions.map((v) => without(v, ["client_id"])),
      entries: c.entries
        .filter((e) => e.status === "recorded")
        .map((e) => without(e, ["holder_client_id", "note", "void_reason", "voided_by", "voided_at", "created_by"])),
    })),
  };
}

function without<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

// ── CSV export ─────────────────────────────────────────────────────────────

export const CSV_COLUMNS = [
  "section", "share_class", "class_index", "mint", "item", "units", "percent", "wallet", "kind", "state", "detail",
  "decision_ref", "decision_date", "registry", "decision_doc_sha256", "realize_tx", "conversion_request_id", "register_entry_id",
] as const;
/** Added by the personal-data variant only. */
export const CSV_PII_COLUMNS = ["holder_client_id", "holder_name", "note"] as const;

type CsvRow = Partial<Record<(typeof CSV_COLUMNS)[number] | (typeof CSV_PII_COLUMNS)[number], string | number | null>>;

/**
 * One spreadsheet cell: quoted when it holds a separator, a quote or a line
 * break, and prefixed with ' when it starts like a formula (= + - @, tab or
 * carriage return) so a spreadsheet never evaluates exported text.
 */
export function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export type CsvPersonalData = {
  /** Holder names by client id (company name, else display name). */
  names: ReadonlyMap<string, string>;
};

/**
 * The reconciliation as one CSV table (a `section` column per row kind:
 * asset, chain, register, holder, conversion, register_entry, check). Without
 * `pii` it holds no personal data: no dossier link, no name, no staff note
 * or void reason. CRLF line ends and a UTF-8 byte order mark, for spreadsheets.
 */
export function capTableCsv(table: AssetReconciliation, pii: CsvPersonalData | null = null): string {
  const columns: string[] = [...CSV_COLUMNS, ...(pii ? CSV_PII_COLUMNS : [])];
  const rows: CsvRow[] = [
    { section: "asset", item: "asset_pda", detail: table.asset_pda },
    { section: "asset", item: "asset_id", detail: table.asset_id },
    { section: "asset", item: "name", detail: table.name },
    { section: "asset", item: "symbol", detail: table.symbol },
    { section: "asset", item: "issuer_pda", detail: table.issuer_pda },
    { section: "asset", item: "network", detail: table.network },
    { section: "asset", item: "generated_at", detail: table.generated_at },
    { section: "asset", item: "state", state: table.state },
  ];
  const nameOf = (id: string | null | undefined) => (pii && id ? pii.names.get(id) ?? "" : "");
  for (const c of table.classes) {
    const base = { share_class: c.share_class_pda, class_index: c.class_index, mint: c.mint };
    const max = c.chain.max_supply === null ? null : BigInt(c.chain.max_supply);
    const pct = (units: string | null) => (units === null ? "" : percentOfSupply(BigInt(units), max) ?? "");
    const figures: Array<[string, string | null]> = [
      ["max_supply", c.chain.max_supply], ["lifetime_minted", c.chain.lifetime_minted], ["circulating", c.chain.circulating],
      ["locked", c.chain.locked], ["burned", c.chain.burned], ["burned_by_conversions", c.chain.burned_by_conversions],
      ["mint_supply", c.chain.mint_supply], ["in_conversion", c.chain.in_conversion], ["custody_escrow", c.chain.custody_escrow],
      ["treasury", c.chain.treasury], ["other_wallets", c.chain.other_wallets], ["program_escrows", c.chain.program_escrows],
    ];
    for (const [item, units] of figures) rows.push({ ...base, section: "chain", item, units: units ?? "", percent: pct(units) });
    rows.push({ ...base, section: "chain", item: "unit_percent", percent: c.chain.unit_percent ?? "" });
    rows.push({ ...base, section: "register", item: "recorded_entries", units: c.register.units, percent: c.register.percent, detail: String(c.register.entries) });
    for (const h of c.holders ?? []) {
      rows.push({ ...base, section: "holder", wallet: h.owner, kind: h.kind, units: h.units, percent: h.percent ?? "" });
    }
    for (const v of c.conversions) {
      rows.push({
        ...base, section: "conversion", conversion_request_id: v.id, state: v.status, units: v.units, percent: pct(v.units),
        wallet: v.holder_wallet, realize_tx: v.realize_tx ?? "", register_entry_id: v.register_entry_id ?? "",
        detail: v.decided_at ?? "",
        ...(pii ? { holder_client_id: v.client_id ?? "", holder_name: nameOf(v.client_id) } : {}),
      });
    }
    for (const e of c.entries) {
      rows.push({
        ...base, section: "register_entry", register_entry_id: e.id, state: e.status, units: e.units, percent: e.percent,
        decision_ref: e.decision_ref ?? "", decision_date: e.decision_date, registry: e.registry,
        decision_doc_sha256: e.decision_doc_sha256, realize_tx: e.realize_tx ?? "", conversion_request_id: e.conversion_request_id ?? "",
        ...(pii ? { detail: e.void_reason ?? "", holder_client_id: e.holder_client_id ?? "", holder_name: nameOf(e.holder_client_id), note: e.note ?? "" } : {}),
      });
    }
    for (const k of c.checks) rows.push({ ...base, section: "check", item: k.id, state: k.state, detail: k.detail });
  }
  const lines = [columns.join(","), ...rows.map((row) => columns.map((col) => csvCell(row[col as keyof CsvRow])).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** The export's file name: asset id (or address) and date, `-personal-data` for the PII variant. */
export function capTableCsvFilename(table: Pick<AssetReconciliation, "asset_id" | "asset_pda" | "generated_at">, pii: boolean): string {
  const id = (table.asset_id || table.asset_pda).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "asset";
  return `manci-cap-table-${id}-${table.generated_at.slice(0, 10)}${pii ? "-personal-data" : ""}.csv`;
}
