/**
 * TEST document files, built locally with no dependencies (design-sim §2):
 * one-page PDF 1.4 files and PNG images (zlib), 20–150 KB each, every one
 * visibly stamped "TEST DOCUMENT – NOT A REAL ID" with the user number, the
 * document kind, the run id and the upload round. Dossiers the owner is asked
 * to reject also carry "PLEASE REJECT". The size comes from a seeded filler
 * (an unreferenced PDF stream, a PNG tEXt chunk), so a resume regenerates
 * the exact same bytes.
 *
 * The edge cohort's invalid files (.txt, HEIC, empty, 5 MB) are here too.
 */
import { deflateSync } from "node:zlib";
import { DOC_MAX_BYTES, DOC_MIN_BYTES, VERCEL_BODY_CAP, WATERMARK, WATERMARK_ASCII } from "./constants";
import { nnn, prng } from "./identity";

export type SimDoc = { bytes: Uint8Array; name: string; type: string };

export type DocSpec = {
  runId: string;
  n: number;
  kind: string;
  /** 1 for the first upload, 2+ for replacements after a rejection or a new request. */
  round: number;
  reject: boolean;
};

/** Kinds uploaded as PNG images: selfies always, passports for odd user numbers. */
export function docFormat(kind: string, n: number): "png" | "pdf" {
  if (kind === "selfie") return "png";
  if (kind === "passport" && n % 2 === 1) return "png";
  return "pdf";
}

export function docTargetSize(spec: DocSpec): number {
  const rand = prng("sim-doc-size", spec.runId, spec.n, spec.kind, spec.round);
  return DOC_MIN_BYTES + Math.floor(rand() * (DOC_MAX_BYTES - DOC_MIN_BYTES));
}

function docLines(spec: DocSpec): string[] {
  return [
    WATERMARK_ASCII,
    "MANCI DEVNET SIMULATION",
    `SIM-${nnn(spec.n)} ${spec.kind.toUpperCase().replace(/_/g, " ")}`,
    `RUN ${spec.runId.toUpperCase()} V${spec.round}`,
    ...(spec.reject ? ["PLEASE REJECT"] : []),
  ];
}

export function simDocument(spec: DocSpec): SimDoc {
  const target = docTargetSize(spec);
  const base = `sim-${nnn(spec.n)}-${spec.kind}-v${spec.round}`;
  if (docFormat(spec.kind, spec.n) === "png") {
    return { bytes: buildPng(docLines(spec), target, spec), name: `${base}.png`, type: "image/png" };
  }
  return { bytes: buildPdf(spec, target), name: `${base}.pdf`, type: "application/pdf" };
}

/** Deterministic printable filler (does not compress, so the size is exact). */
function filler(length: number, ...seed: (string | number)[]): Buffer {
  const rand = prng("sim-doc-filler", ...seed);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const out = Buffer.alloc(Math.max(0, length));
  for (let i = 0; i < out.length; i++) out[i] = alphabet.charCodeAt(Math.floor(rand() * 32));
  return out;
}

// ── PDF 1.4 ─────────────────────────────────────────────────────────────────

function pdfString(text: string): string {
  // WinAnsiEncoding: the en dash is byte 0x96 (octal 226).
  return `(${text.replace(/[\\()]/g, (c) => `\\${c}`).replace(/–/g, "\\226")})`;
}

export function buildPdf(spec: DocSpec, targetSize: number): Uint8Array {
  const lines = docLines(spec);
  const ops: string[] = ["BT", "/F1 26 Tf", "0.75 0 0 rg", "50 770 Td", `${pdfString(WATERMARK)} Tj`, "ET"];
  let y = 730;
  for (const line of lines.slice(1)) {
    const red = line === "PLEASE REJECT";
    ops.push("BT", `/F1 ${red ? 30 : 16} Tf`, red ? "0.85 0 0 rg" : "0 0 0 rg", `50 ${y} Td`, `${pdfString(line)} Tj`, "ET");
    y -= red ? 40 : 26;
  }
  // A light diagonal watermark across the page.
  for (let row = 0; row < 12; row++) {
    ops.push("BT", "/F1 18 Tf", "0.85 0.85 0.85 rg", `0.866 0.5 -0.5 0.866 ${20 + row * 10} ${40 + row * 55} Tm`, `${pdfString(WATERMARK)} Tj`, "ET");
  }
  const content = ops.join("\n");
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "latin1"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "latin1"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>", "latin1"),
    Buffer.concat([Buffer.from(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n`, "latin1"), Buffer.from(content, "latin1"), Buffer.from("\nendstream", "latin1")]),
    Buffer.from(`<< /Title ${pdfString(WATERMARK)} /Subject ${pdfString(lines.slice(1).join(" / "))} /Producer (manci-sim) >>`, "latin1"),
  ];
  const assemble = (padding: number): Buffer => {
    const all = [...objects];
    // Object 7: an unreferenced stream that brings the file to its seeded size.
    const pad = filler(padding, spec.runId, spec.n, spec.kind, spec.round);
    all.push(Buffer.concat([Buffer.from(`<< /Length ${pad.length} >>\nstream\n`, "latin1"), pad, Buffer.from("\nendstream", "latin1")]));
    const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    const offsets: number[] = [];
    let offset = chunks[0].length;
    all.forEach((body, i) => {
      const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
      offsets.push(offset);
      chunks.push(obj);
      offset += obj.length;
    });
    const xref = [`xref\n0 ${all.length + 1}\n`, "0000000000 65535 f \n", ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
    chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${all.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${offset}\n%%EOF\n`, "latin1"));
    return Buffer.concat(chunks);
  };
  const bare = assemble(0).length;
  // The padding length changes the digits of later offsets by at most a few bytes; settle it.
  let pad = Math.max(0, targetSize - bare);
  let out = assemble(pad);
  for (let i = 0; i < 3 && out.length !== targetSize && pad > 0; i++) {
    pad = Math.max(0, pad + (targetSize - out.length));
    out = assemble(pad);
  }
  return new Uint8Array(out);
}

// ── PNG (RGB, 8 bit) with a 5×7 bitmap font ─────────────────────────────────

/** Rows top to bottom, bit 4 = leftmost pixel. */
const FONT: Record<string, number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 17, 10, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14], "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [31, 2, 4, 2, 1, 17, 14], "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14],
  "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8], "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 2, 12], " ": [0, 0, 0, 0, 0, 0, 0], "-": [0, 0, 0, 31, 0, 0, 0],
  ".": [0, 0, 0, 0, 0, 12, 12], ":": [0, 12, 12, 0, 12, 12, 0], "/": [0, 1, 2, 4, 8, 16, 0],
  "?": [14, 17, 1, 2, 4, 0, 4],
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function buildPng(lines: string[], targetSize: number, seed: DocSpec): Uint8Array {
  const width = 600;
  const height = 380;
  const px = Buffer.alloc(width * height * 3, 0xf4);
  const set = (x: number, y: number, rgb: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 3;
    px[i] = rgb[0];
    px[i + 1] = rgb[1];
    px[i + 2] = rgb[2];
  };
  const text = (value: string, x0: number, y0: number, scale: number, rgb: [number, number, number]) => {
    [...value.toUpperCase()].forEach((ch, index) => {
      const glyph = FONT[ch] ?? FONT["?"];
      glyph.forEach((row, gy) => {
        for (let gx = 0; gx < 5; gx++) {
          if (!(row & (16 >> gx))) continue;
          for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) set(x0 + index * 6 * scale + gx * scale + dx, y0 + gy * scale + dy, rgb);
        }
      });
    });
  };
  // Red frame, then the stamp lines.
  const frame: [number, number, number] = [190, 20, 20];
  for (let t = 0; t < 6; t++) {
    for (let x = 0; x < width; x++) {
      set(x, t, frame);
      set(x, height - 1 - t, frame);
    }
    for (let y = 0; y < height; y++) {
      set(t, y, frame);
      set(width - 1 - t, y, frame);
    }
  }
  text(lines[0], 20, 30, 3, frame);
  let y = 90;
  for (const line of lines.slice(1)) {
    const reject = line === "PLEASE REJECT";
    text(line, 20, y, reject ? 5 : 3, reject ? [200, 0, 0] : [30, 30, 30]);
    y += reject ? 50 : 36;
  }
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row++) {
    raw[row * (width * 3 + 1)] = 0; // filter: none
    px.copy(raw, row * (width * 3 + 1) + 1, row * width * 3, (row + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, deflate, no filter set, no interlace
  const parts = [PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 }))];
  const title = chunk("tEXt", Buffer.from(`Title\0${lines.join(" / ")}`, "latin1"));
  const iend = chunk("IEND", Buffer.alloc(0));
  const used = parts.reduce((s, b) => s + b.length, 0) + title.length + iend.length;
  const padLength = targetSize - used - 12 - "Comment\0".length;
  const pad = padLength > 0 ? [chunk("tEXt", Buffer.concat([Buffer.from("Comment\0", "latin1"), filler(padLength, seed.runId, seed.n, seed.kind, seed.round)]))] : [];
  return new Uint8Array(Buffer.concat([...parts, title, ...pad, iend]));
}

// ── Edge-cohort files ───────────────────────────────────────────────────────

export function edgeFile(kind: "txt" | "heic" | "empty" | "oversize", runId: string, n: number): SimDoc {
  const base = `sim-${nnn(n)}-edge`;
  switch (kind) {
    case "txt":
      return { bytes: new TextEncoder().encode(`${WATERMARK_ASCII}\nSIM-${nnn(n)} run ${runId}\n`), name: `${base}.txt`, type: "text/plain" };
    case "heic": {
      // An ISO-BMFF "ftyp heic" header; the route must refuse the type before reading it.
      const head = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63]);
      return { bytes: new Uint8Array(Buffer.concat([head, filler(4_096, runId, n, "heic")])), name: `${base}.heic`, type: "image/heic" };
    }
    case "empty":
      return { bytes: new Uint8Array(0), name: `${base}-empty.pdf`, type: "application/pdf" };
    case "oversize":
      // Above the Vercel body cap (4.5 MB) but below the route's own 15 MB limit.
      return {
        bytes: buildPdf({ runId, n, kind: "oversize", round: 1, reject: true }, 5 * 1024 * 1024),
        name: `${base}-5mb.pdf`,
        type: "application/pdf",
      };
  }
}

export const OVERSIZE_EXCEEDS_VERCEL_CAP = 5 * 1024 * 1024 > VERCEL_BODY_CAP;
