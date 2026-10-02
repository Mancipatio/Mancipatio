/**
 * `npm run ops:inspect-tx`: the independent check of a transaction a Ledger
 * blind-signs on the operator front ("Ledger (USB)", lib/ledger-usb.ts;
 * ops/runbook-mainnet.md §5).
 *
 * With blind signing the Solana app shows only base58(SHA-256(message)). The
 * page shows the same hash, but it computed it itself: a compromised page
 * would show the hash of its own transaction. So the page offers the message
 * bytes (base64), and this tool, run from a reviewed checkout on the
 * operator's own computer, decodes them offline (programs, instructions by
 * the committed IDL clients, named accounts, arguments) and prints the hash
 * of exactly those bytes. Matching that hash on the device means the device
 * signs what is printed here. Nothing is sent and no RPC is called.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  AccountRole,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  type AccountMeta,
  type Address,
  type Instruction,
  type InstructionWithData,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { identifyToken2022Instruction, Token2022Instruction, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  AssetRegistryInstruction,
  parseAssetRegistryInstruction,
} from "@/lib/generated/asset_registry";
import {
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  TransferHookInstruction,
  parseTransferHookInstruction,
} from "@/lib/generated/transfer_hook";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export type InspectedTransaction = {
  /** base58(SHA-256(message)): what the Solana app shows when it blind-signs. */
  hash: string;
  lines: string[];
  /** Reasons not to approve without a second look (unknown program, lookup tables, …). */
  warnings: string[];
};

/** Addresses named by a role map (`mancipatio-role-map-v2`), for labels only:
 * the map is read as plain JSON and never validated or trusted here. */
export function roleMapLabels(json: unknown): Map<string, string[]> {
  const labels = new Map<string, string[]>();
  const add = (value: unknown, label: string) => {
    if (typeof value !== "string" || value.length === 0) return;
    labels.set(value, [...(labels.get(value) ?? []), label]);
  };
  if (!json || typeof json !== "object") return labels;
  const map = json as Record<string, unknown>;
  const kyc = (map.kyc ?? {}) as Record<string, unknown>;
  const squads = (map.squads ?? {}) as Record<string, unknown>;
  const programs = (map.programs ?? {}) as Record<string, unknown>;
  add(map.superAdmin, "superAdmin");
  if (Array.isArray(map.admins)) map.admins.forEach((admin, i) => add(admin, `admins[${i}]`));
  add(map.blocklistAuthority, "blocklistAuthority");
  add(kyc.authority, "kyc.authority");
  add(kyc.registry, "kyc.registry");
  add(map.protocolTreasury, "protocolTreasury");
  add(map.deployer, "deployer");
  add(map.bufferWriter, "bufferWriter");
  add(squads.vault, "squads.vault");
  add(squads.multisig, "squads.multisig");
  add(programs.assetRegistry, "programs.assetRegistry");
  add(programs.transferHook, "programs.transferHook");
  return labels;
}

const ROLE_TEXT: Record<AccountRole, string> = {
  [AccountRole.READONLY]: "readonly",
  [AccountRole.WRITABLE]: "writable",
  [AccountRole.READONLY_SIGNER]: "signer, readonly",
  [AccountRole.WRITABLE_SIGNER]: "signer, writable",
};

const hex = (bytes: ReadonlyUint8Array) => Buffer.from(bytes).toString("hex");

/** Instruction arguments as one line: bigints as numbers, bytes as hex. */
function printable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Uint8Array) return `0x${hex(v)}`;
    return v;
  });
}

const u32 = (data: ReadonlyUint8Array, at: number) => Buffer.from(data).readUInt32LE(at);
const u64 = (data: ReadonlyUint8Array, at: number) => Buffer.from(data).readBigUInt64LE(at);

/** Known non-Manci programs: their name and the instruction, where it is simple to read. */
function describeOtherProgram(program: string, data: ReadonlyUint8Array): { name: string; text: string } | null {
  try {
    if (program === COMPUTE_BUDGET_PROGRAM) {
      const kind = data[0];
      if (kind === 2) return { name: "ComputeBudget", text: `SetComputeUnitLimit ${u32(data, 1)}` };
      if (kind === 3) return { name: "ComputeBudget", text: `SetComputeUnitPrice ${u64(data, 1)} micro-lamports` };
      if (kind === 1) return { name: "ComputeBudget", text: `RequestHeapFrame ${u32(data, 1)}` };
      if (kind === 4) return { name: "ComputeBudget", text: `SetLoadedAccountsDataSizeLimit ${u32(data, 1)}` };
      return { name: "ComputeBudget", text: `instruction ${kind}` };
    }
    if (program === SYSTEM_PROGRAM) {
      const kind = u32(data, 0);
      if (kind === 2) return { name: "System", text: `Transfer ${u64(data, 4)} lamports` };
      if (kind === 0) return { name: "System", text: `CreateAccount ${u64(data, 4)} lamports, ${u64(data, 12)} bytes` };
      return { name: "System", text: `instruction ${kind}` };
    }
    if (program === TOKEN_2022_PROGRAM_ADDRESS) {
      return { name: "Token-2022", text: Token2022Instruction[identifyToken2022Instruction(data)] };
    }
    if (program === TOKEN_PROGRAM) return { name: "Token", text: `instruction ${data[0]}` };
    if (program === ATA_PROGRAM) {
      return { name: "AssociatedToken", text: data.length === 0 || data[0] === 0 ? "Create" : data[0] === 1 ? "CreateIdempotent" : `instruction ${data[0]}` };
    }
    if (program === MEMO_PROGRAM) return { name: "Memo", text: JSON.stringify(new TextDecoder().decode(data)) };
  } catch {
    return null;
  }
  return null;
}

type ManciParsed = {
  instructionType: number;
  accounts: Record<string, AccountMeta | undefined>;
  data: Record<string, unknown>;
};

/**
 * Decodes a transaction message (base64, as the "Ledger (USB)" notice copies
 * it) offline and returns what it does and its hash. Throws when the bytes are
 * not one whole transaction message.
 */
export function inspectTransactionMessage(base64: string, labels: Map<string, string[]> = new Map()): InspectedTransaction {
  const text = base64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error("The input is not base64: copy the transaction from the Ledger notice again.");
  const bytes = new Uint8Array(getBase64Encoder().encode(text));
  let decoded: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["read"]>;
  try {
    decoded = getCompiledTransactionMessageDecoder().read(bytes, 0);
  } catch (error) {
    throw new Error(`The input is not a transaction message (${error instanceof Error ? error.message : String(error)}): copy the transaction from the Ledger notice again.`, { cause: error });
  }
  const [message, end] = decoded;
  if (end !== bytes.length) throw new Error(`The input has ${bytes.length - end} byte(s) after the transaction message: not a message copied from the Ledger notice.`);

  const label = (value: string) => {
    const names = labels.get(value);
    return names ? `${value} [${names.join(", ")}]` : value;
  };
  const lines: string[] = [];
  const warnings: string[] = [];

  const { header, staticAccounts } = message;
  const lookups = message.version === 0 ? message.addressTableLookups ?? [] : [];
  const roleOf = (index: number): AccountRole => {
    const signer = index < header.numSignerAccounts;
    const writable = signer
      ? index < header.numSignerAccounts - header.numReadonlySignerAccounts
      : index < staticAccounts.length - header.numReadonlyNonSignerAccounts;
    return signer ? (writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : writable ? AccountRole.WRITABLE : AccountRole.READONLY;
  };
  const accountAt = (index: number): AccountMeta | null =>
    index < staticAccounts.length ? { address: staticAccounts[index], role: roleOf(index) } : null;

  lines.push(`Transaction message (${message.version === "legacy" ? "legacy" : `v${message.version}`}), ${header.numSignerAccounts} signature(s) required`);
  lines.push(`  fee payer: ${label(staticAccounts[0])}`);
  for (let i = 0; i < header.numSignerAccounts; i++) lines.push(`  signer: ${label(staticAccounts[i])} (${ROLE_TEXT[roleOf(i)]})`);
  lines.push(`  lifetime: ${message.lifetimeToken} (a recent blockhash or a durable nonce)`);
  if (lookups.length > 0) {
    warnings.push(`The message loads accounts from ${lookups.length} address lookup table(s) (${lookups.map((l) => l.lookupTableAddress).join(", ")}): those accounts cannot be checked offline. Manci's role and admin steps never use lookup tables: do not approve.`);
  }

  lines.push("Instructions:");
  message.instructions.forEach((compiled, i) => {
    const program = staticAccounts[compiled.programAddressIndex] as string;
    const data = compiled.data ?? new Uint8Array();
    const metas = (compiled.accountIndices ?? []).map(accountAt);
    const n = `  #${i + 1}`;
    const resolved = metas.every((meta): meta is AccountMeta => meta !== null);

    const manci = program === ASSET_REGISTRY_PROGRAM_ADDRESS ? { name: "asset_registry", names: AssetRegistryInstruction, parse: parseAssetRegistryInstruction }
      : program === TRANSFER_HOOK_PROGRAM_ADDRESS ? { name: "transfer_hook", names: TransferHookInstruction, parse: parseTransferHookInstruction }
        : null;
    if (manci) {
      let parsed: ManciParsed;
      try {
        if (!resolved) throw new Error("an account comes from a lookup table");
        const instruction = { programAddress: program as Address, accounts: metas, data } as Instruction & InstructionWithData<ReadonlyUint8Array>;
        parsed = manci.parse(instruction) as unknown as ManciParsed;
      } catch (error) {
        lines.push(`${n} ${manci.name}: could not be decoded (${error instanceof Error ? error.message : String(error)}); data 0x${hex(data)}`);
        warnings.push(`Instruction #${i + 1} (${manci.name}) does not decode with this checkout's IDL client: do not approve.`);
        return;
      }
      lines.push(`${n} ${manci.name}: ${(manci.names as Record<number, string>)[parsed.instructionType]}`);
      for (const [name, meta] of Object.entries(parsed.accounts)) {
        lines.push(meta ? `       ${name}: ${label(meta.address)} (${ROLE_TEXT[meta.role]})` : `       ${name}: (none)`);
      }
      const args = Object.fromEntries(Object.entries(parsed.data).filter(([key]) => key !== "discriminator"));
      lines.push(`       args: ${Object.keys(args).length === 0 ? "none" : printable(args)}`);
      return;
    }

    const other = describeOtherProgram(program, data);
    if (other) {
      lines.push(`${n} ${other.name}: ${other.text}`);
    } else {
      lines.push(`${n} UNKNOWN PROGRAM ${label(program)}: data 0x${hex(data)}`);
      warnings.push(`Instruction #${i + 1} calls a program this tool does not know (${program}): do not approve unless you expected it.`);
    }
    metas.forEach((meta, k) => {
      const index = compiled.accountIndices![k];
      lines.push(meta ? `       account ${k}: ${label(meta.address)} (${ROLE_TEXT[meta.role]})` : `       account ${k}: from a lookup table (index ${index})`);
    });
  });

  const hash = getBase58Decoder().decode(createHash("sha256").update(bytes).digest());
  return { hash, lines, warnings };
}

/** The runner (scripts/ops/inspect-tx.test.ts): reads INSPECT_TX_MESSAGE
 * (base64) and, optionally, INSPECT_ROLE_MAP (a role map JSON file, for labels). */
export function runInspectTx(
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
): InspectedTransaction {
  const input = env.INSPECT_TX_MESSAGE?.trim();
  if (!input) throw new Error('Set INSPECT_TX_MESSAGE to the transaction copied from the Ledger notice, e.g. INSPECT_TX_MESSAGE="$(pbpaste)" npm run ops:inspect-tx');
  const labels = env.INSPECT_ROLE_MAP ? roleMapLabels(JSON.parse(fs.readFileSync(env.INSPECT_ROLE_MAP, "utf8"))) : new Map<string, string[]>();
  const result = inspectTransactionMessage(input, labels);
  for (const line of result.lines) log(line);
  for (const warning of result.warnings) log(`WARNING: ${warning}`);
  log("");
  log(`Message hash (the Ledger must show exactly this): ${result.hash}`);
  log("Approve on the Ledger only if the instructions above are the step you started and the hash matches; otherwise reject on the Ledger.");
  return result;
}
