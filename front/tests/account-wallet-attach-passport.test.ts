// Sim gap G5, the email/Google path: a founder who verified from
// /verify?next=/apply with an email account has a dossier with the officer
// role (api/verification/submit keeps the purpose as the role). When that
// account adds a wallet to sign the sale, /api/account/wallets/attach must
// not file a passport request nobody asked for; an investor's dossier still
// gets one.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { memorySupabase } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));
const ACCOUNT = "10000000-0000-4000-8000-000000000001";
const WALLET = "7xGLjBL7VWYNmBZxmPBv9YJSQd8FywuRyAnGoC9mhjjs";
const db = vi.hoisted(() => ({ ref: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase> }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => db.ref!.client }));
vi.mock("@/lib/server/bounded-request", () => ({ boundedRequest: async (r: Request) => r }));
vi.mock("@/lib/server/account-auth", () => ({ readAccountSession: () => ({ a: "10000000-0000-4000-8000-000000000001" }) }));
vi.mock("@/lib/server/account-wallets", () => ({ attachAccountWallet: vi.fn(async () => {}) }));
vi.mock("@/lib/server/account-profile", () => ({
  accountResponse: vi.fn(async () => NextResponse.json({ ok: true })),
  accountErrorResponse: (err: unknown) => NextResponse.json({ ok: false, error: String(err) }, { status: 500 }),
}));
vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async () => ({
    wallet: "7xGLjBL7VWYNmBZxmPBv9YJSQd8FywuRyAnGoC9mhjjs",
    params: { account_id: "10000000-0000-4000-8000-000000000001" },
  })),
}));

import { POST as attach } from "@/app/api/account/wallets/attach/route";

const call = async () => (await attach(new Request("https://manci.test/api/account/wallets/attach", { method: "POST", body: "{}" }))).status;
const dossier = (types: string[], kyc_status = "verified") =>
  db.ref!.rows("clients").push({ id: "c1", account_id: ACCOUNT, network: "devnet", jurisdiction: "688", kyc_status, type: types[0], types });

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  db.ref = memorySupabase();
});

describe("/api/account/wallets/attach and the passport queue", () => {
  it("a founder's KYC dossier (officer role) files no passport request for the added wallet", async () => {
    dossier(["officer"]);
    expect(await call()).toBe(200);
    expect(db.ref!.rows("passport_requests")).toEqual([]);
  });

  it("an investor's dossier still does, also when the investor is a founder too", async () => {
    dossier(["officer", "investor"]);
    expect(await call()).toBe(200);
    expect(db.ref!.rows("passport_requests")).toMatchObject([{ wallet: WALLET, jurisdiction: 688 }]);
  });
});
