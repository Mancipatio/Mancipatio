/** Shared immutable document naming. SHA values here are declarations until
 * the server verifies the stored bytes and returns a version ID. */
export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;
export const DOCUMENT_STAGING_BUCKET = "document-uploads";
export function documentDestination(
  path: string,
  sha256: string,
  network: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Invalid SHA-256");
  if (!["devnet", "mainnet", "testnet", "localnet"].includes(network))
    throw new Error("Invalid network");
  const parts = path.split("/");
  if (
    path.length > 350 ||
    parts.length < 2 ||
    parts.some((p) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p))
  )
    throw new Error("Invalid document path");
  if (parts[0] !== "whitepapers") return path;
  if (parts.length < 3 || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(parts[1]))
    throw new Error("Invalid whitepaper asset");
  const decision = parts.includes("ssc-decision") ? "ssc-decision/" : "";
  const filename = parts
    .at(-1)!
    .replace(/^[0-9a-f]{8,64}-/, "")
    .slice(0, 140);
  return `whitepapers/${parts[1]}/${network}/${decision}${sha256}/${filename}`;
}
export function assertDocumentBytes(
  bytes: Uint8Array,
  declaredSize: number,
  actualHash: string,
  declaredHash: string,
) {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > DOCUMENT_MAX_BYTES ||
    bytes.byteLength !== declaredSize
  )
    throw new Error("Uploaded file size does not match the signed declaration");
  if (actualHash !== declaredHash)
    throw new Error(
      "Uploaded file SHA-256 does not match the signed declaration",
    );
}
