"use client";

import { usePauseFlags } from "@/lib/use-pause-flags";
import { moduleEnabled } from "@/lib/features";
import { detectNetwork } from "@/lib/network";
import { combinedRuntimePauseNotice, runtimePauseFlows, type RuntimePauseFlow } from "@/lib/runtime-pause-notice";

/** Informational only: leaves existing positions and their exits visible. */
export function RuntimePauseNotice({ path }: { path: string }) {
  const network = detectNetwork();
  const flows = runtimePauseFlows(path).filter((flow) => flow === "primary" ||
    moduleEnabled(flow === "secondary" ? "secondaryTrading" : "custodyConversion", network));
  if (flows.length === 0) return null;
  return <FlowPauseNotice flows={flows} />;
}

function FlowPauseNotice({ flows }: { flows: RuntimePauseFlow[] }) {
  const flags = usePauseFlags();
  const notice = combinedRuntimePauseNotice(flows, flags);
  if (!notice) return null;
  const tone = notice.tone === "paused"
    ? "border-amber-300 bg-amber-50 text-amber-900"
    : "border-slate-200 bg-slate-50 text-slate-700";
  return (
    <div role="status" data-runtime-pause-notice={notice.tone} className={`mb-4 rounded-lg border px-4 py-3 text-sm ${tone}`}>
      <p className="font-semibold">{notice.title}</p>
      <p className="mt-1">{notice.description}</p>
      {notice.exits && <p className="mt-1">{notice.exits}</p>}
    </div>
  );
}
