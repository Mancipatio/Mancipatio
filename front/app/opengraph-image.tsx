import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectNetwork, isTestNetwork, networkLabel } from "@/lib/network";

// The site's share card (og:image, and the Twitter card's image through the
// root layout's twitter defaults), generated at build time with next/og from
// the brand mark (public/brand/manci-mark.png, the mark of app/icon.tsx).
// Every page inherits it. The copy is the landing page's own (app/page.tsx:
// its heading and lead): what Manci is, never a module that may be switched
// off on this network.
export const runtime = "nodejs";
export const alt = "Manci: company shares tokenized on Solana, from token to registered owner";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** public/brand/manci-mark.png is 622 × 442. */
const MARK_HEIGHT = 112;
const MARK_WIDTH = Math.round((MARK_HEIGHT * 622) / 442);

export default async function OG() {
  const mark = await readFile(join(process.cwd(), "public/brand/manci-mark.png"));
  // The stage pill marks a test deployment; mainnet cards carry no pill.
  const network = detectNetwork();
  const stagePill = isTestNetwork(network) ? networkLabel(network).toUpperCase() : null;

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
          padding: "52px 80px 44px",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          {/* ImageResponse renders native images from embedded data. */}
          <img src={`data:image/png;base64,${mark.toString("base64")}`} alt="" width={MARK_WIDTH} height={MARK_HEIGHT} />
          <div style={{ display: "flex", fontSize: 44, letterSpacing: 18, color: "#f1f7f1" }}>MANCI</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div
            style={{
              display: "flex",
              fontSize: 64,
              lineHeight: 1.05,
              color: "#f1f7f1",
              fontWeight: 600,
              maxWidth: 1000,
              letterSpacing: -1.5,
            }}
          >
            From token to registered owner.
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 30,
              color: "#b3c9bd",
              maxWidth: 900,
              lineHeight: 1.3,
            }}
          >
            Company shares tokenized on Solana.
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            fontSize: 20,
            color: "#afc9bb",
          }}
        >
          {stagePill && (
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
              {stagePill}
            </div>
          )}
          <div>manci.io</div>
        </div>
      </div>
    ),
    size,
  );
}
