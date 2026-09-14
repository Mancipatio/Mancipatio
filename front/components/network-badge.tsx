import { detectNetwork, networkColors, networkLabel } from "@/lib/network";

export function NetworkBadge() {
  const network = detectNetwork();
  const colors = networkColors(network);
  const showDot = network !== "mainnet";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${colors.bg} ${colors.text} ${colors.border}`}
      title={`Connected to Solana ${networkLabel(network)}`}
    >
      {showDot && (
        <span
          className={`inline-block h-1.5 w-1.5 animate-pulse rounded-full ${
            network === "devnet"
              ? "bg-orange-500"
              : network === "testnet"
                ? "bg-amber-500"
                : "bg-slate-500"
          }`}
        />
      )}
      {networkLabel(network)}
    </span>
  );
}
