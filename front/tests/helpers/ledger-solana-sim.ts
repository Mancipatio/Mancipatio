// An APDU-level simulation of the Ledger Solana app, behind a real
// @ledgerhq/hw-transport Transport, so the tests drive the real
// @ledgerhq/hw-app-solana 7.11.0 (path encoding, chunking) exactly as the
// browser does. It follows LedgerHQ/app-solana (master, 2026-08):
//   * apdu.c — signing instructions carry a one-byte path count, then the
//     path, then the message; chunks set P2_MORE (0x02) / P2_EXTEND (0x01);
//     GET_ADDR carries the path only;
//   * handle_sign_offchain_message.c + libsol/parser.c — the off-chain
//     message is the WHOLE envelope ("\xffsolana offchain", version 0,
//     application domain, format, signers, u16 length, body); length must
//     match, a signer must be the key at the path (else 0x6a81), format 0
//     must be ASCII (0x6a82);
//   * utils.c set_result_sign_message — the ed25519 signature covers the
//     whole message as received;
//   * 0x5515 locked, 0x6e00 app not open, 0x6985 refused, 0x6808 blind
//     signing needed (accepted by hw-app-solana and rethrown as an Error).
// The keys are real (WebCrypto Ed25519): what the "device" signs verifies.
import Transport from "@ledgerhq/hw-transport";
import { generateKeyPair, getAddressFromPublicKey, getAddressEncoder, signBytes } from "@solana/kit";

export type SimKey = { keys: CryptoKeyPair; address: string; publicKey: Uint8Array };

export type SimOptions = {
  version?: [number, number, number];
  blindSigningEnabled?: boolean;
  locked?: boolean;
  /** The dashboard (or another app) is open instead of Solana. */
  appClosed?: boolean;
  /** Instructions the user rejects on the device (0x05 with display, 0x06, 0x07). */
  reject?: Set<number>;
  /** Pre-1.8 parsing: the legacy off-chain header (no application domain, no signers). */
  legacyOffchain?: boolean;
  /** Transactions the app cannot show without blind signing (our programs). */
  needsBlindSigning?: boolean;
};

const DOMAIN = Buffer.from("\xffsolana offchain", "latin1");
const HARDENED = 0x80000000;

export async function simKeys(paths: readonly string[]): Promise<Map<string, SimKey>> {
  const out = new Map<string, SimKey>();
  for (const path of paths) {
    const keys = await generateKeyPair();
    const address = await getAddressFromPublicKey(keys.publicKey);
    out.set(path, { keys, address, publicKey: new Uint8Array(getAddressEncoder().encode(address)) });
  }
  return out;
}

const sw = (code: number) => Buffer.from([code >> 8, code & 0xff]);

export class SolanaAppSim extends Transport {
  readonly apdus: { ins: number; p1: number; p2: number; length: number }[] = [];
  readonly signed: { ins: number; path: string; message: Buffer }[] = [];
  closed = 0;
  private chunks: { ins: number; data: Buffer } | null = null;

  constructor(readonly keys: Map<string, SimKey>, readonly options: SimOptions = {}) {
    super();
  }

  async close(): Promise<void> {
    this.closed += 1;
  }

  async exchange(apdu: Buffer): Promise<Buffer> {
    const [cla, ins, p1, p2, length] = apdu;
    const data = apdu.subarray(5, 5 + length);
    this.apdus.push({ ins, p1, p2, length });
    if (this.options.locked) return sw(0x5515);
    if (cla !== 0xe0 || this.options.appClosed) return sw(0x6e00);
    if (ins === 0x04) {
      const [major, minor, patch] = this.options.version ?? [1, 16, 0];
      return Buffer.concat([Buffer.from([this.options.blindSigningEnabled === false ? 0 : 1, 0, major, minor, patch]), sw(0x9000)]);
    }
    if (ins === 0x05) {
      const { path } = this.readPath(data, 0);
      const key = this.keys.get(path);
      if (!key) return sw(0x6a84);
      if (p1 === 1 && this.options.reject?.has(0x05)) return sw(0x6985);
      return Buffer.concat([Buffer.from(key.publicKey), sw(0x9000)]);
    }
    if (ins !== 0x06 && ins !== 0x07) return sw(0x6d00);
    // Chunked payload: P2_MORE (0x02) = more follows, P2_EXTEND (0x01) = continuation.
    const continuing = (p2 & 0x01) !== 0;
    if (!continuing) this.chunks = { ins, data: Buffer.from(data) };
    else if (!this.chunks || this.chunks.ins !== ins) return sw(0x6a80);
    else this.chunks.data = Buffer.concat([this.chunks.data, data]);
    if ((p2 & 0x02) !== 0) return sw(0x9000);
    const payload = this.chunks!.data;
    this.chunks = null;
    if (payload[0] !== 1) return sw(0x6a80); // exactly one derivation path
    const { path, end } = this.readPath(payload, 1);
    const key = this.keys.get(path);
    if (!key) return sw(0x6a84);
    const message = payload.subarray(end);
    if (ins === 0x07) {
      const refusal = this.checkOffchain(message, key);
      if (refusal) return sw(refusal);
    } else if (this.options.needsBlindSigning && this.options.blindSigningEnabled === false) {
      return sw(0x6808);
    }
    if (this.options.reject?.has(ins)) return sw(0x6985);
    this.signed.push({ ins, path, message: Buffer.from(message) });
    const signature = await signBytes(key.keys.privateKey, message);
    return Buffer.concat([Buffer.from(signature), sw(0x9000)]);
  }

  private readPath(data: Buffer, at: number): { path: string; end: number } {
    const count = data[at];
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      const n = data.readUInt32BE(at + 1 + i * 4);
      parts.push(n >= HARDENED ? `${n - HARDENED}'` : String(n));
    }
    return { path: parts.join("/"), end: at + 1 + count * 4 };
  }

  /** The device side of one APDU (for a USB HID front end). */
  answer(apdu: Uint8Array): Promise<Buffer> {
    return this.exchange(Buffer.from(apdu));
  }

  /** null = accepted; otherwise the status the app answers. */
  private checkOffchain(message: Buffer, key: SimKey): number | null {
    if (!message.subarray(0, 16).equals(DOMAIN) || message[16] !== 0) return 0x6a81;
    let at = 17;
    let format: number;
    const signers: Buffer[] = [];
    if (this.options.legacyOffchain) {
      format = message[at++];
    } else {
      at += 32; // application domain
      format = message[at++];
      const count = message[at++];
      for (let i = 0; i < count; i++, at += 32) signers.push(message.subarray(at, at + 32));
      if (count === 0) return 0x6a81;
    }
    if (at + 2 > message.length) return 0x6a81;
    const length = message.readUInt16LE(at);
    const body = message.subarray(at + 2);
    if (length === 0 || length !== body.length || format > 1) return 0x6a81;
    if (!this.options.legacyOffchain && !signers.some((signer) => signer.equals(Buffer.from(key.publicKey)))) return 0x6a81;
    const ascii = body.every((byte) => (byte >= 0x20 && byte <= 0x7e) || byte === 0x0a);
    if (!ascii && format === 0) return 0x6a82;
    if (!ascii && this.options.blindSigningEnabled === false) return 0x6808;
    return null;
  }
}

type InputReportListener = (event: { data: DataView; device: FakeHidLedger }) => void;

/**
 * A WebHID `HIDDevice` in front of the simulated app: Ledger's USB HID
 * framing (64-byte reports: channel u16, tag 0x05, sequence u16, then — in
 * the first report — the APDU length u16), as @ledgerhq/hw-transport-webhid
 * frames and parses it. Lets the tests run the real WebHID transport.
 */
export class FakeHidLedger {
  readonly vendorId = 0x2c97;
  readonly productId = 0x5011;
  readonly productName = "Simulated Ledger";
  opened = false;
  reports = 0;
  private listeners = new Set<InputReportListener>();
  private incoming: { channel: number; length: number; data: number[] } | null = null;

  constructor(readonly app: SolanaAppSim) {}

  async open() { this.opened = true; }
  async close() { this.opened = false; }
  addEventListener(type: string, listener: InputReportListener) {
    if (type === "inputreport") this.listeners.add(listener);
  }
  removeEventListener(type: string, listener: InputReportListener) {
    this.listeners.delete(listener);
  }

  async sendReport(_reportId: number, report: Uint8Array) {
    if (!this.opened) throw Object.assign(new Error("The device must be opened first."), { name: "InvalidStateError" });
    this.reports += 1;
    const channel = (report[0] << 8) | report[1];
    const sequence = (report[3] << 8) | report[4];
    let payload = Array.from(report.subarray(5));
    if (sequence === 0) {
      this.incoming = { channel, length: (payload[0] << 8) | payload[1], data: [] };
      payload = payload.slice(2);
    }
    const incoming = this.incoming!;
    incoming.data.push(...payload);
    if (incoming.data.length < incoming.length) return;
    this.incoming = null;
    const response = await this.app.answer(Uint8Array.from(incoming.data.slice(0, incoming.length)));
    const framed = [response.length >> 8, response.length & 0xff, ...response];
    for (let at = 0, seq = 0; at < framed.length; at += 59, seq++) {
      const frame = new Uint8Array(64);
      frame.set([incoming.channel >> 8, incoming.channel & 0xff, 0x05, seq >> 8, seq & 0xff]);
      frame.set(framed.slice(at, at + 59), 5);
      setTimeout(() => { for (const listener of [...this.listeners]) listener({ data: new DataView(frame.buffer), device: this }); }, 0);
    }
  }
}
