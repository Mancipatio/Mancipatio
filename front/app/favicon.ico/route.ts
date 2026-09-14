import { brandIcon } from "@/lib/brand-icon";

export const dynamic = "force-static";
export const runtime = "nodejs";

/** A PNG-backed ICO keeps legacy browser requests on the same brand mark. */
export async function GET() {
  const png = new Uint8Array(await (await brandIcon(32)).arrayBuffer());
  const ico = new Uint8Array(22 + png.byteLength);
  const header = new DataView(ico.buffer);
  header.setUint16(2, 1, true);
  header.setUint16(4, 1, true);
  header.setUint8(6, 32);
  header.setUint8(7, 32);
  header.setUint16(10, 1, true);
  header.setUint16(12, 32, true);
  header.setUint32(14, png.byteLength, true);
  header.setUint32(18, 22, true);
  ico.set(png, 22);
  return new Response(ico, {
    headers: { "Content-Type": "image/x-icon", "Cache-Control": "public, max-age=86400" },
  });
}
