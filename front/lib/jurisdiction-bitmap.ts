// Jurisdiction bitmaps of the KycRegistry (approved / blocked), mirrored from
// the program. Dependency-free on purpose: lib/passport (browser), the role
// resolution and the 3.3 CLI all import these without pulling in any
// browser-side module. lib/passport re-exports them for existing callers.

/**
 * Size in bytes of every on-chain jurisdiction bitmap — mirrors
 * `asset_registry::state::JURISDICTION_BITMAP_BYTES`. 128 bytes = 1024 bits
 * covers the whole ISO-3166-1 numeric range (000–899 assigned, 900–999
 * user-assigned); the pre-2026-08-10 maps were 32 bytes and could not encode
 * most of the world (Germany 276, Serbia 688, Spain 724, UK 826 …).
 */
export const JURISDICTION_BITMAP_BYTES = 128;

/**
 * Build a 128-byte jurisdiction bitmap from an array of ISO numeric country
 * codes.  Each code sets bit (code % 8) of byte (code >> 3). Codes outside
 * the bitmap (≥ 1024 — no such ISO code exists) are dropped, exactly as the
 * chain would reject them; use isJurisdictionRepresentable() to detect that
 * before issuing a passport.
 */
export function jurisdictionBitmap(codes: number[]): Uint8Array {
  const bitmap = new Uint8Array(JURISDICTION_BITMAP_BYTES);
  for (const code of codes) {
    const byte = code >> 3;      // Math.floor(code / 8)
    const bit = code & 0x7;     // code % 8
    if (byte < JURISDICTION_BITMAP_BYTES) {
      bitmap[byte] |= 1 << bit;
    }
  }
  return bitmap;
}

/**
 * True when the ISO numeric code fits in the on-chain 128-byte (1024-bit)
 * registry bitmap. Every assigned ISO-3166-1 numeric code (≤ 999) now fits;
 * only a malformed code ≥ 1024 would fail the program's byte-bound check
 * (ReceiverJurisdictionBlocked, fail-closed).
 */
export function isJurisdictionRepresentable(code: number): boolean {
  return (
    Number.isInteger(code) && code >= 0 && code < JURISDICTION_BITMAP_BYTES * 8
  );
}

/**
 * Mirror of the on-chain jurisdiction check (util.rs): bit (code % 8) of byte
 * (code / 8) must be set AND the byte index must be < JURISDICTION_BITMAP_BYTES.
 * Accepts any byte-indexable bitmap (Uint8Array, the generated
 * ReadonlyUint8Array, or a plain number array).
 */
export function bitmapHasCode(bitmap: ArrayLike<number>, code: number): boolean {
  if (!isJurisdictionRepresentable(code)) return false;
  const byte = code >> 3;
  const bit = code & 0x7;
  return byte < bitmap.length && (bitmap[byte] & (1 << bit)) !== 0;
}
