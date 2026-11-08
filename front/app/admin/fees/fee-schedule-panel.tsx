"use client";

// /admin/fees — the public fee schedule and the charges booked against it
// (migration 0089). One session read loads both (fees.scheduleList); every
// write signs afresh and reloads. The schedule section prepares drafts and
// (Super Admin) publishes or retires them; the charges section books a
// charge from a conversion request or an application and records its
// invoice, payment or waiver. Nothing here moves tokens or money.

import { useCallback, useEffect, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import type { ClientRow } from "@/lib/clients";
import { listFeeSchedule } from "@/lib/fees/client";
import type { FeeChargeRow, FeeScheduleRow } from "@/lib/fees/schedule";
import { FeeScheduleSection } from "./fee-schedule-section";
import { FeeChargesSection } from "./fee-charges-section";

export type FeeAdminData = { schedule: FeeScheduleRow[]; charges: FeeChargeRow[] };

export function FeeSchedulePanel({ clients }: { clients: ClientRow[] | null }) {
  const conn = useWalletConnection();
  const [data, setData] = useState<FeeAdminData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!conn.wallet) return;
    try {
      setData(await listFeeSchedule(conn.wallet));
      setError(null);
    } catch (err) {
      // A failed read is shown as such, never as an empty schedule.
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  return (
    <>
      <FeeScheduleSection schedule={data?.schedule ?? null} error={error} onChanged={refresh} />
      <FeeChargesSection
        schedule={data?.schedule ?? null}
        charges={data?.charges ?? null}
        clients={clients}
        error={error}
        onChanged={refresh}
      />
    </>
  );
}
