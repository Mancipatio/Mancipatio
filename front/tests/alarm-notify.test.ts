// Talas 4.4b: the alert email outbox. The digest carries no evidence,
// wallets or amounts; the send has a hard deadline; SMTP is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const smtp = vi.hoisted(() => ({ mode: "ok" as "ok" | "hang" | "fail", sent: [] as unknown[] }));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn((options: unknown) => ({
      options,
      sendMail: vi.fn((mail: unknown) => {
        smtp.sent.push(mail);
        if (smtp.mode === "hang") return new Promise(() => {});
        if (smtp.mode === "fail") return Promise.reject(Object.assign(new Error("recipient x@y rejected"), { responseCode: 550 }));
        return Promise.resolve({ messageId: "m1" });
      }),
    })),
  },
}));
vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => "devnet",
}));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => { throw new Error("not in tests"); } }));

import nodemailer from "nodemailer";
import { sendEmail } from "@/lib/server/email";
import {
  DIGEST_LIMIT, SOURCE_LABELS, alertDigest, alertRecipients, alertWebhookBody, alertWebhookConfig, alertWebhookPayload, notifyPendingAlerts,
  type DigestRow,
} from "@/lib/server/system-alerts";

const SIG = "5".repeat(88);
const WALLET = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const row = (over: Partial<DigestRow> = {}): DigestRow => ({
  id: crypto.randomUUID(), created_at: "2026-09-24T10:00:00.000Z", source: "onchain:pause", severity: "high",
  summary: "Pause flags set <b>(0x02)</b>", tx_signature: SIG, category: "onchain", ...over,
});

beforeEach(() => {
  smtp.mode = "ok";
  smtp.sent = [];
  vi.stubEnv("SMTP_HOST", "smtp.test");
  vi.stubEnv("SMTP_USER", "user");
  vi.stubEnv("SMTP_PASS", "pass");
  vi.stubEnv("EMAIL_FROM", "alarms@manci.test");
  vi.stubEnv("COMPLIANCE_ALERT_EMAIL", "office@mancipatio.io");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.manci.io");
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("alertDigest", () => {
  it("escapes, links only platform-format signatures, and never carries wallets, amounts or evidence", () => {
    const { subject, html } = alertDigest([
      row(),
      row({ source: "onchain:clawback", severity: "medium", summary: `Clawback of ${WALLET} amount 5000`, tx_signature: SIG }),
      row({ source: "ledger:over-cap", severity: "critical", summary: "Booked €2,500,000 for issuer", tx_signature: null }),
      row({ source: "onchain:decode", severity: "medium", summary: `Layout drift ${WALLET}` }),
    ], "devnet", "https://www.manci.io");
    expect(subject).toBe("[Manci devnet] 1 critical, 1 high, 2 medium");
    expect(html).toContain("Pause flags set &lt;b&gt;(0x02)&lt;/b&gt;");
    expect(html.match(/explorer\.solana\.com/g)).toHaveLength(1);
    expect(html).not.toContain(WALLET);
    expect(html).not.toMatch(/2,500,000|5000/);
    expect(html).toContain("Holder clawback");
    expect(html).toContain("Raise-cap ledger alert");
    expect(html).toContain("https://www.manci.io/admin/compliance");
    expect(html).toContain("2026-09-24 10:00:00 UTC");
  });
});

describe("recipients", () => {
  it("accepts up to five valid addresses and refuses anything else", () => {
    expect(alertRecipients("office@mancipatio.io")).toEqual(["office@mancipatio.io"]);
    expect(alertRecipients("a@x.io, b@x.io")).toEqual(["a@x.io", "b@x.io"]);
    expect(alertRecipients("")).toBeNull();
    expect(alertRecipients("not-an-email")).toBeNull();
    expect(alertRecipients("a@x.io,b@x.io,c@x.io,d@x.io,e@x.io,f@x.io")).toBeNull();
  });
});

type Finish = { p_rows: { id: string; severity: string }[]; p_sent: boolean; p_error: string | null };
type Incident = { p_check: string; p_state: string; p_severity: string; p_source: string; p_summary: string; p_evidence: Record<string, unknown> };
function outbox(rows: DigestRow[]) {
  const finishes: Finish[] = [];
  // Each channel's outcome is reported as an incident (report_incident), beside the outbox update.
  const incidents: Incident[] = [];
  let selected = "";
  let limit = 0;
  const sb = {
    from: () => {
      const b: Record<string, unknown> = {};
      let severities: string[] | null = null;
      b.select = (cols: string) => { selected = cols; return b; };
      for (const m of ["eq", "lte", "order"]) b[m] = () => b;
      b.in = (_col: string, values: string[]) => { severities = values; return b; };
      b.limit = (n: number) => { limit = n; return b; };
      // Rows come in next_notify_at order (the array order), filtered by severity.
      b.abortSignal = () => Promise.resolve({
        data: rows.filter((r) => !severities || severities.includes(r.severity)).slice(0, limit), error: null,
      });
      return b;
    },
    rpc: (fn: string, args: Finish & Incident) => {
      if (fn === "report_incident") {
        incidents.push(args);
        return { abortSignal: () => Promise.resolve({ data: { action: "opened", alert_id: null }, error: null }) };
      }
      finishes.push(args);
      return { abortSignal: () => Promise.resolve({ data: args.p_rows.length, error: null }) };
    },
  };
  const channels = () => Object.fromEntries(incidents.map((i) => [i.p_check, i.p_state]));
  return { sb: sb as never, finishes, incidents, channels, selected: () => selected };
}

describe("notifyPendingAlerts", () => {
  it("critical and high rows go first, even behind a flood of older medium rows", async () => {
    const box = outbox([...Array.from({ length: 30 }, () => row({ severity: "medium" })), row({ severity: "critical", id: "c1" })]);
    await notifyPendingAlerts(Date.now() + 10_000, undefined, box.sb);
    const sent = box.finishes[0].p_rows;
    expect(sent).toHaveLength(DIGEST_LIMIT);
    expect(sent[0]).toMatchObject({ id: "c1", severity: "critical" });
  });

  it("critical before high: a backlog of older high rows never holds back a newer critical one", async () => {
    // e.g. a burst of high on-chain alerts, then an admin grant (critical) a minute later.
    const box = outbox([
      ...Array.from({ length: 40 }, () => row({ severity: "high", source: "onchain:custody-authority" })),
      row({ severity: "medium" }),
      row({ severity: "critical", id: "c1", source: "onchain:admin-grant" }),
    ]);
    const result = await notifyPendingAlerts(Date.now() + 10_000, undefined, box.sb);
    expect(result).toMatchObject({ status: "sent", count: DIGEST_LIMIT });
    const sent = box.finishes[0].p_rows;
    expect(sent).toHaveLength(DIGEST_LIMIT);
    expect(sent[0]).toEqual({ id: "c1", severity: "critical" });
    expect(sent.slice(1).every((r) => r.severity === "high")).toBe(true);
    expect((smtp.sent[0] as { subject: string }).subject).toBe("[Manci devnet] 1 critical, 24 high");
  });

  it("sends one digest of at most 25 rows, never reading evidence, and marks them sent", async () => {
    const box = outbox(Array.from({ length: 30 }, () => row()));
    const result = await notifyPendingAlerts(Date.now() + 10_000, undefined, box.sb);
    // The result names each channel's outcome (the webhook is the second channel, unset here).
    expect(result).toEqual({ status: "sent", count: DIGEST_LIMIT, channels: { email: "sent", webhook: "not_configured" } });
    expect(box.selected()).not.toContain("evidence");
    expect(smtp.sent).toHaveLength(1);
    expect((smtp.sent[0] as { to: string[] }).to).toEqual(["office@mancipatio.io"]);
    expect(box.finishes[0]).toMatchObject({ p_sent: true, p_error: null });
    expect(box.finishes[0].p_rows).toHaveLength(25);
  });

  it("NOT_CONFIGURED without recipients or a transport: nothing read, rows stay pending", async () => {
    vi.stubEnv("COMPLIANCE_ALERT_EMAIL", "");
    const box = outbox([row()]);
    expect(await notifyPendingAlerts(Date.now() + 10_000, undefined, box.sb)).toEqual({ status: "not_configured" });
    vi.stubEnv("COMPLIANCE_ALERT_EMAIL", "office@mancipatio.io");
    vi.stubEnv("SMTP_HOST", "");
    vi.stubEnv("RESEND_API_KEY", "");
    expect(await notifyPendingAlerts(Date.now() + 10_000, undefined, box.sb)).toEqual({ status: "not_configured" });
    expect(box.finishes).toEqual([]);
  });

  it("a failed send records SEND_FAILED for the backoff (the SQL applies it); too little time defers", async () => {
    smtp.mode = "fail";
    const box = outbox([row({ severity: "critical" })]);
    expect(await notifyPendingAlerts(Date.now() + 10_000, undefined, box.sb)).toMatchObject({ status: "failed", error: "SEND_FAILED" });
    expect(box.finishes[0]).toMatchObject({ p_sent: false, p_error: "SEND_FAILED" });
    expect(await notifyPendingAlerts(Date.now() + 3_000, undefined, box.sb)).toEqual({ status: "deferred" });
  });

  it("the hard timeout returns within timeoutMs while the SMTP server hangs (SEND_TIMEOUT)", async () => {
    smtp.mode = "hang";
    const box = outbox([row()]);
    const started = Date.now();
    const result = await notifyPendingAlerts(Date.now() + 4_600, undefined, box.sb);
    expect(result).toMatchObject({ status: "failed", error: "SEND_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(4_600);
    expect(box.finishes[0]).toMatchObject({ p_error: "SEND_TIMEOUT" });
  }, 10_000);
});

describe("sendEmail timeoutMs", () => {
  it("caps the SMTP timeouts and abandons a hanging send; without it the defaults are unchanged", async () => {
    smtp.mode = "hang";
    const started = Date.now();
    expect(await sendEmail({ to: "a@x.io", subject: "s", html: "h", timeoutMs: 50 })).toEqual({ sent: false, error: "TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(1_000);
    const options = vi.mocked(nodemailer.createTransport).mock.calls.at(-1)![0] as Record<string, number>;
    expect(options).toMatchObject({ connectionTimeout: 50, greetingTimeout: 50, socketTimeout: 50 });
    smtp.mode = "ok";
    await sendEmail({ to: "a@x.io", subject: "s", html: "h" });
    expect(vi.mocked(nodemailer.createTransport).mock.calls.at(-1)![0]).toMatchObject({ connectionTimeout: 10_000, socketTimeout: 15_000 });
  });
});

// ops-qa-2: the second channel. A generic JSON webhook, parallel to email;
// one channel failing or hanging never stops the other.
describe("alert webhook", () => {
  type Call = { url: string; init: RequestInit & { headers: Record<string, string> } };
  let calls: Call[] = [];
  let answer: "ok" | "500" | "hang" | "throw" = "ok";
  beforeEach(() => {
    calls = [];
    answer = "ok";
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://ntfy.example/manci-alerts?tpl=yes");
    vi.stubEnv("ALERT_WEBHOOK_TOKEN", "tk_secret");
    vi.stubGlobal("fetch", vi.fn((url: string, init: Call["init"]) => {
      calls.push({ url, init });
      if (answer === "hang") {
        return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      if (answer === "throw") return Promise.reject(new Error("ECONNREFUSED hooks.example"));
      return Promise.resolve(new Response("ok", { status: answer === "500" ? 500 : 200 }));
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("config: https only (http for localhost), a known min severity, no whitespace in the token", () => {
    expect(alertWebhookConfig({})).toBeNull();
    expect(alertWebhookConfig({ ALERT_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/X" }))
      .toEqual({ url: "https://hooks.slack.com/services/T/B/X", token: null, minSeverity: "high", format: "json" });
    expect(alertWebhookConfig({ ALERT_WEBHOOK_URL: "https://chat.googleapis.com/v1/spaces/X/messages?key=k", ALERT_WEBHOOK_FORMAT: "Text" }))
      .toMatchObject({ format: "text" });
    expect(alertWebhookConfig({ ALERT_WEBHOOK_URL: "https://h.example", ALERT_WEBHOOK_FORMAT: "slack" })).toBe("invalid");
    expect(alertWebhookConfig({ ALERT_WEBHOOK_URL: "http://localhost:8080/hook", ALERT_WEBHOOK_MIN_SEVERITY: "Critical" }))
      .toMatchObject({ minSeverity: "critical" });
    expect(alertWebhookConfig({ ALERT_WEBHOOK_URL: "http://hooks.example/x" })).toBe("invalid");
    expect(alertWebhookConfig({ ALERT_WEBHOOK_URL: "not a url" })).toBe("invalid");
    expect(alertWebhookConfig({ ALERT_WEBHOOK_URL: "https://h.example", ALERT_WEBHOOK_MIN_SEVERITY: "low" })).toBe("invalid");
    expect(alertWebhookConfig({ ALERT_WEBHOOK_URL: "https://h.example", ALERT_WEBHOOK_TOKEN: "a b" })).toBe("invalid");
  });

  it("payload: text for Slack/ntfy, severity and priority of the worst row, and the email's privacy rules", () => {
    const payload = alertWebhookPayload([
      row({ severity: "critical", source: "onchain:treasury", summary: "Protocol treasury set to X" }),
      row({ source: "onchain:clawback", severity: "high", summary: `Clawback of ${WALLET} amount 5000` }),
    ], "mainnet", "https://www.manci.io");
    expect(payload).toMatchObject({ title: "[Manci mainnet] 1 critical, 1 high", severity: "critical", priority: 5,
      network: "mainnet", count: 2, review_url: "https://www.manci.io/admin/compliance" });
    expect(payload.text).toContain("CRITICAL — Protocol treasury changed — 2026-09-24 10:00:00 UTC: Protocol treasury set to X");
    expect(payload.text).toContain("HIGH — Holder clawback");
    expect(payload.alerts[0].tx_url).toBe(`https://explorer.solana.com/tx/${SIG}`);
    // Minimal rows: label and time only, never the summary or the transaction.
    expect(payload.alerts[1]).not.toHaveProperty("summary");
    expect(payload.alerts[1]).not.toHaveProperty("tx_url");
    expect(JSON.stringify(payload)).not.toContain(WALLET);
    expect(JSON.stringify(payload)).not.toContain("5000");
  });

  it("both channels: the webhook gets high and critical rows (with the bearer token), email gets all; all sent", async () => {
    const box = outbox([row({ severity: "critical", id: "c1" }), row({ severity: "medium", id: "m1" })]);
    const result = await notifyPendingAlerts(Date.now() + 10_000, undefined, box.sb);
    expect(result).toEqual({ status: "sent", count: 2, channels: { email: "sent", webhook: "sent" } });
    expect(smtp.sent).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://ntfy.example/manci-alerts?tpl=yes");
    expect(calls[0].init.headers).toMatchObject({ "Content-Type": "application/json", Authorization: "Bearer tk_secret" });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.alerts.map((a: { id: string }) => a.id)).toEqual(["c1"]);
    expect(box.finishes).toEqual([expect.objectContaining({
      p_sent: true, p_rows: [{ id: "c1", severity: "critical" }, { id: "m1", severity: "medium" }],
    })]);
  });

  it("email down, webhook up: high rows are delivered (sent), medium rows back off; the run is failed", async () => {
    smtp.mode = "fail";
    const box = outbox([row({ severity: "high", id: "h1" }), row({ severity: "medium", id: "m1" })]);
    const result = await notifyPendingAlerts(Date.now() + 10_000, undefined, box.sb);
    expect(result).toMatchObject({ status: "failed", error: "SEND_FAILED", channels: { email: "failed", webhook: "sent" } });
    expect(box.finishes).toEqual([
      expect.objectContaining({ p_sent: true, p_rows: [{ id: "h1", severity: "high" }] }),
      expect.objectContaining({ p_sent: false, p_error: "SEND_FAILED", p_rows: [{ id: "m1", severity: "medium" }] }),
    ]);
  });

  it("a hanging webhook never holds up email: every row is sent by email, the run is failed (WEBHOOK_TIMEOUT)", async () => {
    answer = "hang";
    const box = outbox([row({ severity: "critical" })]);
    const started = Date.now();
    const result = await notifyPendingAlerts(Date.now() + 4_600, undefined, box.sb);
    expect(Date.now() - started).toBeLessThan(4_600);
    expect(result).toMatchObject({ status: "failed", error: "WEBHOOK_TIMEOUT", channels: { email: "sent", webhook: "timeout" } });
    expect(box.finishes).toEqual([expect.objectContaining({ p_sent: true })]);
  }, 10_000);

  it("a webhook error (HTTP 500 or refused) is WEBHOOK_FAILED and never logs the URL or the token", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const mode of ["500", "throw"] as const) {
      answer = mode;
      const box = outbox([row({ severity: "critical" })]);
      expect(await notifyPendingAlerts(Date.now() + 10_000, undefined, box.sb))
        .toMatchObject({ status: "failed", error: "WEBHOOK_FAILED", channels: { webhook: "failed" } });
    }
    const logged = errors.mock.calls.flat().join(" ");
    expect(logged).not.toContain("ntfy.example");
    expect(logged).not.toContain("tk_secret");
    errors.mockRestore();
  });

  it("text format: the body is {text} and nothing else (Google Chat refuses unknown fields; Mattermost reads priority)", async () => {
    const rows = [row({ severity: "critical", source: "onchain:treasury", summary: "Protocol treasury set to X" })];
    const text = alertWebhookBody("text", rows, "mainnet", "https://www.manci.io");
    expect(Object.keys(text)).toEqual(["text"]);
    expect(text.text).toBe(alertWebhookPayload(rows, "mainnet", "https://www.manci.io").text);
    expect(alertWebhookBody("json", rows, "mainnet", "https://www.manci.io")).toMatchObject({ priority: 5, severity: "critical" });
    vi.stubEnv("ALERT_WEBHOOK_FORMAT", "text");
    await notifyPendingAlerts(Date.now() + 10_000, undefined, outbox(rows).sb);
    expect(Object.keys(JSON.parse(String(calls[0].init.body)))).toEqual(["text"]);
  });

  it("a dead channel is an incident of its own, delivered by the other channel; delivering again clears it", async () => {
    expect(SOURCE_LABELS["worker:alert-channel"]).toMatchObject({ format: "platform" });
    // Webhook refused (e.g. a revoked token), email fine: every row is 'sent', so nothing gets stuck.
    answer = "500";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const box = outbox([row({ severity: "critical" })]);
    await notifyPendingAlerts(Date.now() + 10_000, undefined, box.sb);
    expect(box.finishes).toEqual([expect.objectContaining({ p_sent: true })]);
    expect(box.channels()).toEqual({ "alert-channel-webhook": "fail", "alert-channel-email": "pass" });
    const webhook = box.incidents.find((i) => i.p_check === "alert-channel-webhook")!;
    expect(webhook).toMatchObject({ p_severity: "high", p_source: "worker:alert-channel", p_evidence: { channel: "webhook", outcome: "failed", alerts: 1 } });
    expect(webhook.p_summary).toMatch(/failed .*the other channel delivered it/);
    // Never the URL or the token.
    expect(JSON.stringify(box.incidents)).not.toMatch(/ntfy\.example|tk_secret/);
    // The other way round: SMTP down, webhook up.
    answer = "ok";
    smtp.mode = "fail";
    const back = outbox([row({ severity: "high" })]);
    await notifyPendingAlerts(Date.now() + 10_000, undefined, back.sb);
    expect(back.channels()).toEqual({ "alert-channel-email": "fail", "alert-channel-webhook": "pass" });
    // A channel with no row to send (medium rows stay off the webhook) says nothing.
    smtp.mode = "ok";
    const quiet = outbox([row({ severity: "medium" })]);
    await notifyPendingAlerts(Date.now() + 10_000, undefined, quiet.sb);
    expect(quiet.channels()).toEqual({ "alert-channel-email": "pass" });
  });

  it("webhook only (no email): it takes every row the outbox sends; neither channel: NOT_CONFIGURED", async () => {
    vi.stubEnv("COMPLIANCE_ALERT_EMAIL", "");
    const box = outbox([row({ severity: "medium", id: "m1" })]);
    expect(await notifyPendingAlerts(Date.now() + 10_000, undefined, box.sb))
      .toEqual({ status: "sent", count: 1, channels: { email: "not_configured", webhook: "sent" } });
    expect(JSON.parse(String(calls[0].init.body)).alerts).toHaveLength(1);
    expect(smtp.sent).toHaveLength(0);
    vi.stubEnv("ALERT_WEBHOOK_URL", "");
    expect(await notifyPendingAlerts(Date.now() + 10_000, undefined, box.sb)).toEqual({ status: "not_configured" });
  });
});
