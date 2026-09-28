// An in-memory chain for the indexer's own RPC calls, shaped like the answers
// @solana/kit returns (bigint slots, [base64, "base64"] data, `.send()`):
// getMultipleAccounts, getProgramAccounts (memcmp at offset 0 and dataSize
// filters), getSignaturesForAddress (newest first, `before`, `limit`),
// getTransaction and getSlot. The tests move `slot` and the accounts
// themselves; `lagging` answers the next getMultipleAccounts calls from an
// older view (a node behind the others), and `calls` records every method
// with its options (the benchmark counts calls and response bytes).
import { getBase58Encoder } from "@solana/kit";

export type ChainAccount = { owner: string; data: Uint8Array };
export type ListedSignature = { signature: string; slot: number; blockTime: number | null; err: unknown };
type View = { slot: number; accounts: Map<string, ChainAccount | null> };
type Filter = { memcmp?: { offset: bigint; bytes: string; encoding: string }; dataSize?: bigint };

export const CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111";
const SYSVAR_OWNER = "Sysvar1111111111111111111111111111111111111";

const encoded = (account: ChainAccount) => ({
  owner: account.owner, data: [Buffer.from(account.data).toString("base64"), "base64"] as const,
  executable: false, lamports: BigInt(1), rentEpoch: BigInt(0), space: BigInt(account.data.length),
});

export class IndexerChain {
  /** The finalized slot every answer reports (unless a lagging view answers). */
  slot = 1_000;
  /** The confirmed tip getSlot returns (defaults to slot + 32). */
  tip: number | null = null;
  /** Seconds the finalized block time trails the wall clock. */
  chainLagSeconds = 15;
  readonly accounts = new Map<string, ChainAccount>();
  /** Per address, newest first. */
  readonly signatures = new Map<string, ListedSignature[]>();
  readonly transactions = new Map<string, unknown>();
  readonly calls: { method: string; args: unknown[]; bytes: number }[] = [];
  private readonly lagging: View[] = [];
  /** Delay (ms) before each answer, per method (the benchmark's network model). */
  latencyMs: Partial<Record<string, number>> = {};

  set(address: string, account: ChainAccount | null) {
    if (account) this.accounts.set(address, { owner: account.owner, data: Uint8Array.from(account.data) });
    else this.accounts.delete(address);
  }
  /** The next getMultipleAccounts answers come from this older view, once each. */
  lag(slot: number, accounts: Record<string, ChainAccount | null>) {
    this.lagging.push({ slot, accounts: new Map(Object.entries(accounts)) });
  }
  /** A transaction listed (newest first) under each of `addresses`. */
  list(addresses: string[], entry: ListedSignature, tx?: unknown) {
    for (const address of addresses) {
      const rows = this.signatures.get(address) ?? [];
      rows.push(entry);
      rows.sort((a, b) => b.slot - a.slot || (a.signature < b.signature ? 1 : -1));
      this.signatures.set(address, rows);
    }
    if (tx !== undefined) this.transactions.set(entry.signature, tx);
  }
  /** The Clock sysvar of the finalized bank: its slot and block time. */
  private clock(slot: number) {
    const data = new Uint8Array(40);
    const view = new DataView(data.buffer);
    view.setBigUint64(0, BigInt(slot), true);
    view.setBigInt64(32, BigInt(Math.floor(Date.now() / 1000) - this.chainLagSeconds), true);
    return { owner: SYSVAR_OWNER, data };
  }

  private async answer<T>(method: string, args: unknown[], value: () => T, bytes: (v: T) => number = () => 0): Promise<T> {
    const delay = this.latencyMs[method] ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const v = value();
    this.calls.push({ method, args, bytes: bytes(v) });
    return v;
  }

  rpc() {
    const send = <T>(fn: () => Promise<T>) => ({ send: () => fn() });
    return {
      getSlot: (opts?: unknown) => send(() => this.answer("getSlot", [opts], () => BigInt(this.tip ?? this.slot + 32))),
      getMultipleAccounts: (keys: string[], opts?: { minContextSlot?: bigint }) => send(() => this.answer("getMultipleAccounts", [keys, opts], () => {
        const view = this.lagging.shift();
        const slot = view?.slot ?? this.slot;
        if (opts?.minContextSlot !== undefined && BigInt(slot) < opts.minContextSlot) {
          throw Object.assign(new Error("Minimum context slot has not been reached"), { code: -32016 });
        }
        const value = keys.map((key) => {
          const k = String(key);
          if (k === CLOCK_SYSVAR) return encoded(this.clock(slot));
          const account = view?.accounts.has(k) ? view.accounts.get(k) ?? null : this.accounts.get(k) ?? null;
          return account ? encoded(account) : null;
        });
        return { context: { slot: BigInt(slot) }, value };
      }, (v) => v.value.reduce((n, a) => n + (a ? a.data[0].length : 0), 0))),
      getProgramAccounts: (program: string, opts?: { filters?: Filter[] }) => send(() => this.answer("getProgramAccounts", [program, opts], () => {
        const filters = opts?.filters ?? [];
        const value = [...this.accounts.entries()]
          .filter(([, a]) => a.owner === String(program))
          .filter(([, a]) => filters.every((f) => {
            if (f.dataSize !== undefined) return a.data.length === Number(f.dataSize);
            if (f.memcmp) {
              const want = getBase58Encoder().encode(f.memcmp.bytes);
              const at = Number(f.memcmp.offset);
              return want.every((b, i) => a.data[at + i] === b);
            }
            return true;
          }))
          .map(([pubkey, a]) => ({ pubkey, account: encoded(a) }));
        return { context: { slot: BigInt(this.slot) }, value };
      }, (v) => v.value.reduce((n, a) => n + a.account.data[0].length, 0))),
      getSignaturesForAddress: (target: string, opts?: { limit?: number; before?: string }) => send(() => this.answer("getSignaturesForAddress", [target, opts], () => {
        const rows = this.signatures.get(String(target)) ?? [];
        const from = opts?.before ? rows.findIndex((r) => r.signature === String(opts.before)) + 1 : 0;
        return rows.slice(from, from + (opts?.limit ?? 1000)).map((r) => ({
          signature: r.signature, slot: BigInt(r.slot), blockTime: r.blockTime === null ? null : BigInt(r.blockTime),
          err: r.err, memo: null, confirmationStatus: "finalized",
        }));
      })),
      getTransaction: (sig: string) => send(() => this.answer("getTransaction", [sig], () => this.transactions.get(String(sig)) ?? null)),
    };
  }
}
