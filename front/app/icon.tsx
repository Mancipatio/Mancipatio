import { brandIcon } from "@/lib/brand-icon";

export const runtime = "nodejs";
export const size = { width: 256, height: 256 };
export const contentType = "image/png";

export default async function Icon() {
  return brandIcon(size.width);
}
