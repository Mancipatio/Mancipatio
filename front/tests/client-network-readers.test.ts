import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ filters: [] as Array<[string, string, unknown]>, updates: [] as string[], params: {} as Record<string, unknown>, rowNetwork: "mainnet", linkedWallet: "11111111111111111111111111111111" as string | null }));
vi.mock("@/lib/server/siws", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/siws")>();
  return { ...real, verifySigned: vi.fn(async () => ({ wallet: "11111111111111111111111111111111", params: state.params })) };
});
vi.mock("@/lib/server/admin-gate", () => ({ requireAdmin: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({
  from: (table: string) => {
    const filters: Record<string, unknown> = {};
    const row = table === "clients" ? { id: "10000000-0000-4000-8000-000000000001", network: state.rowNetwork, wallet: state.linkedWallet, kyc_status: "verified", onboarding_token: "tok", created_at: new Date().toISOString(), onboarding_token_expires_at: new Date(Date.now() + 86_400_000).toISOString() } :
      { id: 1, client_id: "10000000-0000-4000-8000-000000000001", storage_path: "clients/fixture/file.pdf", status: "pending" };
    const result = (single: boolean) => {
      const matches = Object.entries(filters).every(([key, value]) => row[key as keyof typeof row] === value);
      return { data: matches ? (single ? row : [row]) : (single ? null : []), error: null };
    };
    const builder = {
      select: () => builder,
      eq: (key: string, value: unknown) => { filters[key] = value; state.filters.push([table, key, value]); return builder; },
      order: () => builder, limit: () => builder,
      update: () => { state.updates.push(table); return builder; },
      maybeSingle: async () => result(true),
      then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result(false)).then(resolve),
    };
    return builder;
  },
}) }));
import { POST as detail } from "@/app/api/clients/admin-detail/route";
import { POST as lookup } from "@/app/api/clients/lookup/route";
import { POST as me } from "@/app/api/clients/me/route";
import { POST as docUrl } from "@/app/api/clients/doc-url/route";
import { POST as update } from "@/app/api/clients/update/route";
import { POST as review } from "@/app/api/clients/review-requirement/route";
import { POST as acceptTos } from "@/app/api/clients/accept-tos/route";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  state.filters.length = 0; state.updates.length = 0;
  state.rowNetwork = "mainnet"; state.linkedWallet = "11111111111111111111111111111111";
  state.params = { id: "10000000-0000-4000-8000-000000000001", wallet: "11111111111111111111111111111111", document_id: 1, display_name: "Fixture" };
});
afterEach(() => vi.unstubAllEnvs());
const request = () => new Request("https://mancipatio.test/api/client", { method: "POST" });

describe("existing client routes enforce the active network", () => {
  it("does not expose admin detail, documents or mutate identity from another network", async () => {
    expect((await detail(request())).status).toBe(404);
    expect((await docUrl(request())).status).toBe(404);
    expect((await update(request())).status).toBe(404);
    expect(state.filters).toContainEqual(["clients", "network", "devnet"]);
    expect(state.updates).toEqual([]);
  });
  it("does not return another-network dossier through wallet lookup or self-read", async () => {
    expect((await (await lookup(request())).json()).data.client).toBeNull();
    expect((await (await me(request())).json()).data.client).toBeNull();
    expect(state.filters.filter(([table, key]) => table === "clients" && key === "network")).toHaveLength(2);
  });
  it("does not let an invitation stamp Terms for an unrelated or unlinked wallet", async () => {
    state.rowNetwork = "devnet";
    const input = { client_id: "10000000-0000-4000-8000-000000000001", token: "tok", wallet: "22222222222222222222222222222222" };
    const req = () => new Request("https://mancipatio.test/api/clients/accept-tos", { method: "POST", body: JSON.stringify(input) });
    expect((await acceptTos(req())).status).toBe(401);
    state.linkedWallet = null;
    expect((await acceptTos(req())).status).toBe(401);
    expect(state.updates).toEqual([]);
  });
  it("checks the parent dossier before reviewing a requirement", async () => {
    state.params = { id: 1, status: "approved" };
    expect((await review(request())).status).toBe(404);
    expect(state.updates).toEqual([]);
  });
});
