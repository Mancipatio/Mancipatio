import { createHash } from "node:crypto";
import { describe,expect,it } from "vitest";
import { documentDestination,assertDocumentBytes,DOCUMENT_MAX_BYTES } from "@/lib/document-integrity";
const asset="11111111111111111111111111111111";
const bytes=Buffer.from("%PDF-1.7\nMancipatio terms — version 1");
const sha=createHash("sha256").update(bytes).digest("hex");
describe("immutable document integrity",()=>{
  it("binds the full hash and network in the whitepaper path",()=>{
    const path=documentDestination(`whitepapers/${asset}/${sha.slice(0,8)}-terms.pdf`,sha,"devnet");
    expect(path).toBe(`whitepapers/${asset}/devnet/${sha}/terms.pdf`);
    expect(documentDestination(path,sha,"devnet")).toBe(path);
    expect(documentDestination(path,sha,"mainnet")).not.toBe(path);
  });
  it("preserves separate SSC decision versions",()=>{
    expect(documentDestination(`whitepapers/${asset}/ssc-decision/terms.pdf`,sha,"devnet")).toBe(`whitepapers/${asset}/devnet/ssc-decision/${sha}/terms.pdf`);
  });
  it.each(["../secret","whitepapers/../../terms.pdf","/legal/terms.pdf","legal//terms.pdf","legal/.hidden/terms.pdf"])("rejects unsafe path %s",path=>{
    expect(()=>documentDestination(path,sha,"devnet")).toThrow();
  });
  it("rejects a declared hash that does not match actual uploaded bytes",()=>{
    expect(()=>assertDocumentBytes(bytes,bytes.length,sha,sha)).not.toThrow();
    expect(()=>assertDocumentBytes(bytes,bytes.length,sha,"0".repeat(64))).toThrow(/SHA-256/);
    expect(()=>assertDocumentBytes(bytes,bytes.length+1,sha,sha)).toThrow(/size/);
    expect(()=>assertDocumentBytes(new Uint8Array(DOCUMENT_MAX_BYTES+1),DOCUMENT_MAX_BYTES+1,sha,sha)).toThrow(/size/);
  });
});
