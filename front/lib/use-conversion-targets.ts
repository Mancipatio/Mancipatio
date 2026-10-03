"use client";

// The conversion targets among loaded share classes (lib/conversion-target),
// as a React hook: an empty set until derived, then the classKey of every
// marker class a sibling converts into.
import { useEffect, useMemo, useState } from "react";
import type { ShareClass } from "@/lib/generated/asset_registry";
import { classKey, conversionTargetKeys, hasMarkerShape } from "@/lib/conversion-target";

const EMPTY: ReadonlySet<string> = new Set();

export function useConversionTargets(classes: readonly ShareClass[] | null | undefined): ReadonlySet<string> {
  // Re-derived only when a candidate or a conversion link changes (classes is a fresh array per load).
  const key = useMemo(() => {
    if (!classes) return "";
    const candidates = classes.filter(hasMarkerShape).map(classKey);
    if (candidates.length === 0) return "";
    const links = classes.filter((c) => c.convertibleTo.__option === "Some").map((c) => `${classKey(c)}>${c.convertibleTo.__option === "Some" ? c.convertibleTo.value : ""}`);
    return `${candidates.join(",")}|${links.join(",")}`;
  }, [classes]);
  const [targets, setTargets] = useState<{ key: string; set: ReadonlySet<string> }>({ key: "", set: EMPTY });

  useEffect(() => {
    if (!key || !classes) return;
    let cancelled = false;
    void conversionTargetKeys(classes)
      .then((set) => {
        if (!cancelled) setTargets({ key, set });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // `key` captures every input that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return key && targets.key === key ? targets.set : EMPTY;
}
