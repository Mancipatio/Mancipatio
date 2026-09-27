/**
 * Cluster facts a deploy or an upgrade depends on (Talas 8.2, release-lanac-6
 * and -7): the SBPF version of each Release `.so` (ELF `e_flags`) against
 * SIMD-0500, and the rent steps SIMD-0437-3..5 and SIMD-0438.
 *
 * Feature IDs are copied from Agave's `feature-set/src/lib.rs`, checked on
 * 2026-09-28 against the v4.3 and v4.4 branches and master (identical). The
 * v4.2 branch declared SIMD-0437-3..5 and SIMD-0438 under other keys, which
 * v4.3 re-keyed; solana.com/upgrades/reduced-rent still lists those old keys.
 * They are probed as `superseded` so an activation under either key shows.
 */
import type { Address } from "@solana/kit";
import { fetchRawAccounts, type RawAccount } from "./accounts";
import type { ChainRpc } from "./rpc";
import { IDL_PROGRAMS, type ProgramName } from "./safety";

export const FEATURE_PROGRAM = "Feature111111111111111111111111111111111111" as Address;
/** Rent-exempt minimum of an empty account = ACCOUNT_STORAGE_OVERHEAD × lamports per byte. */
export const ACCOUNT_STORAGE_OVERHEAD = 128;

export type FeatureGate = {
  id: Address;
  simd: string;
  label: string;
  /** Lamports per byte the gate sets (rent steps only). */
  lamportsPerByte?: number;
  /** A key an older Agave release declared for the same step. */
  superseded?: boolean;
};

export const SBPF_DEPLOY_GATE: FeatureGate = {
  id: "B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g" as Address,
  simd: "SIMD-0500",
  label: "disable deployment of SBPF v0, v1 and v2 programs",
};

export const FEATURE_GATES: readonly FeatureGate[] = [
  SBPF_DEPLOY_GATE,
  { id: "5cC3foj77CWun58pC51ebHFUWavHWKarWyR5UUik7dnC" as Address, simd: "SIMD-0178/0189/0377", label: "enable deployment and execution of SBPF v3" },
  { id: "4a6f7o7iTcA8hRDCrPLkSatnt5Ykxiu36wo5p1Tt12wC" as Address, simd: "SIMD-0437-1", label: "lamports per byte 6333", lamportsPerByte: 6333 },
  { id: "61BtM7BkDEE8Yq5fskEVAQT9mYA8qCejJWoLe5apqg81" as Address, simd: "SIMD-0437-2", label: "lamports per byte 5080", lamportsPerByte: 5080 },
  { id: "rntCigrTppP5JdZz7K8TyN9sMzLdAcXp8SejYpVpX6D" as Address, simd: "SIMD-0437-3", label: "lamports per byte 2575", lamportsPerByte: 2575 },
  { id: "rntD7invRBswCAdKtRsh1G4psKjrPdS3BKqtnA78C7N" as Address, simd: "SIMD-0437-4", label: "lamports per byte 1322", lamportsPerByte: 1322 },
  { id: "rntTjNZ9boq8owDxjGVFHPfWNQPDaKiM5JcjxmDGg47" as Address, simd: "SIMD-0437-5", label: "lamports per byte 696", lamportsPerByte: 696 },
  { id: "rnt8ZQpz2HYhX3DkYBDGjJS1a36mYq69oXka7JrhEdi" as Address, simd: "SIMD-0438", label: "reset lamports per byte to 6960", lamportsPerByte: 6960 },
  // Agave v4.2 keys, re-keyed in v4.3 (still on solana.com/upgrades/reduced-rent).
  { id: "Ftxb3ZKq7aNqgxDBbP7EonvR2RszZk9ctjdsTX38kQaz" as Address, simd: "SIMD-0437-3", label: "lamports per byte 2575 (v4.2 key)", lamportsPerByte: 2575, superseded: true },
  { id: "GsUBNYNDPdMLHPD37TToHzrzcNcjpC9w5n1EcJk5iTaM" as Address, simd: "SIMD-0437-4", label: "lamports per byte 1322 (v4.2 key)", lamportsPerByte: 1322, superseded: true },
  { id: "mZdnRh9T2EbDNvqKjkCR3bvo5c816tJaojtE9Xs7iuY" as Address, simd: "SIMD-0437-5", label: "lamports per byte 696 (v4.2 key)", lamportsPerByte: 696, superseded: true },
  { id: "5AqsUgSb6cgLizSaNiFn3o9XB7VUtKDtDZfcKEjEDmni" as Address, simd: "SIMD-0438", label: "reset lamports per byte to 6960 (v4.2 key)", lamportsPerByte: 6960, superseded: true },
];

export type FeatureState = "not-scheduled" | "pending" | "active" | "unreadable";

export type FeatureStatus = FeatureGate & { state: FeatureState; activatedAt: string | null };

/**
 * A feature account is `Feature { activated_at: Option<u64> }` (bincode) owned
 * by the feature program: absent = never scheduled, `None` = pending (it
 * activates at the next epoch boundary with enough stake), `Some(slot)` = active.
 */
export function decodeFeature(account: RawAccount | null | undefined): { state: FeatureState; activatedAt: string | null } {
  if (!account) return { state: "not-scheduled", activatedAt: null };
  if (account.owner !== FEATURE_PROGRAM || account.data.length < 1) return { state: "unreadable", activatedAt: null };
  if (account.data[0] === 0) return { state: "pending", activatedAt: null };
  if (account.data[0] === 1 && account.data.length >= 9) {
    const slot = new DataView(account.data.buffer, account.data.byteOffset, account.data.byteLength).getBigUint64(1, true);
    return { state: "active", activatedAt: slot.toString() };
  }
  return { state: "unreadable", activatedAt: null };
}

export type NetworkGates = {
  features: FeatureStatus[];
  /** getMinimumBalanceForRentExemption(0) / 128; null when the call failed. */
  lamportsPerByte: number | null;
};

/** One getMultipleAccounts for every gate plus the rent minimum of an empty account. */
export async function probeNetworkGates(rpc: ChainRpc): Promise<NetworkGates> {
  const accounts = await fetchRawAccounts(rpc, FEATURE_GATES.map((gate) => gate.id));
  const features = FEATURE_GATES.map((gate) => ({ ...gate, ...decodeFeature(accounts.get(gate.id)) }));
  let lamportsPerByte: number | null = null;
  try {
    const minimum = await rpc.getMinimumBalanceForRentExemption(BigInt(0), { commitment: "finalized" }).send();
    lamportsPerByte = Number(minimum) / ACCOUNT_STORAGE_OVERHEAD;
  } catch {
    lamportsPerByte = null;
  }
  return { features, lamportsPerByte };
}

// ── SBPF version of a Release .so ────────────────────────────────────────────

export const EM_BPF = 247;
export const EM_SBPF = 263;

export type SbpfInfo = {
  program: ProgramName;
  /** 0-3 from `e_flags`; null when the file is not a 64-bit little-endian SBPF ELF. */
  version: number | null;
  eMachine: number | null;
  eFlags: number | null;
  error: string | null;
};

/**
 * Reads the ELF header: magic, ELFCLASS64, little-endian, `e_machine`
 * (247 EM_BPF or 263 EM_SBPF) and `e_flags`, which solana-sbpf maps to the
 * SBPF version (0 → v0 … 3 → v3).
 */
export function sbpfVersionOf(program: ProgramName, so: Uint8Array): SbpfInfo {
  const fail = (error: string, eMachine: number | null = null, eFlags: number | null = null): SbpfInfo => ({
    program,
    version: null,
    eMachine,
    eFlags,
    error,
  });
  if (so.length < 64) return fail("shorter than an ELF64 header");
  if (so[0] !== 0x7f || so[1] !== 0x45 || so[2] !== 0x4c || so[3] !== 0x46) return fail("no ELF magic");
  if (so[4] !== 2 || so[5] !== 1) return fail("not a 64-bit little-endian ELF");
  const view = new DataView(so.buffer, so.byteOffset, so.byteLength);
  const eMachine = view.getUint16(0x12, true);
  const eFlags = view.getUint32(0x30, true);
  if (eMachine !== EM_BPF && eMachine !== EM_SBPF) return fail(`e_machine ${eMachine} is not BPF/SBPF`, eMachine, eFlags);
  if (eFlags > 3) return fail(`e_flags 0x${eFlags.toString(16)} is not an SBPF version`, eMachine, eFlags);
  return { program, version: eFlags, eMachine, eFlags, error: null };
}

export function releaseSbpf(so: Record<ProgramName, Uint8Array>): SbpfInfo[] {
  return IDL_PROGRAMS.map((name) => sbpfVersionOf(name, so[name]));
}

export type GateFinding = { severity: "blocker" | "warning" | "info"; code: string; message: string };

const featureText = (f: FeatureStatus) =>
  `${f.simd} ${f.state === "active" ? `active since slot ${f.activatedAt}` : f.state === "pending" ? "pending (activates at an epoch boundary)" : f.state}`;

/** Findings for the gates and, with a Release, its SBPF versions. */
export function networkGateFindings(gates: NetworkGates, sbpf: SbpfInfo[] | null): GateFinding[] {
  const out: GateFinding[] = [];
  const deployGate = gates.features.find((f) => f.id === SBPF_DEPLOY_GATE.id)!;
  if (sbpf) {
    for (const info of sbpf) {
      if (info.version === null) {
        out.push({ severity: "warning", code: "sbpf", message: `${info.program}: the Release .so is not an SBPF ELF (${info.error})` });
      }
      const old = info.version === null || info.version < 3;
      const described = info.version === null ? "unknown" : `v${info.version}`;
      if (old && deployGate.state === "active") {
        out.push({
          severity: "blocker",
          code: "sbpf-gate",
          message: `${info.program}: the Release .so is SBPF ${described} and ${featureText(deployGate)}: it can neither be deployed nor used for an upgrade (build SBPF v3)`,
        });
      } else if (old && deployGate.state === "pending") {
        out.push({
          severity: "warning",
          code: "sbpf-gate",
          message: `${info.program}: the Release .so is SBPF ${described} and ${featureText(deployGate)}: deploy before it activates or build SBPF v3`,
        });
      } else {
        out.push({
          severity: "info",
          code: "sbpf",
          message: `${info.program}: Release .so SBPF ${described} (e_machine ${info.eMachine ?? "?"}, e_flags ${info.eFlags ?? "?"}); ${featureText(deployGate)}`,
        });
      }
    }
  } else if (deployGate.state !== "not-scheduled") {
    out.push({ severity: "warning", code: "sbpf-gate", message: `${featureText(deployGate)}: an upgrade needs an SBPF v3 Release` });
  }
  const rent = gates.features.filter((f) => f.lamportsPerByte !== undefined && !f.superseded);
  const perByte = gates.lamportsPerByte === null ? "unknown" : String(gates.lamportsPerByte);
  out.push({
    severity: "info",
    code: "rent",
    message: `lamports per byte ${perByte}; ${rent.map(featureText).join("; ")}`,
  });
  const reset = rent.find((f) => f.simd === "SIMD-0438");
  if (reset && reset.state !== "not-scheduled") {
    out.push({ severity: "warning", code: "rent-reset", message: `${featureText(reset)}: rent goes back to 6960 lamports per byte` });
  }
  for (const f of gates.features.filter((f) => f.superseded && f.state !== "not-scheduled")) {
    out.push({ severity: "warning", code: "feature-superseded", message: `${f.simd} under the superseded key ${f.id} is ${f.state}: check which Agave release the cluster runs` });
  }
  for (const f of gates.features.filter((f) => f.state === "unreadable")) {
    out.push({ severity: "warning", code: "feature-unreadable", message: `feature account ${f.id} (${f.simd}) does not decode` });
  }
  return out;
}

/**
 * The upgrade refusal of `chain:squads-export op=upgrade`: a Release older
 * than SBPF v3 cannot be written once SIMD-0500 is active.
 */
export function sbpfUpgradeProblem(gates: NetworkGates, info: SbpfInfo): string | null {
  const deployGate = gates.features.find((f) => f.id === SBPF_DEPLOY_GATE.id)!;
  if (deployGate.state !== "active") return null;
  if (info.version !== null && info.version >= 3) return null;
  return `${info.program}: the Release .so is SBPF ${info.version === null ? "unknown" : `v${info.version}`} and ${featureText(deployGate)}; the loader refuses it`;
}
