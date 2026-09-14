// Single source of truth for the current Terms-of-Service version.
//
// Deliberately directive-free and dependency-free so BOTH sides can import it:
//   - client code via the re-export in lib/clients.ts (`TOS_VERSION`)
//   - server routes (app/api/clients/accept-tos, app/api/tos/accept)
//
// Bump when /legal/terms changes materially.
export const TOS_VERSION = "2026-07-18";
