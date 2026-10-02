// The "Ledger (USB)" connector for app/providers.tsx: offered only in a
// browser with WebHID and while lib/features.ts ledgerUsbWalletEnabled is on.
// A Wallet Standard wallet (lib/ledger-usb.ts) wrapped by @solana/client's own
// connector, so its sessions behave like every discovered wallet's (and are
// guarded the same way, lib/guarded-wallet-connectors.ts).

import { createWalletStandardConnector, type WalletConnector } from "@solana/client";
import { ledgerUsbWalletEnabled } from "@/lib/features";
import { createLedgerUsbWallet, LEDGER_USB_CONNECTOR_ID, type LedgerUsbStorage } from "@/lib/ledger-usb";
import { ledgerUsbPrompts } from "@/lib/ledger-usb-prompts";
import { hasWebHid, openWebHidLedger } from "@/lib/ledger-usb-webhid";
import type { Network } from "@/lib/network";
import { walletChain } from "@/lib/wallet-chain";

function browserStorage(): LedgerUsbStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null; // storage blocked
  }
}

export function ledgerUsbConnectors(network: Network): readonly WalletConnector[] {
  if (!ledgerUsbWalletEnabled() || !hasWebHid()) return [];
  const wallet = createLedgerUsbWallet({ open: openWebHidLedger, prompts: ledgerUsbPrompts, storage: browserStorage() });
  return [createWalletStandardConnector(wallet, { id: LEDGER_USB_CONNECTOR_ID, defaultChain: walletChain(network) })];
}
