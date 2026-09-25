// sendEmail never mails RFC 2606 / RFC 6761 reserved domains: simulated
// devnet users (@example.com) would only bounce off our sender. SMTP and the
// Resend REST call are mocked, so "no transport call" is observable.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const smtp = vi.hoisted(() => ({ sent: [] as { to: unknown }[] }));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: vi.fn((mail: { to: unknown }) => {
        smtp.sent.push(mail);
        return Promise.resolve({ messageId: "m1" });
      }),
    })),
  },
}));

import nodemailer from "nodemailer";
import { isReservedEmailDomain, sendEmail } from "@/lib/server/email";

const createTransport = vi.mocked(nodemailer.createTransport);
const mail = (to: string | string[]) => ({ to, subject: "Your KYC decision", html: "<p>ok</p>" });
const SKIPPED = { sent: false, error: "Reserved recipient domain" };

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  smtp.sent = [];
  createTransport.mockClear();
  vi.stubEnv("SMTP_HOST", "smtp.test");
  vi.stubEnv("SMTP_USER", "user");
  vi.stubEnv("SMTP_PASS", "pass");
  vi.stubEnv("EMAIL_FROM", "office@manci.io");
  info = vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  info.mockRestore();
});

describe("sendEmail reserved domains", () => {
  it.each([
    ["user1@example.com", "example.com"],
    ["user1@example.net", "example.net"],
    ["user1@example.org", "example.org"],
    ["kyc@mail.example.com", "mail.example.com"],
    ["a@deep.sub.example.org", "deep.sub.example.org"],
    ["a@foo.test", "foo.test"],
    ["a@shop.example", "shop.example"],
    ["a@nowhere.invalid", "nowhere.invalid"],
    ["a@app.localhost", "app.localhost"],
    ["a@localhost", "localhost"],
    ["Test User <a@example.com>", "example.com"],
  ])("skips %s without opening a transport", async (to, domain) => {
    expect(await sendEmail(mail(to))).toEqual(SKIPPED);
    expect(createTransport).not.toHaveBeenCalled();
    expect(smtp.sent).toHaveLength(0);
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0][0]);
    expect(line).toBe(`[email] skipped reserved domain ${domain}`);
    // Only the domain is logged, never the local part.
    expect(line).not.toContain("a@");
    expect(line).not.toContain("user1");
  });

  it("is case-insensitive and ignores a trailing dot", async () => {
    expect(await sendEmail(mail("User@EXAMPLE.COM"))).toEqual(SKIPPED);
    expect(await sendEmail(mail("u@Sub.Example.Org."))).toEqual(SKIPPED);
    expect(await sendEmail(mail("u@FOO.TEST"))).toEqual(SKIPPED);
    expect(await sendEmail(mail("u@LocalHost"))).toEqual(SKIPPED);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("still sends to a normal domain, with the input unchanged", async () => {
    expect(await sendEmail(mail("founder@manci.io"))).toEqual({ sent: true, id: "m1" });
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(smtp.sent[0].to).toBe("founder@manci.io");
    expect(info).not.toHaveBeenCalled();
  });

  it.each(["a@myexample.com", "a@example.com.evil.io", "a@example.co", "a@notexample.org", "a@testing.io", "a@localhost.io"])(
    "does not skip the lookalike %s",
    async (to) => {
      expect(await sendEmail(mail(to))).toEqual({ sent: true, id: "m1" });
      expect(smtp.sent[0].to).toBe(to);
    },
  );

  it("filters each recipient of a mixed array", async () => {
    const result = await sendEmail(mail(["ops@manci.io", "u1@example.com", "Office <office@manci.io>", "u2@x.test"]));
    expect(result).toEqual({ sent: true, id: "m1" });
    expect(smtp.sent[0].to).toEqual(["ops@manci.io", "Office <office@manci.io>"]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toBe("[email] skipped reserved domain example.com, x.test");
  });

  it("filters a comma-separated recipient string", async () => {
    expect(await sendEmail(mail("ops@manci.io, u1@example.com"))).toEqual({ sent: true, id: "m1" });
    expect(smtp.sent[0].to).toEqual(["ops@manci.io"]);
  });

  it("skips when every recipient is reserved", async () => {
    expect(await sendEmail(mail(["u1@example.com", "u2@EXAMPLE.net", "u3@a.invalid"]))).toEqual(SKIPPED);
    expect(await sendEmail({ ...mail("u@example.com"), timeoutMs: 50 })).toEqual(SKIPPED);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("never calls the Resend API for a reserved recipient", async () => {
    vi.stubEnv("SMTP_HOST", "");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "r1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendEmail(mail("u@example.org"))).toEqual(SKIPPED);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await sendEmail(mail(["u@example.org", "founder@manci.io"]))).toEqual({ sent: true, id: "r1" });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.to).toEqual(["founder@manci.io"]);
  });
});

describe("isReservedEmailDomain", () => {
  it("matches reserved names and their subdomains only", () => {
    for (const d of ["example.com", "a.example.net", "EXAMPLE.ORG", "x.test", "test", "x.example", "x.invalid", "localhost", "x.localhost"]) {
      expect(isReservedEmailDomain(d), d).toBe(true);
    }
    for (const d of ["myexample.com", "example.com.evil.io", "example.io", "testnet.io", "manci.io", ""]) {
      expect(isReservedEmailDomain(d), d).toBe(false);
    }
  });
});
