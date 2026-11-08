// Certificates of tokenized interest: the payload (schema manci.certificate.v1),
// its statement text, the message the admin's wallet signs, the admin's input
// and the public projection.
//
// A certificate states on-chain facts at one slot, signed by an admin's
// wallet and anchored on chain:
//   * kind "holding": the units of one share class a wallet held, and the
//     share of the company they stand for;
//   * kind "issuance": the share class as issued (maximum supply, units
//     issued to date, units in circulation).
// The server builds the payload (lib/server/certificates.ts) from the chain
// (asset, share class, balances, supply, slot), the operator record
// (lib/legal/operator.ts) and what the admin typed or corrected (the
// company's legal name, registration number and address, the scale, the
// holder's name and ID number, evidence transactions). The payload is hashed
// in its canonical form (lib/certificates/canonical.ts); the wallet signs
// certificateMessage(number, hash); the Super Admin anchors
// "<number> sha256:<hash>" in a memo (lib/document-anchor.ts).
//
// Every amount and slot is a decimal string (u64). Percentages are decimal
// strings with at most 8 decimals; "..._rounded" says whether the exact value
// needed more and was rounded half up. A random 128-bit salt is part of the
// payload: the hash is public (on chain and on the verification page), and
// without the salt a guess at a holder's name or ID number could be tested
// against it.
//
// Personal data: holder.name and holder.id_number, typed by the admin for one
// certificate, appear only in the payload, which only admins read, and on the
// printed certificate. publicCertificateView never copies them, nor the
// revocation reason (free text), nor who created or revoked the row.
//
// Pure and directive-free: the server, the admin pages and the public
// verification page share it (tests/certificate-payload.test.ts).

import { isAddress, isSignature } from "@solana/kit";
import { canonicalStringProblem, isCanonicalJson } from "@/lib/certificates/canonical";
import { operatorFor } from "@/lib/legal/operator";
import { isTestNetwork, networkLabel, type Network } from "@/lib/network";
import { isSiwsSignatureFormat, type SiwsSignatureFormat } from "@/lib/siws-offchain";

export const CERTIFICATE_SCHEMA = "manci.certificate.v1";
export const CERTIFICATE_KINDS = ["holding", "issuance"] as const;
export type CertificateKind = (typeof CERTIFICATE_KINDS)[number];
export const CERTIFICATE_STATUSES = ["draft", "signed", "anchored", "revoked"] as const;
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

/** "MC-2026-0001": the year, then at least four digits (0087's allocator). */
export const CERTIFICATE_NUMBER_PATTERN = /^MC-\d{4}-\d{4,6}$/;
export const CERTIFICATE_SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** The first line of the message the admin's wallet signs. */
export const CERTIFICATE_MESSAGE_HEADER = "Manci certificate v1";
/** The salt: 16 random bytes, lowercase hex. */
export const CERTIFICATE_SALT_PATTERN = /^[0-9a-f]{32}$/;
/** At most this many evidence transactions per certificate. */
export const CERTIFICATE_MAX_EVIDENCE = 10;
/** Largest stored canonical payload, in UTF-16 code units (0087 caps the column at 32,768). */
export const CERTIFICATE_MAX_PAYLOAD_CHARS = 32_768;
export const U64_MAX = BigInt("18446744073709551615");

/** The programs a certificate names as its evidence (the mainnet program IDs are the same on every network). */
export const CERTIFICATE_PROGRAMS = {
  assetRegistry: "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS",
  transferHook: "GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
} as const;

// ── The payload ─────────────────────────────────────────────────────────────

export type CertificateCompany = {
  legal_name: string;
  registration_number: string;
  address: string;
};

export type CertificatePayload = {
  schema: typeof CERTIFICATE_SCHEMA;
  network: Network;
  number: string;
  kind: CertificateKind;
  /** ISO 8601, UTC, milliseconds (the moment the server built the payload). */
  issued_at: string;
  salt: string;
  operator: {
    brand: string;
    legal_name: string | null;
    registered_office: string | null;
    registration_number: string | null;
    registration_number_label: string | null;
    register: string | null;
  };
  company: CertificateCompany;
  asset: {
    asset_id: string;
    name: string;
    symbol: string;
    asset_pda: string;
    issuer_pda: string;
    /** SHA-256 of the legal documentation, as the registry records it (hex). */
    legal_doc_hash: string;
  };
  share_class: {
    class_index: number;
    share_class_pda: string;
    mint: string;
    /** null: the class has no cap. */
    max_supply: string | null;
    units_for_100_percent: string;
    unit_percent: string;
    unit_percent_rounded: boolean;
  };
  /** kind "holding" only. */
  holder: { wallet: string; name: string | null; id_number: string | null } | null;
  /** kind "holding" only. */
  holding: {
    units: string;
    percent_of_company: string;
    percent_of_company_rounded: boolean;
    slot: string;
    commitment: "finalized";
  } | null;
  /** kind "issuance" only. */
  supply: {
    max_supply_percent: string | null;
    max_supply_percent_rounded: boolean;
    lifetime_minted: string;
    circulating: string;
    circulating_percent: string;
    circulating_percent_rounded: boolean;
    slot: string;
    commitment: "finalized";
  } | null;
  chain_evidence: {
    asset_registry_program: string;
    transfer_hook_program: string;
    token_program: string;
    transactions: Array<{ signature: string; slot: string; note: string | null }>;
  };
  statement: string;
  signer: { public_key: string };
};

/** What the server read from the chain for one certificate (lib/server/certificates.ts). */
export type CertificateChainFacts = {
  asset: {
    address: string;
    assetId: string;
    name: string;
    symbolPrefix: string;
    /** 64 lowercase hex. */
    legalDocHash: string;
    issuer: string;
  };
  shareClass: {
    address: string;
    classIndex: number;
    mint: string;
    maxSupply: bigint | null;
    lifetimeMinted: bigint;
  };
  /** kind "holding": the wallet's units of the mint, summed over its token accounts, and the slot of the read. */
  holding: { units: bigint; slot: bigint } | null;
  /** kind "issuance": the mint's supply and the slot of the read. */
  supply: { circulating: bigint; slot: bigint } | null;
};

export type CertificateEvidence = { signature: string; slot: string; note: string | null };

export type BuildCertificateInput = {
  network: Network;
  number: string;
  kind: CertificateKind;
  issuedAt: Date;
  salt: string;
  company: CertificateCompany;
  unitsFor100Percent: bigint;
  holder: { wallet: string; name: string | null; idNumber: string | null } | null;
  evidence: CertificateEvidence[];
  chain: CertificateChainFacts;
  signer: string;
};

/** Format (bidi controls, zero-width characters) and control characters: never in a certificate's text. */
const INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/** Length in characters (code points), as Postgres counts it, not UTF-16 units. */
const characters = (value: string) => Array.from(value).length;

export class CertificateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CertificateInputError";
  }
}

/**
 * units × 100 / whole as a decimal string with at most 8 decimals, rounded
 * half up, without trailing zeros; `rounded` when the exact value needed more
 * decimals. BigInt only, never a float.
 */
export function percentOf(units: bigint, whole: bigint): { percent: string; rounded: boolean } {
  if (whole <= BigInt(0)) throw new CertificateInputError("The scale must be more than 0 units.");
  if (units < BigInt(0)) throw new CertificateInputError("Units cannot be negative.");
  const scale = BigInt(100_000_000);
  const numerator = units * BigInt(100) * scale;
  let quotient = numerator / whole;
  const remainder = numerator % whole;
  if (remainder * BigInt(2) >= whole) quotient += BigInt(1);
  const digits = quotient.toString().padStart(9, "0");
  const integer = digits.slice(0, -8).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(-8).replace(/0+$/, "");
  return { percent: fraction ? `${integer}.${fraction}` : integer, rounded: remainder !== BigInt(0) };
}

/** 10000n → "10,000" (display only). */
export function formatUnits(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The program's cap on a mint's metadata symbol, in UTF-8 bytes (initialize_share_class_mint). */
const MINT_SYMBOL_MAX_BYTES = 10;

/**
 * The token symbol the program wrote at mint creation: "<symbol prefix><class
 * index>", cut to 10 UTF-8 bytes without splitting a character (the
 * program's truncate_utf8; lib/tokenize-shares.ts has the same cut for the
 * issuer's preview, kept out of this module so the public page stays small).
 */
export function certificateTokenSymbol(symbolPrefix: string, classIndex: number): string {
  const encoder = new TextEncoder();
  let out = "";
  let used = 0;
  for (const ch of `${symbolPrefix}${classIndex}`) {
    const bytes = encoder.encode(ch).length;
    if (used + bytes > MINT_SYMBOL_MAX_BYTES) break;
    out += ch;
    used += bytes;
  }
  return out;
}

/**
 * A string read from the chain (the asset's name and ID, the symbol prefix),
 * as a certificate states it: NFC (the same text to a reader), and refused
 * when it holds a control or format character, which the issuer could have
 * written on chain but a signed, printed statement must not carry (a bidi
 * override would make the printout read differently from what is signed).
 */
export function certificateChainText(value: string, label: string): string {
  const text = value.normalize("NFC");
  if (INVISIBLE.test(text) || canonicalStringProblem(text)) {
    throw new CertificateInputError(`${label} on chain contains an invisible or control character, which a certificate cannot state.`);
  }
  return text;
}

/** The operator's name as a certificate states it. */
export function certificateOperatorName(network: Network): string {
  const operator = operatorFor(network);
  return operator.legalName?.trim() || `${operator.brand} (the devnet pilot, which no designated legal entity operates yet)`;
}

const TEST_NETWORK_PREFIX =
  "TEST NETWORK: this certificate has no legal effect, and the tokens it names have no economic value. ";

function unitsText(units: bigint): string {
  return `${formatUnits(units)} ${units === BigInt(1) ? "unit" : "units"}`;
}

function percentText(value: { percent: string; rounded: boolean }): string {
  return `${value.percent} %${value.rounded ? " (rounded to 8 decimal places)" : ""}`;
}

function readAt(network: Network, slot: bigint, issuedAt: string): string {
  const [date, time] = issuedAt.split("T");
  return `according to the Solana ${networkLabel(network)} ledger read with finalized commitment at slot ${slot.toString()} on ${date} at ${time.slice(0, 8)} UTC`;
}

function companyText(company: CertificateCompany): string {
  return `${company.legal_name}, registration number ${company.registration_number}, ${company.address}`;
}

const RIGHTS_SENTENCE =
  "The rights attached to the units are those set out in the asset's legal documentation, whose SHA-256 the registry records";

/**
 * The statement a certificate makes, from its facts. Fixed per kind: a change
 * of wording here applies to certificates issued afterwards only (each
 * payload carries its own text, under its own hash).
 */
export function certificateStatement(payload: Omit<CertificatePayload, "statement">): string {
  const prefix = isTestNetwork(payload.network) ? TEST_NETWORK_PREFIX : "";
  const operator = `${payload.operator.legal_name ?? certificateOperatorName(payload.network)}, the operator of the Manci platform,`;
  const scale = BigInt(payload.share_class.units_for_100_percent);
  const asset = `share class ${payload.share_class.class_index} of the asset ${payload.asset.asset_id} "${payload.asset.name}" recorded by the Manci asset registry program`;
  const rights = /^0{64}$/.test(payload.asset.legal_doc_hash)
    ? "The rights attached to the units are those set out in the asset's legal documentation (the registry records no document hash for this asset)."
    : `${RIGHTS_SENTENCE} (${payload.asset.legal_doc_hash}).`;
  const notRegister = "This certificate states on-chain facts at the slot above; it is not an extract from a company register";
  if (payload.kind === "holding") {
    if (!payload.holder || !payload.holding) throw new CertificateInputError("A holding certificate needs its holder and holding.");
    const { holder, holding } = payload;
    const details = [holder.name, holder.id_number ? `identification number ${holder.id_number}` : null].filter(Boolean);
    const named = details.length > 0 ? ` (holder: ${details.join(", ")}, as given to the operator)` : "";
    const units = BigInt(holding.units);
    return (
      `${prefix}${operator} certifies that, ${readAt(payload.network, BigInt(holding.slot), payload.issued_at)}, ` +
      `the wallet ${holder.wallet}${named} held ${unitsText(units)} of ${payload.asset.symbol} (token mint ${payload.share_class.mint}), ${asset}. ` +
      `The asset concerns ${companyText(payload.company)}; ${formatUnits(scale)} units stand for 100 % of that company, ` +
      `so the units held stand for ${percentText({ percent: holding.percent_of_company, rounded: holding.percent_of_company_rounded })} of it. ` +
      `${rights} ${notRegister} and does not by itself transfer or register any interest.`
    );
  }
  if (!payload.supply) throw new CertificateInputError("An issuance certificate needs its supply.");
  const { supply } = payload;
  const max = payload.share_class.max_supply;
  const maxText = max === null
    ? "no maximum supply"
    : `a maximum supply of ${unitsText(BigInt(max))} (${percentText({ percent: supply.max_supply_percent ?? "", rounded: supply.max_supply_percent_rounded })} of the company)`;
  return (
    `${prefix}${operator} certifies that, ${readAt(payload.network, BigInt(supply.slot), payload.issued_at)}, ` +
    `${asset} has the token mint ${payload.share_class.mint} (${payload.asset.symbol}), ${maxText}, ` +
    `${unitsText(BigInt(supply.lifetime_minted))} issued to date and ${unitsText(BigInt(supply.circulating))} in circulation. ` +
    `The asset concerns ${companyText(payload.company)}; ${formatUnits(scale)} units stand for 100 % of that company, ` +
    `so the units in circulation stand for ${percentText({ percent: supply.circulating_percent, rounded: supply.circulating_percent_rounded })} of it. ` +
    `${rights} ${notRegister}.`
  );
}

/**
 * The payload of one certificate. Throws CertificateInputError when the facts
 * do not make a certificate (a holding without units, more units held or in
 * circulation than the scale, a class larger than the whole company, an
 * on-chain name with invisible characters, an invalid field).
 */
export function buildCertificatePayload(input: BuildCertificateInput): CertificatePayload {
  if (!CERTIFICATE_NUMBER_PATTERN.test(input.number)) throw new CertificateInputError("Invalid certificate number.");
  if (!CERTIFICATE_SALT_PATTERN.test(input.salt)) throw new CertificateInputError("Invalid certificate salt.");
  if (Number.isNaN(input.issuedAt.getTime())) throw new CertificateInputError("Invalid issue time.");
  if (!isAddress(input.signer)) throw new CertificateInputError("Invalid signer.");
  const { chain, kind } = input;
  const scale = input.unitsFor100Percent;
  if (scale <= BigInt(0) || scale > U64_MAX) throw new CertificateInputError("The scale (units for 100 %) must be a whole number from 1 to 2^64 − 1.");
  if (chain.shareClass.maxSupply !== null && chain.shareClass.maxSupply > scale) {
    throw new CertificateInputError(
      `The class's maximum supply (${formatUnits(chain.shareClass.maxSupply)}) is more than the scale (${formatUnits(scale)} units for 100 %): check the scale.`,
    );
  }
  if (input.evidence.length > CERTIFICATE_MAX_EVIDENCE) throw new CertificateInputError(`At most ${CERTIFICATE_MAX_EVIDENCE} evidence transactions.`);
  const operator = operatorFor(input.network);
  const unit = percentOf(BigInt(1), scale);
  let holder: CertificatePayload["holder"] = null;
  let holding: CertificatePayload["holding"] = null;
  let supply: CertificatePayload["supply"] = null;
  if (kind === "holding") {
    if (!input.holder || !chain.holding) throw new CertificateInputError("A holding certificate needs the holder's wallet and its balance.");
    if (chain.holding.units <= BigInt(0)) throw new CertificateInputError("This wallet holds no units of the class: there is nothing to certify.");
    if (chain.holding.units > scale) throw new CertificateInputError("The wallet holds more units than the scale counts for 100 %: check the scale.");
    const pct = percentOf(chain.holding.units, scale);
    holder = { wallet: input.holder.wallet, name: input.holder.name, id_number: input.holder.idNumber };
    holding = {
      units: chain.holding.units.toString(),
      percent_of_company: pct.percent,
      percent_of_company_rounded: pct.rounded,
      slot: chain.holding.slot.toString(),
      commitment: "finalized",
    };
  } else {
    if (input.holder) throw new CertificateInputError("An issuance certificate names no holder.");
    if (!chain.supply) throw new CertificateInputError("An issuance certificate needs the class's supply.");
    if (chain.supply.circulating > scale) {
      throw new CertificateInputError("More units are in circulation than the scale counts for 100 %: check the scale.");
    }
    const max = chain.shareClass.maxSupply === null ? null : percentOf(chain.shareClass.maxSupply, scale);
    const circulating = percentOf(chain.supply.circulating, scale);
    supply = {
      max_supply_percent: max?.percent ?? null,
      max_supply_percent_rounded: max?.rounded ?? false,
      lifetime_minted: chain.shareClass.lifetimeMinted.toString(),
      circulating: chain.supply.circulating.toString(),
      circulating_percent: circulating.percent,
      circulating_percent_rounded: circulating.rounded,
      slot: chain.supply.slot.toString(),
      commitment: "finalized",
    };
  }
  const draft: Omit<CertificatePayload, "statement"> = {
    schema: CERTIFICATE_SCHEMA,
    network: input.network,
    number: input.number,
    kind,
    issued_at: input.issuedAt.toISOString(),
    salt: input.salt,
    operator: {
      brand: operator.brand,
      legal_name: operator.legalName?.trim() || null,
      registered_office: operator.registeredOffice?.trim() || null,
      registration_number: operator.registrationNumber?.value.trim() || null,
      registration_number_label: operator.registrationNumber?.label.trim() || null,
      register: operator.register?.name.trim() || null,
    },
    company: input.company,
    asset: {
      asset_id: certificateChainText(chain.asset.assetId, "The asset ID"),
      name: certificateChainText(chain.asset.name, "The asset's name"),
      symbol: certificateChainText(certificateTokenSymbol(chain.asset.symbolPrefix, chain.shareClass.classIndex), "The token symbol"),
      asset_pda: chain.asset.address,
      issuer_pda: chain.asset.issuer,
      legal_doc_hash: chain.asset.legalDocHash,
    },
    share_class: {
      class_index: chain.shareClass.classIndex,
      share_class_pda: chain.shareClass.address,
      mint: chain.shareClass.mint,
      max_supply: chain.shareClass.maxSupply === null ? null : chain.shareClass.maxSupply.toString(),
      units_for_100_percent: scale.toString(),
      unit_percent: unit.percent,
      unit_percent_rounded: unit.rounded,
    },
    holder,
    holding,
    supply,
    chain_evidence: {
      asset_registry_program: CERTIFICATE_PROGRAMS.assetRegistry,
      transfer_hook_program: CERTIFICATE_PROGRAMS.transferHook,
      token_program: CERTIFICATE_PROGRAMS.token2022,
      transactions: input.evidence.map((e) => ({ signature: e.signature, slot: e.slot, note: e.note })),
    },
    signer: { public_key: input.signer },
  };
  return { ...draft, statement: certificateStatement(draft) };
}

/** The exact message the admin's wallet signs for a certificate. */
export function certificateMessage(number: string, sha256: string): string {
  if (!CERTIFICATE_NUMBER_PATTERN.test(number)) throw new CertificateInputError("Invalid certificate number.");
  if (!CERTIFICATE_SHA256_PATTERN.test(sha256)) throw new CertificateInputError("The SHA-256 must be 64 lowercase hex characters.");
  return `${CERTIFICATE_MESSAGE_HEADER}\nNumber: ${number}\nSHA-256: ${sha256}`;
}

/** A typed certificate number ("mc-2026-1", spaces around) as stored ("MC-2026-0001"), or null. */
export function normalizeCertificateNumber(raw: string): string | null {
  const match = /^MC-(\d{4})-(\d{1,6})$/.exec(raw.trim().toUpperCase());
  if (!match) return null;
  const sequence = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
  const number = `MC-${match[1]}-${sequence < 10_000 ? String(sequence).padStart(4, "0") : String(sequence)}`;
  return CERTIFICATE_NUMBER_PATTERN.test(number) ? number : null;
}

/**
 * A typed SHA-256 as 64 lowercase hex, or null: either case, an optional
 * "sha256:" before it, and a `shasum -a 256` line ("<hash>  <file>") read as
 * its hash. The public route then reads it with the stricter
 * lib/document-anchor.ts normalizeSha256Input.
 */
export function normalizeCertificateSha256(raw: string): string | null {
  const text = raw.trim();
  if (/[\r\n]/.test(text)) return null; // one hash only
  const match = /^(?:sha256:)?([0-9a-f]{64})(?:[ \t]+\S.*)?$/i.exec(text);
  return match ? match[1].toLowerCase() : null;
}

// ── The admin's input ───────────────────────────────────────────────────────

/**
 * A text field as a certificate stores it: NFC, runs of whitespace as one
 * space, trimmed; refused with a sentence naming `label` when it is shorter
 * than `min` or longer than `max` characters, or holds an invisible
 * character (a bidi override or a zero-width space could make the printed
 * text read differently from the signed one).
 */
export function certificateText(raw: unknown, label: string, min: number, max: number): string {
  if (typeof raw !== "string") throw new CertificateInputError(`${label} is required.`);
  const value = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (characters(value) < min) throw new CertificateInputError(value === "" || min <= 1 ? `${label} is required.` : `${label} needs at least ${min} characters.`);
  if (characters(value) > max) throw new CertificateInputError(`${label} is at most ${max} characters.`);
  if (INVISIBLE.test(value) || canonicalStringProblem(value)) {
    throw new CertificateInputError(`${label} contains an invisible or control character; type it again.`);
  }
  return value;
}

/** The same, null when empty or absent. */
export function optionalCertificateText(raw: unknown, label: string, min: number, max: number): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new CertificateInputError(`${label} must be text.`);
  return raw.trim() === "" ? null : certificateText(raw, label, min, max);
}

export const COMPANY_NAME_MAX = 200;
export const COMPANY_NUMBER_MAX = 64;
export const COMPANY_ADDRESS_MAX = 300;
export const HOLDER_NAME_MAX = 200;
export const HOLDER_ID_MAX = 64;
export const EVIDENCE_NOTE_MAX = 120;

export function parseCertificateCompany(raw: unknown): CertificateCompany {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CertificateInputError("The company's details are required.");
  const company = raw as Record<string, unknown>;
  return {
    legal_name: certificateText(company.legal_name, "The company's legal name", 2, COMPANY_NAME_MAX),
    registration_number: certificateText(company.registration_number, "The company's registration number", 1, COMPANY_NUMBER_MAX),
    address: certificateText(company.address, "The company's registered address", 3, COMPANY_ADDRESS_MAX),
  };
}

/** "10000" → 10000n; refuses anything but a whole number from 1 to 2^64 − 1. */
export function parseUnitsFor100Percent(raw: unknown): bigint {
  const text = typeof raw === "string" ? raw.trim().replace(/[,_\s]/g, "") : typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : "";
  if (!/^[1-9]\d{0,19}$/.test(text) || BigInt(text) > U64_MAX) {
    throw new CertificateInputError("Units for 100 % of the company must be a whole number of at least 1, e.g. 10000.");
  }
  return BigInt(text);
}

export type CertificateEvidenceInput = { signature: string; note: string | null };

/** Up to CERTIFICATE_MAX_EVIDENCE transaction signatures, each once, each with an optional note. */
export function parseCertificateEvidence(raw: unknown): CertificateEvidenceInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new CertificateInputError("Evidence must be a list of transactions.");
  if (raw.length > CERTIFICATE_MAX_EVIDENCE) throw new CertificateInputError(`At most ${CERTIFICATE_MAX_EVIDENCE} evidence transactions.`);
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new CertificateInputError(`Evidence ${i + 1} is not a transaction.`);
    const item = entry as Record<string, unknown>;
    const signature = typeof item.signature === "string" ? item.signature.trim() : "";
    if (!isSignature(signature)) throw new CertificateInputError(`Evidence ${i + 1}: enter a transaction signature (base58).`);
    if (seen.has(signature)) throw new CertificateInputError(`Evidence ${i + 1}: this transaction is listed twice.`);
    seen.add(signature);
    return { signature, note: optionalCertificateText(item.note, `Evidence ${i + 1}'s note`, 1, EVIDENCE_NOTE_MAX) };
  });
}

/** The request of the preview and create routes, narrowed field by field. */
export type CertificateRequest = {
  kind: CertificateKind;
  shareClass: string;
  wallet: string | null;
  /** null: take the prefill (preview only; create requires it). */
  company: CertificateCompany | null;
  unitsFor100Percent: bigint | null;
  holderName: string | null;
  holderIdNumber: string | null;
  evidence: CertificateEvidenceInput[];
};

/**
 * `params` of /api/admin/certificates/create (`complete` true: the company
 * and the scale are required) and /preview (`complete` false: both are left
 * null here, since the preview merges what was typed with its prefill and
 * reports what is still missing instead of refusing:
 * previewCompany / previewScale).
 */
export function parseCertificateRequest(params: Record<string, unknown>, complete: boolean): CertificateRequest {
  const kind = params.kind;
  if (kind !== "holding" && kind !== "issuance") throw new CertificateInputError("Choose the certificate's kind: holding or issuance.");
  const shareClass = typeof params.share_class === "string" ? params.share_class.trim() : "";
  if (!isAddress(shareClass)) throw new CertificateInputError("Choose a share class.");
  const walletRaw = typeof params.wallet === "string" ? params.wallet.trim() : "";
  let wallet: string | null = null;
  if (kind === "holding") {
    if (!isAddress(walletRaw)) throw new CertificateInputError("Enter the holder's wallet address.");
    wallet = walletRaw;
  } else if (walletRaw !== "" || params.holder_name || params.holder_id_number) {
    throw new CertificateInputError("An issuance certificate names no holder: leave the wallet, name and ID number empty.");
  }
  const scaleGiven = params.units_for_100_percent !== undefined && params.units_for_100_percent !== null && params.units_for_100_percent !== "";
  if (complete && !scaleGiven) throw new CertificateInputError("Enter how many units stand for 100 % of the company.");
  return {
    kind,
    shareClass,
    wallet,
    company: complete ? parseCertificateCompany(params.company) : null,
    unitsFor100Percent: complete ? parseUnitsFor100Percent(params.units_for_100_percent) : null,
    holderName: kind === "holding" ? optionalCertificateText(params.holder_name, "The holder's name", 2, HOLDER_NAME_MAX) : null,
    holderIdNumber: kind === "holding" ? optionalCertificateText(params.holder_id_number, "The holder's identification number", 1, HOLDER_ID_MAX) : null,
    evidence: parseCertificateEvidence(params.evidence),
  };
}

/**
 * The preview's company: each field as typed when it was, else the prefill's,
 * then validated like create's. Throws CertificateInputError naming what is
 * still missing (the preview reports it as its `problem`).
 */
export function previewCompany(typed: unknown, prefill: CertificateCompany): CertificateCompany {
  const given = typed && typeof typed === "object" && !Array.isArray(typed) ? (typed as Record<string, unknown>) : {};
  const pick = (key: keyof CertificateCompany) =>
    typeof given[key] === "string" && (given[key] as string).trim() !== "" ? given[key] : prefill[key];
  return parseCertificateCompany({ legal_name: pick("legal_name"), registration_number: pick("registration_number"), address: pick("address") });
}

/** The preview's scale: as typed when it was, else the prefill's. Throws CertificateInputError when neither gives one. */
export function previewScale(typed: unknown, prefill: string | null): bigint {
  const given = typed !== undefined && typed !== null && typed !== "" ? typed : prefill;
  if (given === null) throw new CertificateInputError("Enter how many units stand for 100 % of the company.");
  return parseUnitsFor100Percent(given);
}

// ── A stored payload ────────────────────────────────────────────────────────

export class CertificatePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CertificatePayloadError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isNullableString = (v: unknown): v is string | null => v === null || typeof v === "string";
const isDigits = (v: unknown): v is string => typeof v === "string" && /^\d{1,20}$/.test(v);

function check(ok: unknown, what: string): asserts ok {
  if (!ok) throw new CertificatePayloadError(`The certificate payload is not valid: ${what}`);
}

/**
 * A certificate payload from its canonical text: canonical, schema v1, and
 * every field of the right type (what the pages and the public projection
 * read). Throws CertificatePayloadError; the statement is not re-derived.
 */
export function parseCertificatePayload(text: string): CertificatePayload {
  check(text.length <= CERTIFICATE_MAX_PAYLOAD_CHARS, "too long");
  check(isCanonicalJson(text), "not canonical JSON");
  const p = JSON.parse(text) as Record<string, unknown>;
  check(p.schema === CERTIFICATE_SCHEMA, "unknown schema");
  check(p.network === "mainnet" || p.network === "devnet" || p.network === "testnet" || p.network === "localnet", "network");
  check(isString(p.number) && CERTIFICATE_NUMBER_PATTERN.test(p.number), "number");
  check(p.kind === "holding" || p.kind === "issuance", "kind");
  check(isString(p.issued_at) && !Number.isNaN(Date.parse(p.issued_at)), "issued_at");
  check(isString(p.salt) && CERTIFICATE_SALT_PATTERN.test(p.salt), "salt");
  const o = p.operator;
  check(isRecord(o) && isString(o.brand) && isNullableString(o.legal_name) && isNullableString(o.registered_office) &&
    isNullableString(o.registration_number) && isNullableString(o.registration_number_label) && isNullableString(o.register), "operator");
  const c = p.company;
  check(isRecord(c) && isString(c.legal_name) && isString(c.registration_number) && isString(c.address), "company");
  const a = p.asset;
  check(isRecord(a) && isString(a.asset_id) && isString(a.name) && isString(a.symbol) && isString(a.asset_pda) &&
    isString(a.issuer_pda) && isString(a.legal_doc_hash), "asset");
  const s = p.share_class;
  check(isRecord(s) && Number.isSafeInteger(s.class_index) && isString(s.share_class_pda) && isString(s.mint) &&
    (s.max_supply === null || isDigits(s.max_supply)) && isDigits(s.units_for_100_percent) && isString(s.unit_percent) &&
    typeof s.unit_percent_rounded === "boolean", "share_class");
  if (p.kind === "holding") {
    const h = p.holder;
    check(isRecord(h) && isString(h.wallet) && isNullableString(h.name) && isNullableString(h.id_number), "holder");
    const g = p.holding;
    check(isRecord(g) && isDigits(g.units) && isString(g.percent_of_company) && typeof g.percent_of_company_rounded === "boolean" &&
      isDigits(g.slot) && g.commitment === "finalized", "holding");
    check(p.supply === null, "supply on a holding certificate");
  } else {
    check(p.holder === null && p.holding === null, "holder on an issuance certificate");
    const u = p.supply;
    check(isRecord(u) && isNullableString(u.max_supply_percent) && typeof u.max_supply_percent_rounded === "boolean" &&
      isDigits(u.lifetime_minted) && isDigits(u.circulating) && isString(u.circulating_percent) &&
      typeof u.circulating_percent_rounded === "boolean" && isDigits(u.slot) && u.commitment === "finalized", "supply");
  }
  const e = p.chain_evidence;
  check(isRecord(e) && isString(e.asset_registry_program) && isString(e.transfer_hook_program) && isString(e.token_program) &&
    Array.isArray(e.transactions) && e.transactions.every((t) => isRecord(t) && isString(t.signature) && isDigits(t.slot) && isNullableString(t.note)),
  "chain_evidence");
  check(isString(p.statement) && p.statement.length > 0, "statement");
  check(isRecord(p.signer) && isString(p.signer.public_key), "signer");
  return p as unknown as CertificatePayload;
}

// ── Rows and views (route ⇄ page) ───────────────────────────────────────────

/** A certificates row as the admin routes read it (0087). */
export type CertificateRow = {
  id: string;
  network: Network;
  number: string;
  kind: CertificateKind;
  status: CertificateStatus;
  asset_pda: string;
  share_class_pda: string;
  holder_wallet: string | null;
  payload_canonical: string;
  payload_sha256: string;
  signer: string;
  signature: string | null;
  signature_format: SiwsSignatureFormat | null;
  signed_at: string | null;
  anchor_tx: string | null;
  anchor_slot: number | null;
  anchor_block_time: string | null;
  anchored_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

/** The admin list's entry: what a row says without its payload (no personal data). */
export type CertificateListItem = Omit<CertificateRow, "payload_canonical"> & {
  asset_label: string;
  issued_at: string;
};

/** The admin detail: the row, its parsed payload and the exact signed bytes. */
export type CertificateDetail = CertificateRow & { payload: CertificatePayload };

/** The admin list entry of a row (null when its payload does not parse). */
export function certificateListItem(row: CertificateRow): CertificateListItem | null {
  let payload: CertificatePayload;
  try {
    payload = parseCertificatePayload(row.payload_canonical);
  } catch {
    return null;
  }
  const rest: Partial<CertificateRow> = { ...row };
  delete rest.payload_canonical;
  return {
    ...(rest as Omit<CertificateRow, "payload_canonical">),
    asset_label: `${payload.asset.name} · ${payload.asset.symbol} · class ${payload.share_class.class_index}`,
    issued_at: payload.issued_at,
  };
}

/**
 * What a check by number alone, or with a hash that does not match, is told
 * instead of the contents. Numbers are sequential, so contents by number alone
 * would let anyone list which wallets obtained certificates; a real verifier
 * holds the printed certificate, whose SHA-256 (and link) opens the details.
 */
export const CERTIFICATE_HASH_HINT =
  "Enter the SHA-256 printed on the certificate, or choose its JSON file, to see what it states.";

/** The answer to a number without the certificate's hash: whether it exists and its status, nothing it states. */
export type PublicCertificateSummary = {
  found: true;
  details: false;
  number: string;
  /** "valid": signed (and possibly anchored), signature and hash check out; "revoked": revoked after signing. */
  status: "valid" | "revoked" | "invalid";
  revoked_at: string | null;
  /** null: no hash was given; false: the given hash is not this certificate's. */
  hash_matches: null | false;
  hint: string;
};

/**
 * What the public verification page shows to someone who holds the
 * certificate (its number and matching SHA-256): facts of the chain and the
 * company, never the holder's name or ID number.
 */
export type PublicCertificateDetails = {
  found: true;
  details: true;
  number: string;
  network: Network;
  kind: CertificateKind;
  /** "valid": signed (and possibly anchored), signature and hash check out; "revoked": revoked after signing. */
  status: "valid" | "revoked" | "invalid";
  anchored: boolean;
  issued_at: string;
  signed_at: string | null;
  revoked_at: string | null;
  company: CertificateCompany;
  asset: CertificatePayload["asset"];
  share_class: CertificatePayload["share_class"];
  holder_wallet: string | null;
  holding: CertificatePayload["holding"];
  supply: CertificatePayload["supply"];
  signer: string;
  signature: string;
  signature_format: SiwsSignatureFormat;
  signature_valid: boolean;
  payload_sha256: string;
  anchor: { tx: string; slot: number | null; block_time: string | null } | null;
  hash_matches: true;
};

export type PublicCertificateView = PublicCertificateDetails | PublicCertificateSummary | { found: false; number: string; hash_matches: null };

/** Equality of two hex strings in time that does not depend on where they differ. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/**
 * The public view of a stored certificate. A draft, or a draft revoked before
 * it was signed, was never issued: "not found". Without the certificate's own
 * SHA-256 (`checks.providedSha256`), only the summary: that it exists, its
 * status and the revocation date, with CERTIFICATE_HASH_HINT. With it, the
 * details, copied named field by named field (never a spread of the payload
 * or the row), so a field added later to either stays private until it is
 * added here. `checks` are the route's own re-verification of the signature
 * and of the stored hash.
 */
export function publicCertificateView(
  row: Pick<CertificateRow, "number" | "network" | "kind" | "status" | "payload_canonical" | "payload_sha256" | "signer" | "signature" | "signature_format" | "signed_at" | "anchor_tx" | "anchor_slot" | "anchor_block_time" | "revoked_at">,
  checks: { signatureValid: boolean; hashConsistent: boolean; providedSha256: string | null },
): PublicCertificateView {
  const notFound: PublicCertificateView = { found: false, number: row.number, hash_matches: null };
  if (row.status === "draft" || row.signature === null || row.signature_format === null || !isSiwsSignatureFormat(row.signature_format)) {
    return notFound;
  }
  let payload: CertificatePayload;
  try {
    payload = parseCertificatePayload(row.payload_canonical);
  } catch {
    return notFound;
  }
  const intact = checks.signatureValid && checks.hashConsistent;
  const status: "valid" | "revoked" | "invalid" = row.status === "revoked" ? "revoked" : intact ? "valid" : "invalid";
  const revokedAt = row.status === "revoked" ? row.revoked_at : null;
  if (checks.providedSha256 === null || !sameHex(checks.providedSha256, row.payload_sha256)) {
    return {
      found: true,
      details: false,
      number: row.number,
      status,
      revoked_at: revokedAt,
      hash_matches: checks.providedSha256 === null ? null : false,
      hint: CERTIFICATE_HASH_HINT,
    };
  }
  return {
    found: true,
    details: true,
    number: row.number,
    network: payload.network,
    kind: payload.kind,
    status,
    anchored: row.anchor_tx !== null,
    issued_at: payload.issued_at,
    signed_at: row.signed_at,
    revoked_at: revokedAt,
    company: {
      legal_name: payload.company.legal_name,
      registration_number: payload.company.registration_number,
      address: payload.company.address,
    },
    asset: {
      asset_id: payload.asset.asset_id,
      name: payload.asset.name,
      symbol: payload.asset.symbol,
      asset_pda: payload.asset.asset_pda,
      issuer_pda: payload.asset.issuer_pda,
      legal_doc_hash: payload.asset.legal_doc_hash,
    },
    share_class: {
      class_index: payload.share_class.class_index,
      share_class_pda: payload.share_class.share_class_pda,
      mint: payload.share_class.mint,
      max_supply: payload.share_class.max_supply,
      units_for_100_percent: payload.share_class.units_for_100_percent,
      unit_percent: payload.share_class.unit_percent,
      unit_percent_rounded: payload.share_class.unit_percent_rounded,
    },
    holder_wallet: payload.holder ? payload.holder.wallet : null,
    holding: payload.holding
      ? {
          units: payload.holding.units,
          percent_of_company: payload.holding.percent_of_company,
          percent_of_company_rounded: payload.holding.percent_of_company_rounded,
          slot: payload.holding.slot,
          commitment: payload.holding.commitment,
        }
      : null,
    supply: payload.supply
      ? {
          max_supply_percent: payload.supply.max_supply_percent,
          max_supply_percent_rounded: payload.supply.max_supply_percent_rounded,
          lifetime_minted: payload.supply.lifetime_minted,
          circulating: payload.supply.circulating,
          circulating_percent: payload.supply.circulating_percent,
          circulating_percent_rounded: payload.supply.circulating_percent_rounded,
          slot: payload.supply.slot,
          commitment: payload.supply.commitment,
        }
      : null,
    signer: row.signer,
    signature: row.signature,
    signature_format: row.signature_format,
    signature_valid: checks.signatureValid,
    payload_sha256: row.payload_sha256,
    anchor: row.anchor_tx
      ? { tx: row.anchor_tx, slot: row.anchor_slot, block_time: row.anchor_block_time }
      : null,
    hash_matches: true,
  };
}

/** What the admin form starts from for an asset (lib/server/certificates.ts readCertificatePrefill). */
export type CertificatePrefill = {
  company: { legal_name: string; registration_number: string; address: string };
  /** Where the prefilled company details came from (for the form's hint). */
  company_source: "certificate" | "tokenization" | "issuer_profile" | "spv" | null;
  units_for_100_percent: string | null;
  scale_source: "certificate" | "tokenization" | null;
};

/** The preview route's answer: the chain facts, the prefill, and the payload as it would read. */
export type CertificatePreview = {
  facts: {
    asset_pda: string;
    asset_id: string;
    asset_name: string;
    symbol: string;
    issuer_pda: string;
    share_class_pda: string;
    class_index: number;
    mint: string;
    max_supply: string | null;
    lifetime_minted: string;
    holding: { units: string; slot: string } | null;
    supply: { circulating: string; slot: string } | null;
  };
  prefill: CertificatePrefill;
  /** The payload with a placeholder number, or null when something is missing (`problem` says what). */
  payload: CertificatePayload | null;
  problem: string | null;
};

/** The placeholder number a preview carries: the real one is allocated when the draft is created. */
export function previewCertificateNumber(issuedAt: Date): string {
  return `MC-${issuedAt.getUTCFullYear()}-0000`;
}

/**
 * The path of the public verification page for `number` (the printed
 * certificate carries the full URL). With `sha256` the page checks that hash
 * too: numbers restart on every network, so a number alone could name
 * another network's certificate on the site the link opens.
 */
export function certificateVerifyPath(number: string, sha256?: string): string {
  const query = `number=${encodeURIComponent(number)}${sha256 ? `&sha256=${encodeURIComponent(sha256)}` : ""}`;
  return `/certificates/verify?${query}`;
}
