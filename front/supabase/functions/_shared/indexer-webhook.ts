/** Runtime-neutral receiver; the Edge adapter only supplies durable DB enqueue. */
export type IndexerEvent = {
  signature: string; slot: number | null; block_time: string | null;
  ix_name: string | null; wallets: string[]; payload: Record<string, unknown>;
};
type Config = { secret: string; network: string; enqueue: (events: IndexerEvent[], signal: AbortSignal) => Promise<number> };
const NETWORKS = new Set(["mainnet", "devnet", "testnet", "localnet"]);
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
const MAX_BYTES = 2 * 1024 * 1024;
const PROGRAMS = new Set(["FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS", "GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const reply = (status: number, message: string) => Response.json({ message }, { status, headers: { "Cache-Control": "no-store" } });
async function sameSecret(a: string, b: string) {
  const digest = (s: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const [aa, bb] = await Promise.all([digest(a), digest(b)]);
  const x = new Uint8Array(aa); const y = new Uint8Array(bb);
  let mismatch = 0;
  for (let i = 0; i < x.length; i++) mismatch |= x[i] ^ y[i];
  return mismatch === 0;
}
async function readBounded(req: Request): Promise<unknown> {
  if (Number(req.headers.get("content-length")) > MAX_BYTES) throw new RangeError("Body too large");
  if (!req.body) throw new Error("Missing body");
  const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      req.signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) throw new RangeError("Body too large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function parseEvent(value: unknown): IndexerEvent {
  if (!object(value) || typeof value.signature !== "string" || !SIGNATURE.test(value.signature)) throw new Error("Invalid signature");
  const slot = value.slot ?? null;
  if (slot !== null && (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 0)) throw new Error("Invalid slot");
  let block_time: string | null = null;
  if (value.timestamp != null) {
    if (typeof value.timestamp !== "number" || !Number.isSafeInteger(value.timestamp) || value.timestamp < 0 || value.timestamp > 8640000000000) throw new Error("Invalid timestamp");
    block_time = new Date(value.timestamp * 1000).toISOString();
  }
  if (value.type != null && (typeof value.type !== "string" || value.type.length > 128)) throw new Error("Invalid type");
  const wallets = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v !== "string" || !ADDRESS.test(v)) throw new Error("Invalid account address");
    wallets.add(v); if (wallets.size > 500) throw new RangeError("Too many accounts");
  };
  // Helius accountData includes CPI writes and closures. Instructions preserve
  // accounts even when the provider omitted them from accountData.
  if (value.accountData !== undefined) {
    if (!Array.isArray(value.accountData) || value.accountData.length > 500) throw new Error("Invalid accountData");
    for (const account of value.accountData) { if (!object(account)) throw new Error("Invalid accountData"); add(account.account); }
  }
  let instructionCount = 0;
  const visit = (list: unknown, depth: number) => {
    if (!Array.isArray(list) || depth > 4) throw new Error("Invalid instructions");
    for (const ix of list) {
      if (++instructionCount > 1000 || !object(ix)) throw new Error("Invalid instruction");
      if (PROGRAMS.has(String(ix.programId))) {
        if (!Array.isArray(ix.accounts) || ix.accounts.length > 500) throw new Error("Invalid instruction accounts");
        ix.accounts.forEach(add);
      }
      if (ix.innerInstructions !== undefined) visit(ix.innerInstructions, depth + 1);
    }
  };
  if (value.instructions !== undefined) visit(value.instructions, 0);
  if (wallets.size === 0) throw new Error("Missing touched accounts");
  return { signature: value.signature, slot, block_time, ix_name: typeof value.type === "string" ? value.type : null, wallets: [...wallets], payload: value };
}
export async function handleIndexerWebhook(req: Request, config: Config): Promise<Response> {
  if (req.method !== "POST") return reply(405, "POST required");
  if (config.secret.length < 32 || /\s/.test(config.secret) || !NETWORKS.has(config.network)) return reply(503, "Indexer receiver is not configured");
  const auth = req.headers.get("authorization") ?? "";
  if (auth.length > 1024 || !await sameSecret(auth.startsWith("Bearer ") ? auth.slice(7) : auth, config.secret)) return reply(401, "Unauthorized");
  let events: IndexerEvent[];
  try {
    const body = await readBounded(req);
    if (!Array.isArray(body) || body.length < 1 || body.length > 100) throw new Error("Invalid batch");
    events = body.map(parseEvent);
  } catch (error) { return reply(error instanceof RangeError ? 413 : 400, "Invalid webhook batch"); }
  try {
    const count = await config.enqueue(events, AbortSignal.any([req.signal, AbortSignal.timeout(12_000)]));
    if (count !== events.length) throw new Error("Incomplete acknowledgement");
    return reply(202, "Durably queued");
  } catch { return reply(503, "Queue unavailable; retry delivery"); }
}
