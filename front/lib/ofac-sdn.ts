// The US Treasury OFAC SDN list (Specially Designated Nationals), the
// baseline sanctions list the platform screens wallets against without a
// paid provider (8.5; lib/server/sanctions.ts).
//
// Source: the Sanctions List Service's SDN.XML (OFAC_SDN_XML_URL; it
// redirects to a signed download). Checked 2026-09-28: the file is ~29 MB,
// <publshInformation> carries Publish_Date (MM/DD/YYYY) and Record_Count,
// and each <sdnEntry> lists digital-currency addresses in its <idList> as
//   <id><uid>…</uid><idType>Digital Currency Address - SOL</idType>
//       <idNumber>42RL…yoHi</idNumber></id>
// (the currency tag after " - ": XBT, ETH, USDT, TRX, SOL, USDC, …). The
// abbreviated CSV (SDN.CSV) truncates long remarks and lists fewer of them,
// so the XML is the one read.
//
// What counts as a Solana address: every "SOL" entry that is a valid
// base58 32-byte key, and an address under any other tag that is one too (a
// Solana USDC or USDT address is listed under that token's tag). Anything
// else (EVM, Tron, Bitcoin, a malformed SOL entry) is skipped and counted.
//
// Pure: a regex scan without an XML dependency. It refuses a file that does
// not end with </sdnList> or whose entry count differs from Record_Count, so
// a truncated download never replaces the list.
import { isAddress } from "@solana/kit";

export const OFAC_SDN_XML_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML";
export const OFAC_SDN_SOURCE = "ofac-sdn";
export const OFAC_SDN_HIT_LIST = "OFAC SDN";

export type SanctionedAddress = {
  address: string;
  /** The list's currency tag ("SOL", "USDC", …). */
  currency: string;
  entryUid: string;
  entryName: string;
  programs: string[];
};

export type ParsedSdnList = {
  /** YYYY-MM-DD. */
  publishedOn: string;
  recordCount: number;
  addresses: SanctionedAddress[];
  /** Digital-currency entries that are not Solana addresses (EVM, Tron, Bitcoin, malformed). */
  skipped: number;
};

/** A list file the parser refuses; `code` is what the refresh records. */
export class SdnListFormatError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SdnListFormatError";
    this.code = code;
  }
}

const DIGITAL_CURRENCY = "Digital Currency Address - ";

function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function tag(block: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  return match ? decodeXml(match[1]).trim() : null;
}

/** The entry's own fields: everything before its first nested list. */
function entryHead(entry: string): string {
  const cut = entry.search(/<(programList|idList|akaList|addressList)>/);
  return cut === -1 ? entry : entry.slice(0, cut);
}

export function parseSdnXml(xml: string): ParsedSdnList {
  const text = xml.replace(/^﻿/, "");
  if (!/<\/sdnList>\s*$/.test(text)) {
    throw new SdnListFormatError("TRUNCATED", "The SDN list does not end with </sdnList> (truncated download?)");
  }
  const info = tag(text, "publshInformation") ?? tag(text, "publishInformation");
  const date = info ? /<Publish_Date>(\d{2})\/(\d{2})\/(\d{4})<\/Publish_Date>/.exec(info) : null;
  const count = info ? /<Record_Count>(\d{1,7})<\/Record_Count>/.exec(info) : null;
  if (!date || !count) {
    throw new SdnListFormatError("NO_PUBLISH_INFO", "The SDN list has no Publish_Date / Record_Count");
  }
  const [, month, day, year] = date;
  const publishedOn = `${year}-${month}-${day}`;
  if (Number.isNaN(Date.parse(`${publishedOn}T00:00:00Z`))) {
    throw new SdnListFormatError("NO_PUBLISH_INFO", "The SDN list's Publish_Date is not a date");
  }
  const recordCount = Number(count[1]);

  const addresses = new Map<string, SanctionedAddress>();
  let entries = 0;
  let skipped = 0;
  for (const match of text.matchAll(/<sdnEntry>([\s\S]*?)<\/sdnEntry>/g)) {
    entries++;
    const entry = match[1];
    if (!entry.includes(DIGITAL_CURRENCY)) continue;
    const head = entryHead(entry);
    const entryUid = tag(head, "uid") ?? "";
    const name = [tag(head, "firstName"), tag(head, "lastName")].filter(Boolean).join(" ");
    const programList = tag(entry, "programList") ?? "";
    const programs = [...programList.matchAll(/<program>([\s\S]*?)<\/program>/g)].map((p) => decodeXml(p[1]).trim()).filter(Boolean);
    const idList = tag(entry, "idList") ?? "";
    for (const id of idList.matchAll(/<id>([\s\S]*?)<\/id>/g)) {
      const idType = tag(id[1], "idType") ?? "";
      if (!idType.startsWith(DIGITAL_CURRENCY)) continue;
      const currency = idType.slice(DIGITAL_CURRENCY.length).trim().toUpperCase();
      const address = (tag(id[1], "idNumber") ?? "").trim();
      if (!/^[A-Z0-9]{1,12}$/.test(currency) || !isAddress(address)) {
        skipped++;
        continue;
      }
      // The first entry that lists an address names it.
      if (!addresses.has(address)) {
        addresses.set(address, { address, currency, entryUid, entryName: name.slice(0, 300), programs });
      }
    }
  }
  if (entries !== recordCount) {
    throw new SdnListFormatError(
      "RECORD_COUNT_MISMATCH",
      `The SDN list has ${entries} entries, its header says ${recordCount}`,
    );
  }
  return { publishedOn, recordCount, addresses: [...addresses.values()], skipped };
}
