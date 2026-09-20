import "server-only";
import { SiwsError } from "@/lib/server/siws";

export function accountParams(params: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(params).some((key) => !allowed.includes(key))) {
    throw new SiwsError(400, "Unsupported account field");
  }
}

export function accountDisplayName(value: unknown): string {
  if (typeof value !== "string") throw new SiwsError(400, "Enter a display name");
  const name = value.trim();
  if (name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new SiwsError(400, "Display name must be at most 100 characters");
  }
  return name;
}

/** A practical ASCII mailbox format; delivery establishes ownership. */
export function accountEmail(value: unknown): string {
  if (typeof value !== "string") throw new SiwsError(400, "Enter a valid email address");
  const email = value.trim().toLowerCase();
  const parts = email.split("@");
  const local = parts[0] ?? "";
  const domain = parts[1] ?? "";
  if (parts.length !== 2 || email.length > 254 || local.length < 1 || local.length > 64 ||
      !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.startsWith(".") ||
      local.endsWith(".") || local.includes("..") || domain.length > 253 ||
      !domain.includes(".") || domain.split(".").some((label) =>
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new SiwsError(400, "Enter a valid email address");
  }
  return email;
}

export function accountEmailToken(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new SiwsError(400, "This verification link is invalid or expired");
  }
  return value;
}
