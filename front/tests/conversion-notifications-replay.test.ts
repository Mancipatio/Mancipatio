// The conversion emails through the REAL recording code: the deposited and
// reclaim routes over lib/server/custody-evidence.ts (whose replay branch
// answers a receipt recorded before with the caller's own id, no write) and
// the real create route. A replay sends nothing new, also when it spells the
// request id differently (PostgreSQL reads every spelling as the same uuid,
// and the claim's key is the canonical one); a new request emails the holder
// and the operator after the response.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendEmailInput, SendEmailResult } from "@/lib/server/email";
import { memorySupabase, type Row } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));
const db = vi.hoisted(() => ({ ref: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase> }));
vi.mock("@/lib/supabase-server", () => {
  // A uuid column compares values, not spellings: the stand-in reads an `id`
  // filter the way PostgreSQL's uuid type does.
  const uuid = (value: unknown) => {
    if (typeof value !== "string") return value;
    const hex = value.replace(/^\{(.*)\}$/, "$1").replace(/-/g, "").toLowerCase();
    return /^[0-9a-f]{32}$/.test(hex)
      ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      : value;
  };
  return {
    getSupabaseAdmin: () => ({
      from: (table: string) => {
        const builder = db.ref!.client.from(table) as Record<string, (...args: unknown[]) => unknown>;
        const eq = builder.eq;
        builder.eq = (column: unknown, value: unknown) => eq(column, column === "id" ? uuid(value) : value);
        return builder;
      },
      rpc: (name: string, args?: Record<string, unknown>) => db.ref!.client.rpc(name, args),
    }),
  };
});
const mail = vi.hoisted(() => ({
  sendEmail: vi.fn<(input: SendEmailInput) => Promise<SendEmailResult>>(async () => ({ sent: true, id: "msg-1" })),
}));
vi.mock("@/lib/server/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/email")>()),
  sendEmail: mail.sendEmail,
  emailConfigured: () => true,
}));
const later = vi.hoisted(() => ({ tasks: [] as Array<() => unknown> }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn((task: () => unknown) => { later.tasks.push(task); }),
}));
const signer = vi.hoisted(() => ({ wallet: "", params: {} as Record<string, unknown> }));
vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async () => ({ wallet: signer.wallet, params: signer.params, via: "signature" })),
}));
vi.mock("@/lib/server/token-holdings", () => ({
  getToken2022Balance: vi.fn(async () => BigInt(1_000)),
  resolveShareClassAssetFacts: vi.fn(async () => ({
    assetPda: "3n1mQ6zsrVpQyzFCkr9qFVGgU3qHiHQeAvGtaVJk9oNr",
    assetLabel: "Mancipatio d.o.o. · #0 · MANCI-2026",
    convertibleTo: "4KcVAsHCdcCPpDxYPHV7ZLcTU1sfKZBLZTz3H1B5mMhx",
    assetTypeDeliverable: false,
  })),
}));

import { clearSanctionsCache } from "@/lib/server/sanctions";
import { POST as create } from "@/app/api/conversion/create/route";
import { POST as deposited } from "@/app/api/conversion/deposited/route";
import { POST as reclaim } from "@/app/api/conversion/reclaim/route";

const HOLDER = "DAWSeqUCPJRJ3CFSm8hfwrsu1LdhrvEQGv9K2864pMpp";
const REQUEST = "6f9619ff-8b86-4d11-b42d-00c04fc964ff";
const SPELLINGS = [REQUEST, REQUEST.toUpperCase(), REQUEST.replace(/-/g, ""), `{${REQUEST}}`, "6f9619ff-8b86-4d11-b42d00c0-4fc964ff"];
const TX = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const SHARE_CLASS = "3n1mQ6zsrVpQyzFCkr9qFVGgU3qHiHQeAvGtaVJk9oNr";
const MINT = "4KcVAsHCdcCPpDxYPHV7ZLcTU1sfKZBLZTz3H1B5mMhx";

const rows = (table: string): Row[] => db.ref!.rows(table);
const subjects = () => mail.sendEmail.mock.calls.map(([input]) => input.subject).sort();

async function post(handler: (r: Request) => Promise<Response>, params: Record<string, unknown>) {
  signer.wallet = HOLDER;
  signer.params = params;
  const res = await handler(new Request("https://manci.test/api/x", { method: "POST", body: "{}" }));
  return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string } };
}
async function runLater() {
  for (const task of later.tasks.splice(0)) await task();
}

beforeEach(() => {
  db.ref = memorySupabase();
  later.tasks.length = 0;
  mail.sendEmail.mockClear();
  clearSanctionsCache();
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://devnet.manci.io");
  vi.stubEnv("COMPLIANCE_ALERT_EMAIL", "office@example.org");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  // claim_notification / finish_notification with the 0088 semantics.
  let seq = 0;
  db.ref.rpcs.claim_notification = (args) => {
    if (rows("notification_log").some((r) => r.ref_id === args.p_ref_id && r.event === args.p_event && r.recipient_role === args.p_recipient_role)) return null;
    rows("notification_log").push({ id: ++seq, ref_id: args.p_ref_id, event: args.p_event, recipient_role: args.p_recipient_role, status: "pending" });
    return seq;
  };
  db.ref.rpcs.finish_notification = (args) => {
    const row = rows("notification_log").find((r) => r.id === args.p_id && r.status === "pending");
    if (row) row.status = args.p_status;
    return Boolean(row);
  };
  rows("clients").push({
    id: "2a4f1c3e-7d6b-4a8e-9c0d-5e6f7a8b9c0d", wallet: HOLDER, network: "devnet", kyc_status: "verified",
    kyc_expires_at: "2099-01-01T00:00:00.000Z", created_at: "2026-09-01T00:00:00.000Z", email: "dossier@example.org",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("replayed recordings never email twice", () => {
  it("deposited: every spelling of the id replays the recorded receipt, and the emails go out once", async () => {
    rows("conversion_requests").push({
      id: REQUEST, network: "devnet", holder_wallet: HOLDER, client_id: "2a4f1c3e-7d6b-4a8e-9c0d-5e6f7a8b9c0d", contact: "",
      asset_label: "Mancipatio d.o.o. · #0 · MANCI-2026", amount: 250, status: "deposited", vault_pda: null,
      deposit_tx: TX, deposit_evidence: { signature: TX }, outcome_tx: null,
    });
    for (const id of SPELLINGS) {
      expect(await post(deposited, { id, deposit_tx: TX }), id).toMatchObject({ status: 200, body: { ok: true } });
      await runLater();
    }
    expect(subjects()).toEqual(["Manci: your units are in escrow", "[Manci devnet] Units deposited for conversion 6f9619ff"]);
    expect(rows("notification_log").map((r) => `${r.ref_id}|${r.event}|${r.recipient_role}|${r.status}`).sort()).toEqual([
      `${REQUEST}|deposited|holder|sent`,
      `${REQUEST}|deposited|operator|sent`,
    ]);
  });

  it("reclaim: a replayed return emails the holder once", async () => {
    rows("conversion_requests").push({
      id: REQUEST, network: "devnet", holder_wallet: HOLDER, client_id: "2a4f1c3e-7d6b-4a8e-9c0d-5e6f7a8b9c0d", contact: "",
      asset_label: "Mancipatio d.o.o. · #0 · MANCI-2026", amount: 250, status: "returned", vault_pda: null,
      deposit_tx: null, outcome_tx: TX, outcome_evidence: { signature: TX },
    });
    for (const id of SPELLINGS) {
      expect((await post(reclaim, { id, outcome_tx: TX })).status, id).toBe(200);
      await runLater();
    }
    expect(subjects()).toEqual(["Manci: your escrowed units were returned"]);
  });
});

describe("a new request", () => {
  it("is answered first, then emails the holder and the operator once", async () => {
    db.ref!.defaults.conversion_requests = () => ({ id: REQUEST, status: "requested", created_at: "2026-11-08T10:00:00.000Z" });
    const res = await post(create, { share_class_pda: SHARE_CLASS, mint: MINT, amount: 10, contact: "+381 64 1234567" });
    expect(res).toMatchObject({ status: 200, body: { ok: true } });
    expect(rows("conversion_requests")).toHaveLength(1);
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(later.tasks).toHaveLength(1);
    await runLater();
    expect(subjects()).toEqual(["Manci: we received your conversion request", "[Manci devnet] New conversion request 6f9619ff"]);
    const holder = mail.sendEmail.mock.calls.map(([input]) => input).find((input) => input.to === "dossier@example.org");
    expect(holder?.html).toContain("10 units of Mancipatio d.o.o.");
    expect(holder?.html).not.toContain("+381");
  });
});
