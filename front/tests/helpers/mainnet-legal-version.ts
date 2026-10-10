// The mainnet legal texts' version, in one place for the tests that pin it
// (tests/legal-slots.test.ts, tests/terms-modules.test.ts).
//
// 2026-10-10: the Terms that offer trading through Manci and conversion into
// company shares (lib/legal/mainnet-copy.ts), HELD until counsel confirms
// their exact wording. If counsel confirms on a later day, the confirmation
// commit moves `version` and `lastUpdated` of both documents to that day, and
// this constant with them; the header of lib/legal/mainnet-copy.ts lists the
// other places that name the date.

/** The version and date of the mainnet Terms and Privacy Policy in lib/legal/mainnet-copy.ts. */
export const MAINNET_VERSION = "2026-10-10";

/** The previous mainnet Terms version (live on mainnet), which every wallet must accept again. */
export const PREVIOUS_MAINNET_VERSION = "2026-10-03";
