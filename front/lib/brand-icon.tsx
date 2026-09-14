import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function brandIcon(size: number) {
  const mark = await readFile(join(process.cwd(), "public/brand/mancipatio-mark.png"));

  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#082c23", borderRadius: size * 0.22 }}>
      {/* ImageResponse renders native images from embedded data. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`data:image/png;base64,${mark.toString("base64")}`} alt="" width={size * 0.88} height={size * 0.88 * 330 / 622} />
    </div>,
    { width: size, height: size },
  );
}
