import { IconX } from "@/components/icons";
import { MANCI_X_HANDLE, MANCI_X_URL } from "@/lib/social";

/** Manci's X account (lib/social.ts): linked from the top of every page, the sidebar and the footer. */
export { MANCI_X_URL };

/** `compact` drops the label (the phone top bar); the link keeps an accessible name. */
export function FollowOnX({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <a href={MANCI_X_URL} target="_blank" rel="noopener noreferrer" className={className}
      aria-label={compact ? "Follow Manci on X" : undefined} title="Follow Manci on X">
      <IconX size={compact ? 15 : 14} />{!compact && <span>Follow {MANCI_X_HANDLE}</span>}
    </a>
  );
}
