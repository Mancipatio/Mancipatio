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
import { DIGEST_LIMIT, alertDigest, alertRecipients, notifyPendingAlerts, type DigestRow } from "@/lib/server/system-alerts";

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
function outbox(rows: DigestRow[]) {
  const finishes: Finish[] = [];
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
    rpc: (_fn: string, args: Finish) => {
      finishes.push(args);
      return { abortSignal: () => Promise.resolve({ data: args.p_rows.length, error: null }) };
    },
  };
  return { sb: sb as never, finishes, selected: () => selected };
}

describe("notifyPendingAlerts", () => {
  it("critical and high rows go first, even behind a flood of older medium rows", async () => {
    const box = outbox([...Array.from({ length: 30 }, () => row({ severity: "medium" })), row({ severity: "critical", id: "c1" })]);
    await notifyPendingAlerts(Date.now() + 10_000, undefined, box.sb);
    const sent = box.finishes[0].p_rows;
    expect(sent).toHaveLength(DIGEST_LIMIT);
    expect(sent[0]).toMatchObject({ id: "c1", severity: "critical" });
  });

  it("sends one digest of at most 25 rows, never reading evidence, and marks them sent", async () => {
    const box = outbox(Array.from({ length: 30 }, () => row()));
    const result = await notifyPendingAlerts(Date.now() + 10_000, undefined, box.sb);
    expect(result).toEqual({ status: "sent", count: DIGEST_LIMIT });
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
