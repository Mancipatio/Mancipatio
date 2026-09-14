import { address, type Instruction } from "@solana/kit";
// Official program identity and UTF-8 wire format:
// https://github.com/solana-program/memo/blob/main/idl.json
export const MEMO_PROGRAM_ADDRESS =
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const PREFIX = "mancipatio:terms:";
export type DocumentTerms = { versionId: string; sha256: string };
export type SaleDocumentTerms = DocumentTerms & {
  sale: string;
  asset: string;
  url: string;
  verifiedAt: string;
};
export function documentTermsMemo(terms: DocumentTerms): Instruction {
  if (
    !/^[0-9a-f-]{36}$/i.test(terms.versionId) ||
    !/^[0-9a-f]{64}$/.test(terms.sha256)
  )
    throw new Error("Invalid document version");
  return {
    programAddress: address(MEMO_PROGRAM_ADDRESS),
    accounts: [],
    data: new TextEncoder().encode(
      PREFIX + terms.versionId + ":" + terms.sha256,
    ),
  };
}
export function parseDocumentTermsMemo(data: Uint8Array): DocumentTerms | null {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  if (!text.startsWith(PREFIX)) return null;
  const match = /^mancipatio:terms:([0-9a-f-]{36}):([0-9a-f]{64})$/i.exec(text);
  if (!match) throw new Error("Invalid document acceptance memo");
  return { versionId: match[1].toLowerCase(), sha256: match[2].toLowerCase() };
}
