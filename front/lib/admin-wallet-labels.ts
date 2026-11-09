// Operator names of platform wallets (0092, /admin/admins): who holds each
// Admin key. A name grants nothing; every role is read from the chain.
//
// Pure and shared by the browser wrappers below, the server routes
// (app/api/admin/wallet-labels) and the tests.
import { signedFetch, type SignedFetchInteractive } from "@/lib/siws-client";

type WalletSession = Parameters<typeof signedFetch>[0];

/** The longest name, in characters (the 0092 check says the same). */
export const WALLET_LABEL_MAX = 80;
/** The most wallets one read may ask about. */
export const WALLET_LABELS_READ_MAX = 200;

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Unicode C0/C1 control characters (0092: label !~ '[[:cntrl:]]').
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function isWalletAddress(value: unknown): value is string {
  return typeof value === "string" && BASE58_ADDRESS.test(value);
}

/**
 * A name as stored: whitespace runs collapsed to one space and trimmed. ""
 * means "no name" (the route deletes the row). Throws on a name that is too
 * long or holds a control character.
 */
export function normalizeWalletLabel(raw: string): string {
  if (CONTROL.test(raw.replace(/[\t\n\r]/g, " "))) throw new Error("A name cannot contain control characters");
  const label = raw.replace(/\s+/g, " ").trim();
  if ([...label].length > WALLET_LABEL_MAX) throw new Error(`A name has at most ${WALLET_LABEL_MAX} characters`);
  return label;
}

export type WalletLabel = { label: string; setBy: string; updatedAt: string };
export type WalletAccount = { displayName: string; email: string | null };

export type WalletLabels = {
  /** False while 0092 is not applied on this network: no names, nothing to write. */
  available: boolean;
  labels: Record<string, WalletLabel>;
  /** The Manci account each wallet belongs to, when it is linked to one. */
  accounts: Record<string, WalletAccount>;
};

/** The names and linked accounts of `wallets` (any Admin, over its wallet session). */
export function readWalletLabels(
  session: WalletSession,
  wallets: readonly string[],
  opts: { interactive?: SignedFetchInteractive } = {},
): Promise<WalletLabels> {
  return signedFetch<WalletLabels>(session, "/api/admin/wallet-labels", "admin.walletLabels", { wallets: [...wallets] }, opts);
}

/** Sets (or, with "", removes) the name of `wallet`. Super Admin only, one wallet signature. */
export function setWalletLabel(session: WalletSession, wallet: string, label: string): Promise<{ label: string | null }> {
  return signedFetch(session, "/api/admin/wallet-labels/set", "admin.walletLabelSet", { wallet, label: normalizeWalletLabel(label) });
}
