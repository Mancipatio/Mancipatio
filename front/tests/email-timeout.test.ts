import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const smtp = vi.hoisted(() => ({ sendMail: vi.fn() }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => smtp } }));

import { sendEmail } from "@/lib/server/email";

beforeEach(() => {
  vi.stubEnv("SMTP_HOST", "smtp.test");
  vi.stubEnv("SMTP_USER", "synthetic-user");
  vi.stubEnv("SMTP_PASS", "synthetic-password");
  vi.stubEnv("EMAIL_FROM", "alerts@manci.io");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); smtp.sendMail.mockReset(); });

describe("SMTP timeout classification", () => {
  it.each([false, true])("normalizes a native timeout before the outer timer, redactErrors=%s", async (redactErrors) => {
    smtp.sendMail.mockRejectedValueOnce(Object.assign(new Error("private SMTP diagnostic"), {
      code: "ETIMEDOUT", timeoutType: "GREETING_TIMEOUT",
    }));
    expect(await sendEmail({
      to: "office@manci.io", subject: "s", html: "h", timeoutMs: 10_000, redactErrors,
    })).toEqual({ sent: false, error: "TIMEOUT" });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private SMTP diagnostic");
  });

  it("classifies the transport's default timeout without a caller deadline", async () => {
    smtp.sendMail.mockRejectedValueOnce(Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" }));
    expect(await sendEmail({ to: "office@manci.io", subject: "s", html: "h" }))
      .toEqual({ sent: false, error: "TIMEOUT" });
  });

  it.each([
    [{ code: "EAUTH", responseCode: 535 }, false, "SMTP 535"],
    [{ code: "ESOCKET" }, false, "SMTP ESOCKET"],
    [{ code: "EAUTH", responseCode: 535 }, true, "Delivery failed"],
  ] as const)("keeps non-timeout failures distinct and redacts them when requested", async (fields, redactErrors, error) => {
    // A provider's free-text message must not decide the timeout category.
    smtp.sendMail.mockRejectedValueOnce(Object.assign(new Error("Timeout mentioned in diagnostic"), fields));
    expect(await sendEmail({ to: "office@manci.io", subject: "s", html: "h", redactErrors }))
      .toEqual({ sent: false, error });
  });
});
