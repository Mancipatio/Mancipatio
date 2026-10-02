// The whole "Ledger (USB)" stack below the browser, with nothing of Ledger's
// mocked: lib/ledger-usb-webhid.ts opens the real @ledgerhq/hw-transport-webhid
// 6.36.0 (USB HID framing) on a WebHID device whose other end is the APDU
// simulation of the Solana app (tests/helpers/ledger-solana-sim.ts), the real
// @ledgerhq/hw-app-solana 7.11.0 builds the APDUs, and the wallet is used
// through @solana/client's connector. What comes out is checked by the real
// SIWS server verifier and by ed25519 verification.
import { createWalletStandardConnector, createWalletTransactionSigner } from "@solana/client";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  createTransactionMessage,
  getBase58Decoder,
  getPublicKeyFromAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  verifySignature,
  type Address,
  type Blockhash,
} from "@solana/kit";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLedgerUsbWallet, LEDGER_DERIVATION_PATHS, LEDGER_USB_CONNECTOR_ID, type LedgerUsbPrompts } from "@/lib/ledger-usb";
import { openWebHidLedger } from "@/lib/ledger-usb-webhid";
import { createSignedRequest } from "@/lib/siws-client";
import { FakeHidLedger, SolanaAppSim, simKeys, type SimKey } from "./helpers/ledger-solana-sim";

vi.mock("server-only", () => ({}));
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ rpc }) }));
import { verifySigned } from "@/lib/server/siws";

const origin = "https://manci.test";
const PATH = "44'/501'/0'/0'";
let keys: Map<string, SimKey>;
const store = new Map<string, string>();

beforeAll(async () => { keys = await simKeys(LEDGER_DERIVATION_PATHS); });
beforeEach(() => {
  store.clear();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubGlobal("window", {
    location: { origin },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
  });
  rpc.mockReset().mockResolvedValue({ data: true, error: null });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Ledger (USB) over the real WebHID transport", () => {
  it("connects, signs a SIWS request the server accepts and a transaction that verifies", async () => {
    const app = new SolanaAppSim(keys);
    const hid = new FakeHidLedger(app);
    let permitted = false;
    const requestDevice = vi.fn(async () => { permitted = true; return [hid]; });
    vi.stubGlobal("navigator", {
      hid: { getDevices: async () => (permitted ? [hid] : []), requestDevice, addEventListener: () => undefined, removeEventListener: () => undefined },
    });
    const prompts: LedgerUsbPrompts = {
      chooseAccount: async (request) => request.accounts.find((option) => option.path === PATH)!,
      requestAccess: async (grant) => grant(),
      confirmOnDevice: () => () => undefined,
    };
    const wallet = createLedgerUsbWallet({ open: openWebHidLedger, prompts, storage: window.localStorage });
    const session = await createWalletStandardConnector(wallet, { id: LEDGER_USB_CONNECTOR_ID, defaultChain: "solana:devnet" }).connect();
    const signer = keys.get(PATH)!.address as Address;
    expect(session.account.address).toBe(signer);
    expect(requestDevice).toHaveBeenCalledOnce(); // the chooser once; later opens use the permission
    expect(hid.opened).toBe(false); // closed after the connect

    const reportsBefore = hid.reports;
    const body = await createSignedRequest(session, "test.write", { display_name: "Đorđe Rakić", note: "x".repeat(300) });
    expect(body.sigFormat).toBe("offchain-v0");
    await expect(verifySigned(new Request(`${origin}/api/x`, {
      method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify(body),
    }), "test.write")).resolves.toMatchObject({ wallet: signer });
    // Several APDUs (255-byte chunks), each over several 64-byte HID reports.
    expect(app.apdus.filter((a) => a.ins === 0x07).length).toBeGreaterThan(2);
    expect(hid.reports - reportsBefore).toBeGreaterThan(app.apdus.filter((a) => a.ins === 0x07).length);

    const { signer: walletSigner } = createWalletTransactionSigner(session);
    const signed = await signTransactionMessageWithSigners(pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(walletSigner, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(9)) as Blockhash, lastValidBlockHeight: BigInt(1) }, m),
      (m) => appendTransactionMessageInstruction({
        programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
        accounts: [{ address: walletSigner.address, role: AccountRole.READONLY_SIGNER, signer: walletSigner }],
        data: new TextEncoder().encode("manci"),
      }, m),
    ));
    await expect(verifySignature(await getPublicKeyFromAddress(signer), signed.signatures[signer]!, signed.messageBytes)).resolves.toBe(true);
    expect(app.signed.map((s) => [s.ins, s.path])).toEqual([[0x07, PATH], [0x06, PATH]]);
  });
});
