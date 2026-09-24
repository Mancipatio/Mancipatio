/**
 * G0 (localnet): a platform with separated roles, built by the reviewed
 * bootstrap plan (design-6.3 §C) instead of hand-written instructions. The
 * role map lives in memory (and in state.json, so every cycle and every
 * resumed run plans against the same map); the Super Admin, the
 * BlocklistAuthority and the KYC authority are local rehearsal signers, so
 * their accept steps (X1–X3) are ordinary steps here.
 */
import type { Address, KeyPairSigner } from "@solana/kit";
import { findKycRegistryPda } from "@/lib/generated/asset_registry";
import {
  planBootstrap,
  probeBootstrapState,
  type BootstrapState,
} from "../../bootstrap-plan";
import type { Journal } from "../../journal";
import { validateRoleMap, type RoleMap } from "../../role-map";
import { ChainPlanError, toJson } from "../../safety";
import { squadsVaultPda } from "../../squads";
import { executePlan, type StepRecord } from "../../tx";
import { fundInstructions, topUp } from "../fixtures";
import { loadOrCreateRoleKey } from "../keys";
import type { World } from "../world";

const PROGRAM_DATA_MAX_LEN = { assetRegistry: 3_145_728, transferHook: 786_432 };
const ROLE_SOL = BigInt(10_000_000_000);
const MAX_CYCLES = 4;

async function roleMap(w: World, genesis: string): Promise<RoleMap> {
  const saved = w.runner.state.entities.roleMap;
  let json: unknown;
  if (saved) {
    json = JSON.parse(saved);
  } else {
    const { funder, superAdmin, blocklistAuthority, kycAuthority, admin } = w.roles;
    if (!superAdmin || !blocklistAuthority || !kycAuthority) throw new ChainPlanError("G0 needs the localnet role keys");
    const key = async (role: string) => (await loadOrCreateRoleKey(w.config.dir, role)).address;
    const multisig = await key("squads-multisig");
    const vault = await squadsVaultPda(multisig as Address, 0);
    const [registry] = await findKycRegistryPda({ authority: funder.address });
    json = {
      schema: "mancipatio-role-map-v2",
      network: "localnet",
      genesisHash: genesis,
      programs: {
        assetRegistry: "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS",
        transferHook: "GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy",
      },
      programDataMaxLen: PROGRAM_DATA_MAX_LEN,
      deployer: funder.address,
      bufferWriter: await key("buffer-writer"),
      superAdmin: superAdmin.address,
      admins: [admin.address],
      blocklistAuthority: blocklistAuthority.address,
      kyc: {
        authority: kycAuthority.address,
        registry,
        approvedJurisdictions: "default",
        blockedJurisdictions: [],
        tempAdminGrant: false,
      },
      protocolTreasury: vault,
      protocolFeeBps: 0,
      squads: {
        multisig,
        vaultIndex: 0,
        vault,
        threshold: 2,
        timeLock: 0,
        configAuthority: null,
        members: [
          { key: await key("squads-m1"), permissions: ["initiate", "vote", "execute"] },
          { key: await key("squads-m2"), permissions: ["initiate", "vote", "execute"] },
          { key: await key("squads-m3"), permissions: ["vote"] },
        ],
      },
      unpauseBy: "superAdmin",
    };
    w.runner.setEntity("roleMap", JSON.stringify(json));
  }
  const { map, warnings } = await validateRoleMap(json, { network: "localnet", genesis });
  for (const warning of warnings) w.log(`role map: ${warning}`);
  return map;
}

function bootstrapDone(state: BootstrapState, map: RoleMap): string | null {
  if (state.platform?.admin !== map.superAdmin) return "platform admin is not the Super Admin";
  if (state.platform.pauseFlags !== 0) return "the platform is still paused";
  if (state.blocklist?.authority !== map.blocklistAuthority) return "the BlocklistAuthority is not BA";
  if (state.registry?.authority !== map.kyc.authority) return "the KYC registry authority is not K";
  for (const admin of map.admins) if (!state.adminRecords[admin]) return `admin ${admin} has no Admin record`;
  return null;
}

export async function runGroup0(w: World, input: { genesis: string; journal: Journal; cuPrice: bigint | null }): Promise<void> {
  const { funder, superAdmin, blocklistAuthority, kycAuthority } = w.roles;
  if (!superAdmin || !blocklistAuthority || !kycAuthority) throw new ChainPlanError("G0 needs the localnet role keys");

  await w.runner.step("0.1", async () => {
    const targets = (
      await Promise.all([superAdmin, blocklistAuthority, kycAuthority].map((k) => topUp(w.rpc, k.address, ROLE_SOL)))
    ).filter((t) => t !== null);
    return { payer: funder, ixs: fundInstructions(funder, targets) };
  }, {
    done: async () =>
      (await Promise.all([superAdmin, blocklistAuthority, kycAuthority].map((k) => topUp(w.rpc, k.address, ROLE_SOL / BigInt(2))))).every(
        (t) => t === null,
      ),
  });

  if (w.runner.passed("0.2")) {
    w.log("skip   0.2: bootstrap completed in an earlier run");
    return;
  }
  const map = await roleMap(w, input.genesis);
  w.runner.setEntity("kycRegistry", map.kyc.registry!);
  const signers = {
    deployer: funder as KeyPairSigner,
    rehearsal: { superAdmin, blocklistAuthority, kycAuthority },
  };
  const rent = async (size: number) => w.rpc.getMinimumBalanceForRentExemption(BigInt(size), { commitment: "finalized" }).send();
  const records: StepRecord[] = [];
  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
    const state = await probeBootstrapState(w.rpc, map);
    const plan = await planBootstrap(state, map, signers, {
      rpc: w.rpc,
      handover: { requested: false, confirmVault: null, whilePaused: false, inventoryBlockers: null },
      rent,
      cuPrice: input.cuPrice,
    });
    if (plan.stops.length) throw new ChainPlanError(`bootstrap stopped: ${plan.stops.join("; ")}`);
    if (!plan.steps.length) {
      const missing = bootstrapDone(state, map);
      if (missing) {
        throw new ChainPlanError(
          `bootstrap has no step left but ${missing} (awaiting: ${toJson(plan.awaiting, 0)}, blocked: ${toJson(plan.blocked, 0)})`,
        );
      }
      w.runner.markPassed("0.2", `bootstrap complete after ${cycle - 1} cycle(s): ${records.map((r) => r.id).join(", ") || "nothing to send"}`);
      return;
    }
    w.log(`bootstrap cycle ${cycle}: ${plan.steps.map((s) => s.id).join(", ")}`);
    await executePlan(plan.steps, {
      rpc: w.rpc,
      drainRpc: w.drainRpc,
      journal: input.journal,
      cuPrice: input.cuPrice,
      probe: () => probeBootstrapState(w.rpc, map),
      signal: w.signal,
      log: w.log,
      records,
    });
  }
  throw new ChainPlanError(`bootstrap still had steps after ${MAX_CYCLES} cycles`);
}
