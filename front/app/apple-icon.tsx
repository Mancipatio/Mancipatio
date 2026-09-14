import { brandIcon } from "@/lib/brand-icon";

export const runtime = "nodejs";
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default async function AppleIcon() {
  return brandIcon(size.width);
}
