/**
 * FakeChain: an in-memory cluster behind a JSON-RPC transport shim for the
 * chain CLI tests. No network: the tools get this object's `transport`
 * through `ToolDeps.transport`. It executes the instructions the CLI sends
 * (bootstrap, loader SetAuthority, System transfer/createAccount and the
 * Program Metadata instructions) with the program's own checks, so simulation
 * and send behave like a small validator.
 *
 * v1.0.0-rc (8.3): a fresh Platform is 0xFF (bit 7 = the one-way bootstrap
 * window); proposals are `AuthorityProposal` / `BlocklistAuthorityProposal`
 * with a window on `FakeChain.now`; an Admin grant is propose_admin plus an
 * add_admin signed by the new key; set_pause_flags follows the program's
 * mask rules (0x7F settable, 0x40 cleared alone, any clear closes bit 7).
 */
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AccountRole,
  decompileTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getBase58Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  unwrapOption,
  type Address,
  type Instruction,
  type Option,
  type RpcTransport,
} from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  AssetRegistryInstruction,
  findAdminRecordPda,
  getAdminDecoder,
  getAdminEncoder,
  getAuthorityProposalDecoder,
  getAuthorityProposalEncoder,
  getKycRegistryDecoder,
  getPendingAdminDecoder,
  getPendingAdminEncoder,
  getKycRegistryEncoder,
  getPlatformDecoder,
  getPlatformEncoder,
  parseAssetRegistryInstruction,
  type Platform,
} from "@/lib/generated/asset_registry";
import {
  RestrictionMode,
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  TransferHookInstruction,
  getBlockEntryEncoder,
  getBlocklistAuthorityDecoder,
  getBlocklistAuthorityEncoder,
  getBlocklistAuthorityProposalDecoder,
  getBlocklistAuthorityProposalEncoder,
  getTransferHookConfigDecoder,
  getTransferHookConfigEncoder,
  parseTransferHookInstruction,
} from "@/lib/generated/transfer_hook";
import { CLUSTER_GENESIS_HASHES } from "@/lib/network-identity";
import { LOADER_V3, SYSTEM_PROGRAM, programDataAddress } from "@/scripts/chain/lib/loader-v3";
import { PM_HEADER_LENGTH, PM_PROGRAM } from "@/scripts/chain/lib/program-metadata";
import { encodeMultisig, squadsVaultPda, SQUADS_V4_PROGRAM } from "@/scripts/chain/lib/squads";

export const REGISTRY = ASSET_REGISTRY_PROGRAM_ADDRESS;
export const HOOK = TRANSFER_HOOK_PROGRAM_ADDRESS;
export const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111" as Address;

/** A deterministic, valid address (not a key anyone holds). */
export function key(n: number): Address {
  return getAddressDecoder().decode(new Uint8Array(32).fill(n));
}

export type FakeAccount = { owner: Address; lamports: bigint; data: Uint8Array; executable?: boolean };

class FakeError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

const fail = (message: string, code = 6000): never => {
  throw new FakeError(code, message);
};

export type SendBehavior = "land" | "drop" | "throw-then-land" | "throw-and-drop" | "processed-only";

type Status = { slot: number; err: unknown; confirmationStatus: "processed" | "confirmed" | "finalized" };

export function rent(size: number): bigint {
  return BigInt((size + 128) * 6960);
}

/** The program's timelock constants (constants.rs, transfer_hook lib.rs). */
export const ADMIN_TIMELOCK = 172_800;
export const PROPOSAL_WINDOW = 1_209_600;
const PLATFORM_BOOTSTRAP_OPEN = 0x80;

export class FakeChain {
  genesis: string = CLUSTER_GENESIS_HASHES.devnet;
  /** The Clock sysvar's unix_timestamp every instruction sees (seconds). */
  now = 1_900_000_000;
  accounts = new Map<string, FakeAccount>();
  calls: string[] = [];
  blockHeight = BigInt(1000);
  slot = 5000;
  statuses = new Map<string, Status>();
  sends: { sig: string; wire: string }[] = [];
  failMethods = new Set<string>();
  /** Per send (1-based count per signature) behaviour. */
  behavior: (sig: string, attempt: number) => SendBehavior = () => "land";
  /** Called before a send is processed (e.g. to inspect the journal). */
  onSend?: (sig: string, wire: string) => void;
  /** Extra account mutation right after a landed transaction. */
  afterLand?: (sig: string) => void;
  /**
   * A scripted simulation result (the fake cannot execute Token-2022): return
   * `{ err, logs }` to answer a simulateTransaction, or null to execute as usual.
   */
  simulateOverride?: (wire: Uint8Array) => { err: unknown; logs: string[] } | null;
  private attempts = new Map<string, number>();
  private blockhashCounter = 0;

  clone(): Map<string, FakeAccount> {
    return new Map([...this.accounts].map(([k, v]) => [k, { ...v, data: new Uint8Array(v.data) }]));
  }

  set(address: string, account: FakeAccount) {
    this.accounts.set(address, account);
  }

  get(address: string): FakeAccount | undefined {
    return this.accounts.get(address);
  }

  // ── Transport ──────────────────────────────────────────────────────────────
  transport: RpcTransport = (async (config: { payload: unknown }) => {
    const payload = config.payload as { id: number; method: string; params?: unknown[] };
    this.calls.push(payload.method);
    if (this.failMethods.has(payload.method)) {
      return { jsonrpc: "2.0", id: payload.id, error: { code: -32000, message: "upstream https://user:secret@rpc.example/?api-key=SECRET failed" } };
    }
    const result = this.handle(payload.method, payload.params ?? []);
    return { jsonrpc: "2.0", id: payload.id, result };
  }) as RpcTransport;

  private wireAccount(account: FakeAccount | undefined, slice?: { offset: number; length: number }) {
    if (!account) return null;
    const data = slice ? account.data.subarray(slice.offset, slice.offset + slice.length) : account.data;
    return {
      data: [Buffer.from(data).toString("base64"), "base64"],
      executable: Boolean(account.executable),
      lamports: Number(account.lamports),
      owner: account.owner,
      rentEpoch: 0,
      space: account.data.length,
    };
  }

  private context() {
    return { slot: this.slot, apiVersion: "3.1.13" };
  }

  handle(method: string, params: unknown[]): unknown {
    switch (method) {
      case "getGenesisHash":
        return this.genesis;
      case "getVersion":
        return { "solana-core": "3.1.13", "feature-set": 1 };
      case "getSlot":
        return this.slot;
      case "getBlockHeight":
        return Number(this.blockHeight);
      case "getBalance":
        return { context: this.context(), value: Number(this.get(params[0] as string)?.lamports ?? BigInt(0)) };
      case "getMinimumBalanceForRentExemption":
        return Number(rent(Number(params[0])));
      case "getRecentPrioritizationFees":
        return [];
      case "getLatestBlockhash": {
        const bytes = new Uint8Array(32).fill(0);
        bytes[0] = ++this.blockhashCounter;
        return {
          context: this.context(),
          value: { blockhash: getBase58Decoder().decode(bytes), lastValidBlockHeight: Number(this.blockHeight + BigInt(150)) },
        };
      }
      case "getAccountInfo": {
        const config = (params[1] ?? {}) as { dataSlice?: { offset: number; length: number } };
        return { context: this.context(), value: this.wireAccount(this.get(params[0] as string), config.dataSlice) };
      }
      case "getMultipleAccounts": {
        const config = (params[1] ?? {}) as { dataSlice?: { offset: number; length: number } };
        return {
          context: this.context(),
          value: (params[0] as string[]).map((a) => this.wireAccount(this.get(a), config.dataSlice)),
        };
      }
      case "getProgramAccounts": {
        const program = params[0] as string;
        const config = (params[1] ?? {}) as {
          filters?: { memcmp: { offset: number; bytes: string } }[];
          dataSlice?: { offset: number; length: number };
        };
        const rows = [...this.accounts].filter(([, account]) => {
          if (account.owner !== program) return false;
          return (config.filters ?? []).every(({ memcmp }) => {
            const want = getBase58Encoder().encode(memcmp.bytes);
            const got = account.data.subarray(memcmp.offset, memcmp.offset + want.length);
            return Buffer.from(got).equals(Buffer.from(want));
          });
        });
        return rows.map(([pubkey, account]) => ({ pubkey, account: this.wireAccount(account, config.dataSlice) }));
      }
      case "simulateTransaction": {
        const wire = Buffer.from(params[0] as string, "base64");
        const config = (params[1] ?? {}) as { sigVerify?: boolean };
        const scripted = this.simulateOverride?.(new Uint8Array(wire));
        if (scripted) {
          return { context: this.context(), value: { err: scripted.err, logs: scripted.logs, unitsConsumed: 12_000, accounts: null, returnData: null } };
        }
        const staged = this.clone();
        const { err } = this.execute(new Uint8Array(wire), staged, Boolean(config.sigVerify));
        return {
          context: this.context(),
          value: { err, logs: err ? ["Program log: fake failure"] : ["Program log: ok"], unitsConsumed: 12_000, accounts: null, returnData: null },
        };
      }
      case "sendTransaction": {
        const wire = params[0] as string;
        const sig = this.signatureOf(Buffer.from(wire, "base64"));
        this.onSend?.(sig, wire);
        this.sends.push({ sig, wire });
        const attempt = (this.attempts.get(sig) ?? 0) + 1;
        this.attempts.set(sig, attempt);
        const behavior = this.behavior(sig, attempt);
        const land = () => {
          if (this.statuses.has(sig)) return;
          const staged = this.clone();
          const { err } = this.execute(new Uint8Array(Buffer.from(wire, "base64")), staged, true);
          if (!err) this.accounts = staged;
          this.slot += 1;
          this.statuses.set(sig, { slot: this.slot, err, confirmationStatus: "finalized" });
          if (!err) this.afterLand?.(sig);
        };
        if (behavior === "land") land();
        if (behavior === "processed-only") {
          this.statuses.set(sig, { slot: this.slot, err: null, confirmationStatus: "processed" });
        }
        if (behavior === "throw-then-land") {
          land();
          throw new Error("socket hang up https://user:secret@rpc.example/");
        }
        if (behavior === "throw-and-drop") throw new Error("timeout");
        return sig;
      }
      case "getSignatureStatuses": {
        const sigs = params[0] as string[];
        return { context: this.context(), value: sigs.map((s) => this.statuses.get(s) ?? null) };
      }
      default:
        throw new Error(`FakeChain: unsupported method ${method}`);
    }
  }

  signatureOf(wire: Uint8Array): string {
    const tx = getTransactionDecoder().decode(wire);
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const payer = compiled.staticAccounts[0];
    const sig = tx.signatures[payer];
    return getBase58Decoder().decode(sig ?? new Uint8Array(64));
  }

  // ── Execution ──────────────────────────────────────────────────────────────
  execute(wire: Uint8Array, state: Map<string, FakeAccount>, sigVerify: boolean): { err: unknown } {
    const tx = getTransactionDecoder().decode(wire);
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const signers = new Set<string>(compiled.staticAccounts.slice(0, compiled.header.numSignerAccounts));
    if (sigVerify) {
      for (const signer of signers) {
        const sig = tx.signatures[signer as Address];
        if (!sig || sig.every((b) => b === 0)) return { err: "SignatureFailure" };
      }
    }
    const message = decompileTransactionMessage(compiled);
    const payer = state.get(compiled.staticAccounts[0]);
    if (!payer || payer.lamports < BigInt(5000)) return { err: "AccountNotFound" };
    payer.lamports -= BigInt(5000);
    const ixs = [...message.instructions] as Instruction[];
    for (let i = 0; i < ixs.length; i++) {
      try {
        this.apply(ixs[i], state, signers);
      } catch (error) {
        const code = error instanceof FakeError ? error.code : 1;
        return { err: { InstructionError: [i, { Custom: code }] } };
      }
    }
    return { err: null };
  }

  private apply(ix: Instruction, s: Map<string, FakeAccount>, signers: Set<string>) {
    const program = ix.programAddress;
    const data = new Uint8Array(ix.data ?? new Uint8Array());
    const metas = ix.accounts ?? [];
    const signed = (a: string) => signers.has(a) || fail(`missing signature ${a}`, 2);
    if (program === COMPUTE_BUDGET) return;
    if (program === SYSTEM_PROGRAM) return this.system(data, metas.map((m) => m.address), s, signed);
    if (program === LOADER_V3) return this.loader(data, metas.map((m) => m.address), s, signed);
    if (program === PM_PROGRAM) return this.pm(data, metas.map((m) => ({ address: m.address, role: m.role })), s, signed);
    if (program === REGISTRY) return this.registry(ix, s, signed);
    if (program === HOOK) return this.hook(ix, s, signed);
    fail(`unknown program ${program}`, 3);
  }

  private system(data: Uint8Array, accounts: string[], s: Map<string, FakeAccount>, signed: (a: string) => unknown) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const tag = view.getUint32(0, true);
    if (tag === 2) {
      const lamports = view.getBigUint64(4, true);
      signed(accounts[0]);
      const from = s.get(accounts[0]) ?? fail("source missing", 1);
      if (from.lamports < lamports) fail("insufficient lamports", 1);
      from.lamports -= lamports;
      const to = s.get(accounts[1]) ?? { owner: SYSTEM_PROGRAM, lamports: BigInt(0), data: new Uint8Array() };
      to.lamports += lamports;
      s.set(accounts[1], to);
      return;
    }
    if (tag === 0) {
      const lamports = view.getBigUint64(4, true);
      const space = Number(view.getBigUint64(12, true));
      const owner = getAddressDecoder().decode(data.subarray(20, 52));
      signed(accounts[0]);
      signed(accounts[1]);
      if (s.get(accounts[1])?.lamports) fail("account in use", 0);
      const from = s.get(accounts[0]) ?? fail("payer missing", 1);
      from.lamports -= lamports;
      s.set(accounts[1], { owner, lamports, data: new Uint8Array(space) });
      return;
    }
    fail(`unsupported system tag ${tag}`, 3);
  }

  private loader(data: Uint8Array, accounts: string[], s: Map<string, FakeAccount>, signed: (a: string) => unknown) {
    const tag = new DataView(data.buffer, data.byteOffset).getUint32(0, true);
    if (tag !== 4) fail(`unsupported loader tag ${tag}`, 3);
    const target = s.get(accounts[0]) ?? fail("programdata missing", 1);
    const current = target.data[12] === 1 ? getAddressDecoder().decode(target.data.subarray(13, 45)) : null;
    if (current !== accounts[1]) fail("incorrect authority", 7);
    signed(accounts[1]);
    const next = accounts[2];
    const copy = new Uint8Array(target.data);
    if (next) {
      copy[12] = 1;
      copy.set(getAddressEncoder().encode(next as Address), 13);
    } else {
      copy[12] = 0;
      copy.fill(0, 13, 45);
    }
    target.data = copy;
  }

  private pm(
    data: Uint8Array,
    metas: { address: string; role: AccountRole }[],
    s: Map<string, FakeAccount>,
    signed: (a: string) => unknown,
  ) {
    const disc = data[0];
    const a = (i: number) => metas[i]?.address as string;
    const isPlaceholder = (i: number) => metas[i]?.address === PM_PROGRAM;
    const uaIs = (programDataIndex: number, authority: string) => {
      if (isPlaceholder(programDataIndex)) return false;
      const programData = s.get(a(programDataIndex));
      const ua = programData && programData.data[12] === 1 ? getAddressDecoder().decode(programData.data.subarray(13, 45)) : null;
      return ua === authority;
    };
    const authorityOf = (account: FakeAccount) =>
      account.data.subarray(33, 65).every((b) => b === 0) ? null : getAddressDecoder().decode(account.data.subarray(33, 65));
    const canonicalOf = (account: FakeAccount) => (account.data[0] === 2 ? account.data[66] === 1 : account.data[65] === 1);
    /** The account's own authority, or the UA for a canonical account. */
    const checkAuthority = (account: FakeAccount, authority: string, programDataIndex: number | null) => {
      signed(authority);
      if (authorityOf(account) === authority) return;
      if (canonicalOf(account) && programDataIndex !== null && uaIs(programDataIndex, authority)) return;
      fail("authority mismatch", 7);
    };
    const destination = (address: string) => {
      const account = s.get(address) ?? { owner: SYSTEM_PROGRAM, lamports: BigInt(0), data: new Uint8Array() };
      s.set(address, account);
      return account;
    };
    switch (disc) {
      case 7: {
        // allocate: the buffer records its authority; a seed makes it canonical.
        const buffer = a(0);
        signed(a(1));
        const account = s.get(buffer) ?? fail("buffer unfunded", 1);
        if (account.owner === PM_PROGRAM && account.data.length && account.data[0] !== 0) fail("already allocated", 0);
        const bytes = account.owner === PM_PROGRAM && account.data.length >= PM_HEADER_LENGTH ? account.data : new Uint8Array(PM_HEADER_LENGTH);
        bytes.fill(0, 0, PM_HEADER_LENGTH);
        bytes[0] = 1;
        bytes.set(getAddressEncoder().encode(a(1) as Address), 33);
        if (data.length > 1) {
          if (!uaIs(3, a(1))) fail("not the upgrade authority", 7);
          bytes.set(getAddressEncoder().encode(a(2) as Address), 1);
          bytes[65] = 1;
          bytes.set(data.subarray(1, 17), 66);
        }
        s.set(buffer, { owner: PM_PROGRAM, lamports: account.lamports, data: bytes });
        return;
      }
      case 8: {
        const account = s.get(a(0)) ?? fail("missing", 1);
        checkAuthority(account, a(1), 3);
        const length = new DataView(data.buffer, data.byteOffset).getUint16(1, true);
        const grown = new Uint8Array(account.data.length + length);
        grown.set(account.data);
        account.data = grown;
        return;
      }
      case 0: {
        const account = s.get(a(0)) ?? fail("missing", 1);
        if (account.data[0] !== 1) fail("not a buffer", 8);
        checkAuthority(account, a(1), null);
        const offset = new DataView(data.buffer, data.byteOffset).getUint32(1, true);
        const chunk = data.subarray(5);
        const need = PM_HEADER_LENGTH + offset + chunk.length;
        if (need > account.data.length) {
          if (need - account.data.length > 10_240) fail("realloc too large", 9);
          const grown = new Uint8Array(need);
          grown.set(account.data);
          account.data = grown;
        }
        account.data.set(chunk, PM_HEADER_LENGTH + offset);
        return;
      }
      case 1: {
        // initialize from the allocated canonical buffer (data None).
        const account = s.get(a(0)) ?? fail("missing", 1);
        signed(a(1));
        if (!uaIs(3, a(1))) fail("not the upgrade authority", 7);
        if (account.data[0] !== 1) fail("not a buffer", 8);
        const payload = account.data.subarray(PM_HEADER_LENGTH);
        const out = new Uint8Array(PM_HEADER_LENGTH + payload.length);
        out[0] = 2;
        out.set(getAddressEncoder().encode(a(2) as Address), 1);
        out[65] = 1;
        out[66] = 1;
        out.set(data.subarray(1, 17), 67);
        out.set(data.subarray(17, 21), 83);
        new DataView(out.buffer).setUint32(87, payload.length, true);
        out.set(payload, PM_HEADER_LENGTH);
        account.data = out;
        if (account.lamports < rent(out.length)) fail("not rent exempt", 10);
        return;
      }
      case 2: {
        const account = s.get(a(0)) ?? fail("missing", 1);
        checkAuthority(account, a(1), 3);
        const copy = new Uint8Array(account.data);
        if (data[1] === 1) copy.set(data.subarray(2, 34), 33);
        else copy.fill(0, 33, 65);
        account.data = copy;
        return;
      }
      case 3: {
        const metadata = s.get(a(0)) ?? fail("missing", 1);
        checkAuthority(metadata, a(1), 4);
        const buffer = s.get(a(2)) ?? fail("buffer missing", 1);
        if (authorityOf(buffer) !== a(1)) fail("buffer authority", 7);
        const payload = buffer.data.subarray(PM_HEADER_LENGTH);
        const out = new Uint8Array(Math.max(metadata.data.length, PM_HEADER_LENGTH + payload.length));
        if (out.length - metadata.data.length > 10_240) fail("realloc too large", 9);
        out.set(metadata.data.subarray(0, PM_HEADER_LENGTH));
        out.set(data.subarray(1, 5), 83);
        new DataView(out.buffer).setUint32(87, payload.length, true);
        out.set(payload, PM_HEADER_LENGTH);
        metadata.data = out;
        if (metadata.lamports < rent(out.length)) fail("not rent exempt", 10);
        return;
      }
      case 6: {
        const account = s.get(a(0)) ?? fail("missing", 1);
        checkAuthority(account, a(1), 3);
        destination(a(4)).lamports += account.lamports;
        s.delete(a(0));
        return;
      }
      case 5: {
        const account = s.get(a(0)) ?? fail("missing", 1);
        checkAuthority(account, a(1), 3);
        const length = new DataView(account.data.buffer, account.data.byteOffset).getUint32(87, true);
        account.data = account.data.slice(0, PM_HEADER_LENGTH + length);
        const keep = rent(account.data.length);
        destination(a(4)).lamports += account.lamports - keep;
        account.lamports = keep;
        return;
      }
      default:
        fail(`unsupported PM discriminator ${disc}`, 3);
    }
  }

  private registry(ix: Instruction, s: Map<string, FakeAccount>, signed: (a: string) => unknown) {
    const parsed = parseAssetRegistryInstruction(ix as Instruction & { data: Uint8Array });
    const accounts = (parsed as unknown as { accounts: Record<string, { address: string } | undefined> }).accounts;
    const args = (parsed as unknown as { data: Record<string, unknown> }).data;
    const at = (name: string) => accounts[name]?.address ?? fail(`no account ${name}`, 4);
    const platformOf = () => {
      const account = s.get(at("platform")) ?? fail("platform missing", 3012);
      return getPlatformDecoder().decode(account.data);
    };
    const writePlatform = (value: Platform) => {
      s.get(at("platform"))!.data = new Uint8Array(getPlatformEncoder().encode(value));
    };
    const create = (address: string, bytes: Uint8Array) => {
      if (s.get(address)?.data.length) fail("already in use", 0);
      s.set(address, { owner: REGISTRY, lamports: rent(bytes.length), data: bytes });
    };
    const now = BigInt(this.now);
    /** `require_window(now, effective_eta, expires_at)`: 6150 / 6151. */
    const requireWindow = (proposedAt: bigint, eta: bigint, expiresAt: bigint, bootstrapWaived: boolean) => {
      const effective = bootstrapWaived && (platformOf().pauseFlags & PLATFORM_BOOTSTRAP_OPEN) !== 0 ? proposedAt : eta;
      if (now < effective) fail("TimelockActive", 6150);
      if (now >= expiresAt) fail("ProposalExpired", 6151);
    };
    const proposal = (target: string, current: Address, proposed: Address, proposer: Address, timelock: number, kind: number) =>
      new Uint8Array(
        getAuthorityProposalEncoder().encode({
          target: target as Address,
          currentAuthority: current,
          newAuthority: proposed,
          proposedBy: proposer,
          proposedAt: now,
          eta: now + BigInt(timelock),
          expiresAt: now + BigInt(timelock + PROPOSAL_WINDOW),
          kind,
          version: 1,
          bump: 255,
        }),
      );
    switch (parsed.instructionType) {
      case AssetRegistryInstruction.InitializePlatform: {
        signed(at("admin"));
        signed(at("upgradeAuthority"));
        const pd = s.get(at("programData"));
        const ua = pd && pd.data[12] === 1 ? getAddressDecoder().decode(pd.data.subarray(13, 45)) : null;
        if (ua !== at("upgradeAuthority")) fail("Unauthorized", 6000);
        create(
          at("platform"),
          new Uint8Array(
            getPlatformEncoder().encode({
              admin: at("admin") as Address,
              protocolTreasury: args.protocolTreasury as Address,
              protocolFeeBps: args.protocolFeeBps as number,
              pauseFlags: 0xff,
              issuersCount: 0,
              version: 2,
              bump: 255,
            }),
          ),
        );
        create(at("superAdminRecord"), new Uint8Array(getAdminEncoder().encode({ admin: at("admin") as Address, addedBy: at("admin") as Address, bump: 255 })));
        return;
      }
      case AssetRegistryInstruction.SetProtocolTreasury: {
        signed(at("superAdmin"));
        const platform = platformOf();
        if (platform.admin !== at("superAdmin")) fail("Unauthorized");
        writePlatform({ ...platform, protocolTreasury: args.newTreasury as Address });
        return;
      }
      case AssetRegistryInstruction.ProposeAdmin: {
        signed(at("superAdmin"));
        if (platformOf().admin !== at("superAdmin")) fail("Unauthorized");
        if (s.get(at("newAdminRecord"))?.data.length) fail("InvalidProposedAuthority", 6112);
        s.set(at("pendingAdmin"), {
          owner: REGISTRY,
          lamports: rent(98),
          data: new Uint8Array(
            getPendingAdminEncoder().encode({
              newAdmin: args.newAdmin as Address,
              proposedBy: at("superAdmin") as Address,
              proposedAt: now,
              eta: now + BigInt(ADMIN_TIMELOCK),
              expiresAt: now + BigInt(ADMIN_TIMELOCK + PROPOSAL_WINDOW),
              version: 1,
              bump: 255,
            }),
          ),
        });
        return;
      }
      case AssetRegistryInstruction.AddAdmin: {
        // The executor: the NEW admin signs inside the window (bootstrap waives the 48 h).
        signed(at("newAdmin"));
        if (args.newAdmin !== at("newAdmin")) fail("InvalidAdminProposal", 6152);
        const pending = getPendingAdminDecoder().decode((s.get(at("pendingAdmin")) ?? fail("missing", 3012)).data);
        if (pending.proposedBy !== platformOf().admin || pending.proposedBy !== at("proposer")) fail("InvalidAdminProposal", 6152);
        requireWindow(pending.proposedAt, pending.eta, pending.expiresAt, true);
        create(at("adminRecord"), new Uint8Array(getAdminEncoder().encode({ admin: at("newAdmin") as Address, addedBy: pending.proposedBy, bump: 255 })));
        s.delete(at("pendingAdmin"));
        return;
      }
      case AssetRegistryInstruction.CancelAdminProposal: {
        signed(at("canceller"));
        const record = s.get(at("cancellerAdminRecord"));
        const isAdmin = record ? getAdminDecoder().decode(record.data).admin === at("canceller") : false;
        if (platformOf().admin !== at("canceller") && !isAdmin) fail("Unauthorized");
        if (!s.get(at("pendingAdmin"))) fail("missing", 3012);
        s.delete(at("pendingAdmin"));
        return;
      }
      case AssetRegistryInstruction.RemoveAdmin: {
        signed(at("superAdmin"));
        const platform = platformOf();
        if (platform.admin !== at("superAdmin")) fail("Unauthorized");
        if (args.admin === platform.admin) fail("CannotRevokePlatformAdmin");
        if (!s.get(at("adminRecord"))) fail("record missing", 3012);
        s.delete(at("adminRecord"));
        return;
      }
      case AssetRegistryInstruction.CreateKycRegistry: {
        signed(at("authority"));
        signed(at("adminAuthority"));
        const record = s.get(at("adminRecord"));
        if (!record || getAdminDecoder().decode(record.data).admin !== at("adminAuthority")) fail("admin record", 3012);
        create(
          at("kycRegistry"),
          new Uint8Array(
            getKycRegistryEncoder().encode({
              authority: at("authority") as Address,
              approvedJurisdictions: args.approvedJurisdictions as Uint8Array,
              blockedJurisdictions: args.blockedJurisdictions as Uint8Array,
              entriesCount: 0,
              version: 2,
              bump: 255,
            }),
          ),
        );
        return;
      }
      case AssetRegistryInstruction.UpdateKycRegistryJurisdictions: {
        signed(at("authority"));
        const account = s.get(at("kycRegistry")) ?? fail("missing", 3012);
        const registry = getKycRegistryDecoder().decode(account.data);
        if (registry.authority !== at("authority")) fail("Unauthorized");
        account.data = new Uint8Array(
          getKycRegistryEncoder().encode({
            ...registry,
            approvedJurisdictions: args.approvedJurisdictions as Uint8Array,
            blockedJurisdictions: args.blockedJurisdictions as Uint8Array,
          }),
        );
        return;
      }
      case AssetRegistryInstruction.ProposeKycRegistryAuthority: {
        signed(at("authority"));
        const registry = getKycRegistryDecoder().decode((s.get(at("kycRegistry")) ?? fail("missing", 3012)).data);
        if (registry.authority !== at("authority")) fail("Unauthorized");
        s.set(at("transfer"), {
          owner: REGISTRY,
          lamports: rent(163),
          data: proposal(at("kycRegistry"), registry.authority, args.newAuthority as Address, at("authority") as Address, 0, 3),
        });
        return;
      }
      case AssetRegistryInstruction.CancelKycRegistryAuthorityTransfer: {
        signed(at("authority"));
        if (!s.get(at("transfer"))) fail("missing", 3012);
        s.delete(at("transfer"));
        return;
      }
      case AssetRegistryInstruction.AcceptKycRegistryAuthority: {
        signed(at("newAuthority"));
        const registryAccount = s.get(at("kycRegistry")) ?? fail("missing", 3012);
        const registry = getKycRegistryDecoder().decode(registryAccount.data);
        const transfer = getAuthorityProposalDecoder().decode((s.get(at("transfer")) ?? fail("missing", 3012)).data);
        if (transfer.newAuthority !== at("newAuthority") || transfer.currentAuthority !== registry.authority) fail("InvalidAuthorityTransfer");
        if (now >= transfer.expiresAt) fail("ProposalExpired", 6151);
        registryAccount.data = new Uint8Array(getKycRegistryEncoder().encode({ ...registry, authority: at("newAuthority") as Address }));
        s.delete(at("transfer"));
        return;
      }
      case AssetRegistryInstruction.ProposePlatformAdmin: {
        signed(at("authority"));
        const platform = platformOf();
        if (platform.admin !== at("authority")) fail("Unauthorized");
        s.set(at("transfer"), {
          owner: REGISTRY,
          lamports: rent(163),
          data: proposal(at("platform"), platform.admin, args.newAdmin as Address, at("authority") as Address, ADMIN_TIMELOCK, 0),
        });
        return;
      }
      case AssetRegistryInstruction.AcceptPlatformAdmin: {
        signed(at("newAdmin"));
        const platform = platformOf();
        const transfer = getAuthorityProposalDecoder().decode((s.get(at("transfer")) ?? fail("missing", 3012)).data);
        if (transfer.newAuthority !== at("newAdmin") || transfer.currentAuthority !== platform.admin) fail("InvalidAuthorityTransfer");
        requireWindow(transfer.proposedAt, transfer.eta, transfer.expiresAt, true);
        if (s.get(at("recovery"))?.data.length) fail("PlatformRecoveryPending", 6155);
        s.delete(at("oldAdminRecord"));
        s.set(at("newAdminRecord"), {
          owner: REGISTRY,
          lamports: rent(81),
          data: new Uint8Array(getAdminEncoder().encode({ admin: at("newAdmin") as Address, addedBy: platform.admin, bump: 255 })),
        });
        writePlatform({ ...platform, admin: at("newAdmin") as Address });
        s.delete(at("transfer"));
        return;
      }
      case AssetRegistryInstruction.SetPauseFlags: {
        signed(at("authority"));
        const platform = platformOf();
        const setMask = args.setMask as number;
        const clearMask = args.clearMask as number;
        if (platform.admin !== at("authority")) {
          // Any active Admin may set bits (set_pause.rs); only the SA clears.
          const record = s.get(at("adminRecord"));
          if (!record || getAdminDecoder().decode(record.data).admin !== at("authority")) fail("Unauthorized");
        }
        if ((setMask & ~0x7f) !== 0 || (setMask & clearMask) !== 0) fail("InvalidPauseFlags", 6118);
        if (clearMask && platform.admin !== at("authority")) fail("PauseClearNotAllowed");
        if ((clearMask & 0x40) !== 0 && clearMask !== 0x40) fail("PayoutModulesClearNotExplicit", 6154);
        let flags = (platform.pauseFlags | setMask) & ~clearMask & 0xff;
        if (clearMask) flags &= ~PLATFORM_BOOTSTRAP_OPEN;
        writePlatform({ ...platform, pauseFlags: flags });
        return;
      }
      default:
        fail(`unsupported registry instruction ${parsed.instructionType}`, 3);
    }
  }

  private hook(ix: Instruction, s: Map<string, FakeAccount>, signed: (a: string) => unknown) {
    const parsed = parseTransferHookInstruction(ix as Instruction & { data: Uint8Array });
    const accounts = (parsed as unknown as { accounts: Record<string, { address: string } | undefined> }).accounts;
    const args = (parsed as unknown as { data: Record<string, unknown> }).data;
    const at = (name: string) => accounts[name]?.address ?? fail(`no account ${name}`, 4);
    switch (parsed.instructionType) {
      case TransferHookInstruction.InitializeBlocklistAuthority: {
        signed(at("payer"));
        signed(at("upgradeAuthority"));
        const pd = s.get(at("programData"));
        const ua = pd && pd.data[12] === 1 ? getAddressDecoder().decode(pd.data.subarray(13, 45)) : null;
        if (ua !== at("upgradeAuthority")) fail("Unauthorized");
        if (s.get(at("blocklistAuthority"))) fail("in use", 0);
        s.set(at("blocklistAuthority"), {
          owner: HOOK,
          lamports: rent(41),
          data: new Uint8Array(getBlocklistAuthorityEncoder().encode({ authority: args.authority as Address, bump: 255 })),
        });
        return;
      }
      case TransferHookInstruction.ProposeBlocklistAuthority: {
        signed(at("authority"));
        const ba = getBlocklistAuthorityDecoder().decode((s.get(at("blocklistAuthority")) ?? fail("missing", 3012)).data);
        if (ba.authority !== at("authority")) fail("Unauthorized");
        const now = BigInt(this.now);
        s.set(at("transfer"), {
          owner: HOOK,
          lamports: rent(89),
          data: new Uint8Array(
            getBlocklistAuthorityProposalEncoder().encode({
              currentAuthority: ba.authority,
              newAuthority: args.newAuthority as Address,
              proposedAt: now,
              expiresAt: now + BigInt(PROPOSAL_WINDOW),
              bump: 255,
            }),
          ),
        });
        return;
      }
      case TransferHookInstruction.AcceptBlocklistAuthority: {
        signed(at("newAuthority"));
        const account = s.get(at("blocklistAuthority")) ?? fail("missing", 3012);
        const ba = getBlocklistAuthorityDecoder().decode(account.data);
        const transfer = getBlocklistAuthorityProposalDecoder().decode((s.get(at("transfer")) ?? fail("missing", 3012)).data);
        if (transfer.newAuthority !== at("newAuthority") || transfer.currentAuthority !== ba.authority) fail("InvalidAuthorityTransfer");
        if (BigInt(this.now) >= transfer.expiresAt) fail("ProposalExpired", 6017);
        if (s.get(at("recovery"))?.data.length) fail("RecoveryPending", 6020);
        account.data = new Uint8Array(getBlocklistAuthorityEncoder().encode({ ...ba, authority: at("newAuthority") as Address }));
        s.delete(at("transfer"));
        return;
      }
      case TransferHookInstruction.AddToBlocklist:
      case TransferHookInstruction.RemoveFromBlocklist: {
        signed(at("authority"));
        const ba = getBlocklistAuthorityDecoder().decode((s.get(at("blocklistAuthority")) ?? fail("missing", 3012)).data);
        if (ba.authority !== at("authority")) fail("Unauthorized");
        if (parsed.instructionType === TransferHookInstruction.AddToBlocklist) {
          if (s.get(at("blockEntry"))) fail("already in use", 0);
          s.set(at("blockEntry"), {
            owner: HOOK,
            lamports: rent(73),
            data: new Uint8Array(getBlockEntryEncoder().encode({ wallet: args.wallet as Address, addedBy: at("authority") as Address, bump: 255 })),
          });
        } else {
          if (!s.get(at("blockEntry"))) fail("AccountNotInitialized", 3012);
          s.delete(at("blockEntry"));
        }
        return;
      }
      case TransferHookInstruction.UpdateTransferHookConfig: {
        signed(at("authority"));
        const ba = getBlocklistAuthorityDecoder().decode((s.get(at("blocklistAuthority")) ?? fail("missing", 3012)).data);
        if (ba.authority !== at("authority")) fail("Unauthorized");
        const account = s.get(at("config")) ?? fail("config missing", 3012);
        const config = getTransferHookConfigDecoder().decode(account.data);
        const registry = unwrapOption(args.kycRegistry as Option<Address>);
        if ((args.restrictionMode === RestrictionMode.KycGated) !== (registry !== null)) fail("InvalidKycRegistry");
        if (registry) {
          const passed = accounts.kycRegistryAccount?.address;
          const live = passed ? s.get(passed) : undefined;
          if (passed !== registry || !live || live.owner !== REGISTRY) fail("InvalidKycRegistry");
        }
        account.data = new Uint8Array(
          getTransferHookConfigEncoder().encode({ ...config, restrictionMode: args.restrictionMode as RestrictionMode, kycRegistry: registry }),
        );
        return;
      }
      default:
        fail(`unsupported hook instruction ${parsed.instructionType}`, 3);
    }
  }

  // ── Seeding ────────────────────────────────────────────────────────────────
  fund(address: string, lamports: bigint) {
    const account = this.get(address) ?? { owner: SYSTEM_PROGRAM, lamports: BigInt(0), data: new Uint8Array() };
    account.lamports += lamports;
    this.set(address, account);
  }

  async deployProgram(program: Address, input: { authority: Address | null; payload: Uint8Array; capacity?: number }) {
    const programData = await programDataAddress(program);
    const link = new Uint8Array(36);
    new DataView(link.buffer).setUint32(0, 2, true);
    link.set(getAddressEncoder().encode(programData), 4);
    this.set(program, { owner: LOADER_V3, lamports: rent(36), data: link, executable: true });
    const capacity = input.capacity ?? input.payload.length + 1024;
    const data = new Uint8Array(45 + capacity);
    const view = new DataView(data.buffer);
    view.setUint32(0, 3, true);
    view.setBigUint64(4, BigInt(4000), true);
    if (input.authority) {
      data[12] = 1;
      data.set(getAddressEncoder().encode(input.authority), 13);
    }
    data.set(input.payload, 45);
    this.set(programData, { owner: LOADER_V3, lamports: rent(data.length), data });
    return programData;
  }

  async seedMultisig(input: {
    multisig: Address;
    threshold: number;
    timeLock?: number;
    configAuthority?: Address | null;
    members: { key: Address; mask: number }[];
  }) {
    const data = encodeMultisig({
      createKey: key(201),
      configAuthority: input.configAuthority ?? null,
      threshold: input.threshold,
      timeLock: input.timeLock ?? 0,
      transactionIndex: BigInt(0),
      staleTransactionIndex: BigInt(0),
      rentCollector: null,
      bump: 254,
      members: input.members,
    });
    this.set(input.multisig, { owner: SQUADS_V4_PROGRAM, lamports: rent(data.length), data });
    return squadsVaultPda(input.multisig, 0);
  }

  async adminRecordAddress(wallet: Address) {
    return (await findAdminRecordPda({ authority: wallet }))[0];
  }
}

// ── Keys, maps, env ──────────────────────────────────────────────────────────

export type TestKeypair = { path: string; address: Address };

/** Writes a freshly generated test keypair (64-byte JSON) under `dir`. */
export function writeKeypair(dir: string, name: string): TestKeypair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify([...seed, ...pub]));
  return { path: file, address: getAddressDecoder().decode(pub) };
}

export function tempDir(prefix = "chain-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export type MapKeys = {
  deployer: Address;
  bufferWriter: Address;
  superAdmin: Address;
  admins: Address[];
  blocklistAuthority: Address;
  kycAuthority: Address;
  multisig: Address;
  vault: Address;
  members: Address[];
};

export async function defaultKeys(overrides: Partial<MapKeys> = {}): Promise<MapKeys> {
  const multisig = overrides.multisig ?? key(40);
  return {
    deployer: key(21),
    bufferWriter: key(22),
    superAdmin: key(23),
    admins: [key(24)],
    blocklistAuthority: key(25),
    kycAuthority: key(26),
    multisig,
    vault: await squadsVaultPda(multisig, 0),
    members: [key(31), key(32), key(33)],
    ...overrides,
  };
}

/** A role map JSON (unvalidated) for the given keys. */
export async function roleMapJson(
  keys: MapKeys,
  network: "devnet" | "localnet" | "mainnet" | "testnet" = "devnet",
  genesis: string = CLUSTER_GENESIS_HASHES.devnet,
  overrides: Record<string, unknown> = {},
) {
  const { getRegistryPda } = await import("@/lib/passport");
  return {
    schema: "mancipatio-role-map-v2",
    network,
    genesisHash: genesis,
    programs: { assetRegistry: REGISTRY, transferHook: HOOK },
    programDataMaxLen: { assetRegistry: 3145728, transferHook: 786432 },
    deployer: keys.deployer,
    bufferWriter: keys.bufferWriter,
    superAdmin: keys.superAdmin,
    admins: keys.admins,
    blocklistAuthority: keys.blocklistAuthority,
    kyc: {
      authority: keys.kycAuthority,
      registry: await getRegistryPda(keys.deployer),
      approvedJurisdictions: "default",
      blockedJurisdictions: [],
      tempAdminGrant: false,
    },
    protocolTreasury: keys.vault,
    protocolFeeBps: 0,
    squads: {
      multisig: keys.multisig,
      vaultIndex: 0,
      vault: keys.vault,
      threshold: 2,
      timeLock: 0,
      configAuthority: null,
      members: keys.members.map((k) => ({ key: k, permissions: ["initiate", "vote", "execute"] })),
    },
    unpauseBy: "superAdmin",
    ...overrides,
  };
}

/** Immediate timing for the send state machine (no real waiting). */
export function instantTiming(chain?: FakeChain, advancePerSleep = BigInt(0)) {
  let now = 0;
  return {
    pollMs: 2_000,
    rebroadcastMs: 5_000,
    finalizeBudgetMs: 120_000,
    maxPollFailures: 5,
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
      if (chain) chain.blockHeight += advancePerSleep;
    },
  };
}
