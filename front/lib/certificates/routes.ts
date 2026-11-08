// The certificate routes and their signed actions, shared by the routes and
// the pages (lib/certificates-client.ts).
//
// Session actions (lib/siws-session.ts): list, read and preview are reads;
// sign and anchor are accepted exceptions there (each only records evidence
// the server verifies first: the session wallet's own Ed25519 signature over
// the certificate, or an anchor the document-anchor route already verified
// on chain). create and revoke need a fresh wallet signature.

export const CERTIFICATE_ACTIONS = {
  list: "certificates.list",
  read: "certificates.read",
  preview: "certificates.preview",
  create: "certificates.create",
  sign: "certificates.sign",
  anchor: "certificates.anchor",
  revoke: "certificates.revoke",
} as const;

export const CERTIFICATE_PATHS = {
  list: "/api/admin/certificates/list",
  read: "/api/admin/certificates/read",
  preview: "/api/admin/certificates/preview",
  create: "/api/admin/certificates/create",
  sign: "/api/admin/certificates/sign",
  anchor: "/api/admin/certificates/anchor",
  revoke: "/api/admin/certificates/revoke",
  verify: "/api/certificates/verify",
} as const;

/** A certificate row id (a uuid). */
export const CERTIFICATE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
