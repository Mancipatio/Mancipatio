// The REAL nodemailer (10.x, front-app-16 / ops-qa-14) behind sendEmail,
// against local fake SMTP servers: the options email.ts passes still work,
// failures come back as { sent: false } (never a throw), a 587 server without
// STARTTLS never receives the password (requireTLS), and timeoutMs holds
// against a server that never greets. No mocks of nodemailer here.
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { sendEmail } from "@/lib/server/email";

let server: Server | null = null;
let seen: string[] = [];
const sockets = new Set<Socket>();

/** A plain-text SMTP server: `greet` false never sends the 220 banner. */
async function smtpServer(greet: boolean): Promise<number> {
  server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    if (!greet) return;
    socket.write("220 fake.test ESMTP\r\n");
    socket.on("data", (chunk: string) => {
      for (const line of chunk.split("\r\n").filter(Boolean)) {
        seen.push(line);
        if (/^EHLO/i.test(line)) socket.write("250-fake.test\r\n250 AUTH PLAIN LOGIN\r\n"); // no STARTTLS
        else if (/^QUIT/i.test(line)) socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server!.address() as AddressInfo).port;
}

beforeEach(() => {
  seen = [];
  vi.stubEnv("SMTP_HOST", "127.0.0.1");
  vi.stubEnv("SMTP_USER", "alerts@manci.test");
  vi.stubEnv("SMTP_PASS", "pw-never-in-clear");
  vi.stubEnv("EMAIL_FROM", "alerts@manci.io");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = null;
});

describe("sendEmail with the real nodemailer", () => {
  it("a refused connection is { sent: false } with a code, redacted on request", async () => {
    const port = await smtpServer(true);
    await new Promise((resolve) => server!.close(resolve));
    server = null;
    vi.stubEnv("SMTP_PORT", String(port));
    const plain = await sendEmail({ to: "office@manci.io", subject: "s", html: "h" });
    expect(plain.sent).toBe(false);
    expect(plain.error).toMatch(/^SMTP [A-Z]+/);
    expect(await sendEmail({ to: "office@manci.io", subject: "s", html: "h", redactErrors: true }))
      .toEqual({ sent: false, error: "Delivery failed" });
  });

  it("port 587 without STARTTLS: refused before AUTH, the password never crosses in clear", async () => {
    vi.stubEnv("SMTP_PORT", String(await smtpServer(true)));
    const result = await sendEmail({ to: "office@manci.io", subject: "s", html: "h" });
    expect(result.sent).toBe(false);
    expect(seen.some((line) => /^EHLO/i.test(line))).toBe(true);
    expect(seen.some((line) => /^AUTH/i.test(line))).toBe(false);
    expect(seen.join("\n")).not.toContain(Buffer.from("pw-never-in-clear").toString("base64"));
  });

  it("timeoutMs holds against a server that never greets", async () => {
    vi.stubEnv("SMTP_PORT", String(await smtpServer(false)));
    const started = Date.now();
    expect(await sendEmail({ to: "office@manci.io", subject: "s", html: "h", timeoutMs: 300 })).toEqual({ sent: false, error: "TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
