import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";
export const alt = "Manci — on-chain tokenization on Solana";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OG() {
  const logo = await readFile(join(process.cwd(), "public/brand/manci-logo.png"));

  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "space-between",
          background: "#082c23",
          border: "20px solid #51856b",
          padding: "44px 80px",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        {/* ImageResponse renders native images from embedded data. */}
        <img src={`data:image/png;base64,${logo.toString("base64")}`} alt="Manci" width={300} height={300 * 730 / 1320} />

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div
            style={{
              display: "flex",
              fontSize: 52,
              lineHeight: 1.05,
              color: "#f1f7f1",
              fontWeight: 600,
              maxWidth: 1000,
              letterSpacing: -1.5,
            }}
          >
            On-chain tokenization on Solana.
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 24,
              color: "#b3c9bd",
              maxWidth: 900,
              lineHeight: 1.3,
            }}
          >
            Issue, custody, trade and vest real-world assets with a
            verified-issuer registry and a custody-vault primitive.
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            fontSize: 18,
            color: "#afc9bb",
          }}
        >
          <div
            style={{
              padding: "6px 14px",
              borderRadius: 999,
              background: "#234e3d",
              color: "#c8e4d2",
              border: "1px solid #51856b",
              fontWeight: 600,
              fontSize: 14,
              letterSpacing: 2,
            }}
          >
            DEVNET
          </div>
          <div>mancipatio.io</div>
        </div>
      </div>
    ),
    size,
  );
}
