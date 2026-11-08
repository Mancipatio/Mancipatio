// Conversion emails (lib/server/conversion-notifications.ts over the generic
// lib/server/notifications.ts): at most once per request, event and
// recipient (the 0088 claim, modelled here by rpc handlers with the SQL
// functions' semantics; the SQL itself is tests/notification-log.postgres.test.ts),
// failures recorded and swallowed, the holder's address resolved from what
// the platform verified and nothing else of the dossier ever read or sent,
// and the routes writing the status first and emailing only after the
// response (next/server after(), captured here).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendEmailInput, SendEmailResult } from "@/lib/server/email";
import { memorySupabase, type Row } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));
const db = vi.hoisted(() => ({ ref: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase>, selects: [] as string[] }));
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    // Records every column list a select asks for (the privacy assertions).
    from: (table: string) => {
      const builder = db.ref!.client.from(table) as Record<string, (...args: unknown[]) => unknown>;
      const select = builder.select;
      builder.select = (cols?: unknown, opts?: unknown) => {
        db.selects.push(`${table}:${String(cols ?? "*")}`);
        return select(cols, opts);
      };
      return builder;
    },
    rpc: (name: string, args?: Record<string, unknown>) => db.ref!.client.rpc(name, args),
  }),
}));
const mail = vi.hoisted(() => ({
  sendEmail: vi.fn<(input: SendEmailInput) => Promise<SendEmailResult>>(async () => ({ sent: true, id: "msg-1" })),
  emailConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/server/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/email")>()),
  sendEmail: mail.sendEmail,
  emailConfigured: mail.emailConfigured,
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
vi.mock("@/lib/server/admin-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/admin-gate")>()),
  requireAdmin: vi.fn(async () => {}),
}));
const custody = vi.hoisted(() => ({
  validateCustodyUpdate: vi.fn<(table: string, id: string, patch: Record<string, unknown>) => Promise<string>>(async () => "deposited"),
  recordCustodyDeposit: vi.fn(async (_t: string, id: string) => ({ id, status: "deposited" })),
  recordCustodyReturn: vi.fn(async (_t: string, id: string) => ({ id, status: "returned" })),
}));
vi.mock("@/lib/server/custody-evidence", () => custody);

import { CONVERSION_TYPICAL_DURATIONS } from "@/lib/conversion-timeline";
import {
  CONVERSION_EVENTS,
  conversionHolderMessage,
  conversionOperatorMessage,
  sendConversionNotifications,
  type ConversionEvent,
} from "@/lib/server/conversion-notifications";
import {
  NOTIFICATION_SEND_TIMEOUT_MS,
  isSingleEmailAddress,
  notifyOperator,
  sendFailureClass,
} from "@/lib/server/notifications";
import { SiwsError } from "@/lib/server/siws";
import { POST as adminUpdate } from "@/app/api/conversion/admin-update/route";
import { POST as cancel } from "@/app/api/conversion/cancel/route";
import { POST as deposited } from "@/app/api/conversion/deposited/route";
import { POST as reclaim } from "@/app/api/conversion/reclaim/route";

const HOLDER = "DAWSeqUCPJRJ3CFSm8hfwrsu1LdhrvEQGv9K2864pMpp";
const ADMIN = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const REQUEST = "6f9619ff-8b86-4d11-b42d-00c04fc964ff";
const ACCOUNT = "0b6e0c61-6b8e-4e43-9f0e-1b3c1f5d2a10";
const CLIENT = "2a4f1c3e-7d6b-4a8e-9c0d-5e6f7a8b9c0d";
const TX = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
// What must never appear in an email: the dossier's personal data, the
// verdict, the wallet, the holder's contact and note, the admin's note.
const SECRETS = ["Jane Q. Public", "Secret Holding d.o.o.", "PROVIDER-REF-778", "1985-04-12", "+381 64 1234567",
  "my passport number is P123", "KYC expired", HOLDER, "verified", "dossier@example.org"];

function rows(table: string): Row[] { return db.ref!.rows(table); }

/** claim_notification / finish_notification with the 0088 semantics (key unique, one outcome). */
function installLog() {
  let seq = 0;
  db.ref!.rpcs.claim_notification = (args) => {
    const taken = rows("notification_log").some((r) =>
      r.kind === args.p_kind && r.ref_id === args.p_ref_id && r.event === args.p_event && r.recipient_role === args.p_recipient_role);
    if (taken) return null;
    const id = ++seq;
    rows("notification_log").push({
      id, network: "devnet", kind: args.p_kind, ref_id: args.p_ref_id, event: args.p_event,
      recipient_role: args.p_recipient_role, status: "pending", error: null, recipient_source: null,
    });
    return id;
  };
  db.ref!.rpcs.finish_notification = (args) => {
    const row = rows("notification_log").find((r) => r.id === args.p_id);
    if (!row || row.status !== "pending") return false;
    Object.assign(row, { status: args.p_status, error: args.p_error, recipient_source: args.p_recipient_source });
    return true;
  };
}

function seedRequest(over: Row = {}) {
  rows("conversion_requests").push({
    id: REQUEST, network: "devnet", holder_wallet: HOLDER, client_id: CLIENT, contact: "+381 64 1234567",
    note: "my passport number is P123", asset_label: "Mancipatio d.o.o. · #0 · MANCI-2026", amount: 250,
    status: "requested", vault_pda: null, admin_note: "KYC expired", deposit_tx: null, outcome_tx: null, ...over,
  });
}
function seedDossier(email: string | null = "dossier@example.org") {
  rows("clients").push({
    id: CLIENT, network: "devnet", wallet: HOLDER, email, display_name: "Jane Q. Public", company_name: "Secret Holding d.o.o.",
    jurisdiction: "688", kyc_status: "verified", kyc_provider_ref: "PROVIDER-REF-778", date_of_birth: "1985-04-12",
  });
}
function seedAccount(email: string | null, verified: boolean, network = "devnet") {
  rows("account_wallets").push({ network, wallet: HOLDER, account_id: ACCOUNT });
  rows("account_profiles").push({
    id: ACCOUNT, network, email, email_verified_at: verified ? "2026-10-01T00:00:00Z" : null, display_name: "Jane Q. Public",
  });
}
const sent = () => mail.sendEmail.mock.calls.map(([input]) => input);
const log = () => rows("notification_log").map((r) => `${r.event}|${r.recipient_role}|${r.status}|${r.error ?? "-"}|${r.recipient_source ?? "-"}`);

beforeEach(() => {
  db.ref = memorySupabase();
  db.selects.length = 0;
  later.tasks.length = 0;
  mail.sendEmail.mockReset();
  mail.sendEmail.mockResolvedValue({ sent: true, id: "msg-1" });
  mail.emailConfigured.mockReset();
  mail.emailConfigured.mockReturnValue(true);
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://devnet.manci.io");
  vi.stubEnv("COMPLIANCE_ALERT_EMAIL", "office@example.org");
  installLog();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("at most once, failures recorded and swallowed", () => {
  const operator = (event = "requested") =>
    notifyOperator({ kind: "conversion", refId: REQUEST, event, message: () => ({ subject: "S", html: "<p>H</p>" }) });

  it("sends once per key: a retry and a concurrent call find it claimed", async () => {
    const outcomes = await Promise.all([operator(), operator()]);
    outcomes.push(await operator());
    expect(outcomes.sort()).toEqual(["duplicate", "duplicate", "sent"]);
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    expect(sent()[0]).toMatchObject({ to: ["office@example.org"], redactErrors: true, timeoutMs: NOTIFICATION_SEND_TIMEOUT_MS });
    expect(log()).toEqual(["requested|operator|sent|-|config"]);
    // Another event of the same request is its own notification.
    expect(await operator("deposited")).toBe("sent");
  });

  it("sends nothing when the claim cannot be made (0088 not applied, database down)", async () => {
    delete db.ref!.rpcs.claim_notification;
    expect(await operator()).toBe("unavailable");
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it("bounds a claim that hangs and sends nothing", async () => {
    vi.useFakeTimers();
    db.ref!.rpcs.claim_notification = () => new Promise(() => {});
    const outcome = operator();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await outcome).toBe("unavailable");
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it("records a timed-out send as failed TIMEOUT and never retries it", async () => {
    mail.sendEmail.mockResolvedValueOnce({ sent: false, error: "TIMEOUT" });
    expect(await operator()).toBe("failed");
    expect(await operator()).toBe("duplicate");
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    expect(log()).toEqual(["requested|operator|failed|TIMEOUT|config"]);
  });

  it("records a throwing transport as TRANSPORT instead of throwing", async () => {
    mail.sendEmail.mockRejectedValueOnce(new Error("socket hang up for office@example.org"));
    await expect(operator()).resolves.toBe("failed");
    expect(log()).toEqual(["requested|operator|failed|TRANSPORT|config"]);
  });

  it("skips without a transport, without an operator mailbox and for a reserved domain", async () => {
    mail.emailConfigured.mockReturnValue(false);
    expect(await operator("requested")).toBe("skipped");
    expect(mail.sendEmail).not.toHaveBeenCalled();
    mail.emailConfigured.mockReturnValue(true);
    vi.stubEnv("COMPLIANCE_ALERT_EMAIL", "");
    expect(await operator("deposited")).toBe("skipped");
    vi.stubEnv("COMPLIANCE_ALERT_EMAIL", "office@example.org");
    mail.sendEmail.mockResolvedValueOnce({ sent: false, error: "Reserved recipient domain" });
    expect(await operator("converted")).toBe("skipped");
    expect(log()).toEqual([
      "requested|operator|skipped|NOT_CONFIGURED|config",
      "deposited|operator|skipped|NO_RECIPIENT|-",
      "converted|operator|skipped|RESERVED_DOMAIN|config",
    ]);
  });

  it("returns the outcome even when it cannot be recorded (the row stays pending: never resent)", async () => {
    db.ref!.rpcs.finish_notification = () => { throw new Error("connection reset"); };
    expect(await operator()).toBe("sent");
    expect(log()).toEqual(["requested|operator|pending|-|-"]);
    expect(await operator()).toBe("duplicate");
  });

  it("refuses a malformed key before claiming", async () => {
    expect(await notifyOperator({ kind: "conversion", refId: "holder@example.org", event: "requested", message: () => ({ subject: "", html: "" }) }))
      .toBe("unavailable");
    expect(await notifyOperator({ kind: "Conversion", refId: REQUEST, event: "requested", message: () => ({ subject: "", html: "" }) }))
      .toBe("unavailable");
    expect(rows("notification_log")).toEqual([]);
  });

  it("classifies provider failures without keeping their text", () => {
    expect(sendFailureClass({ sent: false, error: "TIMEOUT" })).toEqual({ status: "failed", error: "TIMEOUT" });
    expect(sendFailureClass({ sent: false, error: "HTTP 422" })).toEqual({ status: "failed", error: "REJECTED" });
    expect(sendFailureClass({ sent: false, error: "Delivery failed" })).toEqual({ status: "failed", error: "TRANSPORT" });
    expect(sendFailureClass({ sent: false, error: "EMAIL_FROM not configured" })).toEqual({ status: "skipped", error: "NOT_CONFIGURED" });
    expect(sendFailureClass({ sent: false, error: "Email transport not configured" })).toEqual({ status: "skipped", error: "NOT_CONFIGURED" });
    expect(sendFailureClass({ sent: false })).toEqual({ status: "failed", error: "TRANSPORT" });
  });
});

describe("the holder's address", () => {
  it("prefers the account's confirmed email, reading only email columns", async () => {
    seedRequest();
    seedDossier();
    seedAccount("account@example.org", true);
    expect(await sendConversionNotifications(REQUEST, "vault_opened")).toEqual({ holder: "sent", operator: null });
    expect(sent()[0].to).toBe("account@example.org");
    expect(log()).toEqual(["vault_opened|holder|sent|-|account"]);
    expect(db.selects.sort()).toEqual([
      "account_profiles:email, email_verified_at",
      "account_wallets:account_id",
      "conversion_requests:id, holder_wallet, client_id, contact, asset_label, amount, outcome_tx",
    ]);
  });

  it("takes the verified dossier's email when the account's is unconfirmed or absent", async () => {
    seedRequest();
    seedDossier();
    seedAccount("unconfirmed@example.org", false);
    await sendConversionNotifications(REQUEST, "vault_opened");
    expect(sent()[0].to).toBe("dossier@example.org");
    expect(log()).toEqual(["vault_opened|holder|sent|-|dossier"]);
    expect(db.selects).toContain("clients:email");
    expect(db.selects.some((s) => s.startsWith("clients:") && s !== "clients:email")).toBe(false);
  });

  it("ignores another network's account and dossier", async () => {
    seedRequest({ contact: "contact@example.org" });
    seedAccount("account@example.org", true, "mainnet");
    rows("clients").push({ id: CLIENT, network: "mainnet", email: "dossier@example.org" });
    await sendConversionNotifications(REQUEST, "vault_opened");
    expect(sent()[0].to).toBe("contact@example.org");
    expect(log()).toEqual(["vault_opened|holder|sent|-|contact"]);
  });

  it.each([
    ["+381 64 1234567"],
    ["a@example.org, b@example.org"],
    ["Jane <a@example.org>"],
    ["a@example.org\r\nBcc: b@example.org"],
    [""],
  ])("uses the contact only when it is one plain address (%j: none)", async (contact) => {
    seedRequest({ contact, client_id: null });
    expect((await sendConversionNotifications(REQUEST, "vault_opened")).holder).toBe("skipped");
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(log()).toEqual(["vault_opened|holder|skipped|NO_RECIPIENT|-"]);
  });

  it("accepts single plain addresses only", () => {
    expect(isSingleEmailAddress("holder.name+manci@mail.example.org")).toBe(true);
    for (const bad of ["a@b", "a b@example.org", "a@example.org,b@example.org", "<a@example.org>", `${"x".repeat(250)}@example.org`, 42, null]) {
      expect(isSingleEmailAddress(bad), String(bad)).toBe(false);
    }
  });

  it("records a lookup failure as RESOLVE_FAILED and sends nothing", async () => {
    seedRequest();
    db.ref!.failReads.add("account_wallets");
    expect((await sendConversionNotifications(REQUEST, "deposited")).holder).toBe("failed");
    expect(log()).toContain("deposited|holder|failed|RESOLVE_FAILED|-");
    expect(sent().every((input) => input.to !== "dossier@example.org")).toBe(true);
  });

  it("skips a request that no longer exists", async () => {
    expect(await sendConversionNotifications(REQUEST, "cancelled")).toEqual({ holder: "skipped", operator: null });
    expect(log()).toEqual(["cancelled|holder|skipped|NO_RECIPIENT|-"]);
  });
});

describe("what the emails say", () => {
  it.each(CONVERSION_EVENTS)("%s: no KYC data, wallet, contact, note or admin note, to anyone", async (event) => {
    seedRequest({ outcome_tx: TX });
    seedDossier();
    await sendConversionNotifications(REQUEST, event as ConversionEvent);
    expect(mail.sendEmail).toHaveBeenCalled();
    for (const input of sent()) {
      const text = `${input.subject}\n${input.html}`;
      for (const secret of SECRETS) expect(text, `${event} → ${secret}`).not.toContain(secret);
    }
    // The log keeps classes and kinds only.
    for (const row of rows("notification_log")) expect(JSON.stringify(row)).not.toMatch(/@|DAWSeq/);
  });

  it("emails the operator for a new request and a deposit only", async () => {
    seedRequest();
    seedDossier();
    for (const event of CONVERSION_EVENTS) await sendConversionNotifications(REQUEST, event);
    expect(log().filter((l) => l.includes("|operator|"))).toEqual([
      "requested|operator|sent|-|config",
      "deposited|operator|sent|-|config",
    ]);
    expect(log().filter((l) => l.includes("|holder|"))).toHaveLength(6);
  });

  const facts = { id: REQUEST, assetLabel: "<script>alert(1)</script> & \"Co\"\n", amount: "250", outcomeTx: TX, network: "devnet" as const };

  it("escapes the asset label and links the outcome transaction on the explorer", () => {
    const converted = conversionHolderMessage("converted", facts, "https://devnet.manci.io");
    expect(converted.subject).toBe("Manci: your conversion is registered");
    expect(converted.html).not.toContain("<script>");
    expect(converted.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Co&quot;");
    expect(converted.html).toContain(`https://explorer.solana.com/tx/${TX}?cluster=devnet`);
    expect(converted.html).toContain('href="https://devnet.manci.io/portfolio/conversion"');
    expect(converted.html).toContain("request 6f9619ff");
    expect(conversionHolderMessage("returned", { ...facts, outcomeTx: "not-a-signature" }, null).html).not.toContain("explorer");
  });

  it("quotes the typical durations, never a promise", () => {
    const requested = conversionHolderMessage("requested", facts, null).html;
    expect(requested).toContain(`typically in ${CONVERSION_TYPICAL_DURATIONS.review}`);
    const deposit = conversionHolderMessage("deposited", facts, null).html;
    expect(deposit).toContain(`typically in ${CONVERSION_TYPICAL_DURATIONS.filing}`);
    expect(deposit).toContain(`typically follows ${CONVERSION_TYPICAL_DURATIONS.registerDecision}`);
    for (const event of CONVERSION_EVENTS) {
      expect(conversionHolderMessage(event, facts, null).html).not.toMatch(/\b(will take|guaranteed (?!\.)|within \d)/i);
      expect(conversionHolderMessage(event, facts, null).html).toContain("Open Portfolio, then Conversion, on Manci.");
    }
  });

  it("gives the operator the event, the short id and the queue: no asset, units or link to the holder", () => {
    const message = conversionOperatorMessage("deposited", { id: REQUEST, network: "devnet" }, "https://devnet.manci.io");
    expect(message.subject).toBe("[Manci devnet] Units deposited for conversion 6f9619ff");
    expect(message.html).toContain('href="https://devnet.manci.io/admin/custody#conversion-requests"');
    expect(message.html).not.toMatch(/250|Mancipatio|portfolio/);
    expect(conversionOperatorMessage("requested", { id: REQUEST, network: "mainnet" }, null).subject)
      .toBe("[Manci mainnet] New conversion request 6f9619ff");
  });

  it("links only to an https site origin", async () => {
    seedRequest();
    seedDossier();
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://evil.example.org");
    await sendConversionNotifications(REQUEST, "vault_opened");
    expect(sent()[0].html).not.toContain("http://");
  });
});

describe("routes: the status write first, the email after the response", () => {
  async function post(handler: (r: Request) => Promise<Response>, wallet: string, params: Record<string, unknown>) {
    signer.wallet = wallet;
    signer.params = params;
    const res = await handler(new Request("https://manci.test/api/x", { method: "POST", body: "{}" }));
    return { status: res.status, body: (await res.json()) as { ok?: boolean; data?: unknown; error?: string } };
  }
  async function runLater() {
    for (const task of later.tasks.splice(0)) await task();
  }

  it("admin-update: a status change answers first, then emails the holder once", async () => {
    seedRequest({ status: "deposited", vault_pda: "Vau1t11111111111111111111111111111111111111" });
    seedDossier();
    custody.validateCustodyUpdate.mockResolvedValueOnce("deposited");
    const res = await post(adminUpdate, ADMIN, { id: REQUEST, status: "converted" });
    expect(res).toEqual({ status: 200, body: { ok: true, data: { id: REQUEST, status: "converted" } } });
    expect(rows("conversion_requests")[0].status).toBe("converted");
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(later.tasks).toHaveLength(1);
    await runLater();
    expect(sent().map((input) => input.subject)).toEqual(["Manci: your conversion is registered"]);
    // The same status again (a second click after a slow response): nothing new.
    custody.validateCustodyUpdate.mockResolvedValueOnce("converted");
    expect((await post(adminUpdate, ADMIN, { id: REQUEST, status: "converted" })).status).toBe(200);
    expect(later.tasks).toHaveLength(0);
  });

  it("admin-update: a note-only patch schedules nothing", async () => {
    seedRequest({ status: "requested" });
    custody.validateCustodyUpdate.mockResolvedValueOnce("requested");
    expect((await post(adminUpdate, ADMIN, { id: REQUEST, admin_note: "Checked" })).status).toBe(200);
    expect(later.tasks).toHaveLength(0);
  });

  it("admin-update: a refused write schedules nothing", async () => {
    seedRequest({ status: "requested" });
    custody.validateCustodyUpdate.mockRejectedValueOnce(new SiwsError(409, "A verified custody vault is required"));
    const res = await post(adminUpdate, ADMIN, { id: REQUEST, status: "converted" });
    expect(res).toEqual({ status: 409, body: { ok: false, error: "A verified custody vault is required" } });
    expect(rows("conversion_requests")[0].status).toBe("requested");
    expect(later.tasks).toHaveLength(0);
  });

  it("an email failure never reaches the route's answer", async () => {
    seedRequest({ status: "requested" });
    delete db.ref!.rpcs.claim_notification;
    mail.sendEmail.mockRejectedValue(new Error("down"));
    const res = await post(cancel, HOLDER, { id: REQUEST });
    expect(res).toEqual({ status: 200, body: { ok: true, data: { id: REQUEST, status: "cancelled" } } });
    await expect(runLater()).resolves.toBeUndefined();
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it("cancel: the holder's own cancel is confirmed by email", async () => {
    seedRequest({ status: "requested" });
    seedDossier();
    expect((await post(cancel, HOLDER, { id: REQUEST })).status).toBe(200);
    await runLater();
    expect(sent().map((input) => input.subject)).toEqual(["Manci: your conversion request was cancelled"]);
  });

  it("deposited: the holder and the operator hear of it; a re-recorded later state schedules nothing", async () => {
    seedRequest({ status: "deposited" });
    seedDossier();
    expect((await post(deposited, HOLDER, { id: REQUEST, deposit_tx: TX })).status).toBe(200);
    await runLater();
    expect(sent().map((input) => input.subject).sort()).toEqual([
      "Manci: your units are in escrow",
      "[Manci devnet] Units deposited for conversion 6f9619ff",
    ]);
    custody.recordCustodyDeposit.mockResolvedValueOnce({ id: REQUEST, status: "converted" });
    expect((await post(deposited, HOLDER, { id: REQUEST, deposit_tx: TX })).status).toBe(200);
    expect(later.tasks).toHaveLength(0);
  });

  it("reclaim: the holder's own return is confirmed by email", async () => {
    seedRequest({ status: "returned", outcome_tx: TX });
    seedDossier();
    expect((await post(reclaim, HOLDER, { id: REQUEST, outcome_tx: TX })).status).toBe(200);
    await runLater();
    expect(sent().map((input) => input.subject)).toEqual(["Manci: your escrowed units were returned"]);
  });

  it("create: schedules the request's emails after the insert, before answering", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${process.cwd()}/app/api/conversion/create/route.ts`, "utf8");
    const insert = src.indexOf('.from("conversion_requests")\n      .insert(');
    const notify = src.indexOf('notifyConversionStatus(data.id as string, "requested")');
    const answer = src.indexOf("return NextResponse.json({ ok: true, data: { id: data.id as string, request: data } })");
    expect(insert).toBeGreaterThan(-1);
    expect(notify).toBeGreaterThan(src.indexOf("Could not save the conversion request"));
    expect(notify).toBeGreaterThan(insert);
    expect(answer).toBeGreaterThan(notify);
  });
});
