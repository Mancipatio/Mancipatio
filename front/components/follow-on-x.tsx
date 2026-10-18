import { IconX } from "@/components/icons";

/** Manci's X account: linked from the top of every page, the sidebar and the footer. */
export const MANCI_X_URL = "https://x.com/Manci_rwa";

/** `compact` drops the label (the phone top bar); the link keeps an accessible name. */
export function FollowOnX({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <a href={MANCI_X_URL} target="_blank" rel="noopener noreferrer" className={className}
      aria-label={compact ? "Follow Manci on X" : undefined} title="Follow Manci on X">
      <IconX size={compact ? 15 : 14} />{!compact && <span>Follow @Manci_rwa</span>}
    </a>
  );
}
