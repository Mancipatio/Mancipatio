// The KYC upload client (lib/clients.ts): an upload failure shows the
// server's reason, a file the route would refuse is reported before any
// request (and, for an operator, before the signature prompt), a file the
// browser reports without a type is sent with the type its extension says,
// and the file picker offers exactly what /api/clients/upload accepts.
// Node vitest; fetch is stubbed, so no route runs here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ sign: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/siws-client", () => ({ signedFetch: vi.fn(), createSignedRequest: mocks.sign }));

import {
  KYC_UPLOAD_ACCEPT,
  KYC_UPLOAD_MAX_BYTES,
  kycUploadProblem,
  uploadClientDocument,
  uploadClientDocumentWithToken,
  uploadFailureMessage,
  withUploadType,
} from "@/lib/clients";
import { MAINTENANCE_CODE, maintenanceRefusal } from "@/lib/maintenance";
import { UPLOAD_MIME_ALLOWLIST } from "@/lib/storage-client";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TYPE_REFUSAL = "Unsupported file type — upload a PDF, PNG, JPG or DOCX";
const CLIENT_ID = "c0000000-0000-4000-8000-000000000003";
const session = { account: { address: "11111111111111111111111111111111" } } as never;

const pdf = (name = "passport.pdf") => new File([new TextEncoder().encode("%PDF-1.4 x")], name, { type: "application/pdf" });
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const upload = (file: File) => uploadClientDocumentWithToken(CLIENT_ID, "secret-token", "", file, "passport", 7);
const sentForm = (call = 0) => (mocks.fetch.mock.calls[call] as [string, RequestInit])[1].body as FormData;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockReset();
  mocks.sign.mockReset();
  mocks.sign.mockResolvedValue({ payload: {}, signature: "sig", publicKey: "pk" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("kycUploadProblem — what the route would refuse", () => {
  it("passes the four allowed types, also a .docx the browser reports without a type", () => {
    expect(kycUploadProblem(pdf())).toBeNull();
    expect(kycUploadProblem(new File(["x"], "id.png", { type: "image/png" }))).toBeNull();
    expect(kycUploadProblem(new File(["x"], "id.jpg", { type: "image/jpeg" }))).toBeNull();
    expect(kycUploadProblem(new File(["x"], "contract.docx", { type: "" }))).toBeNull();
    expect(kycUploadProblem(new File([new Uint8Array(KYC_UPLOAD_MAX_BYTES)], "max.pdf", { type: "application/pdf" }))).toBeNull();
  });

  it("names the empty file, the size and the type", () => {
    expect(kycUploadProblem(new File([], "empty.pdf", { type: "application/pdf" }))).toBe("The file is empty.");
    expect(kycUploadProblem(new File([new Uint8Array(KYC_UPLOAD_MAX_BYTES + 1)], "big.pdf", { type: "application/pdf" }))).toMatch(/larger than 4 MB/);
    expect(kycUploadProblem(new File(["x"], "photo.webp", { type: "image/webp" }))).toBe(TYPE_REFUSAL);
    expect(kycUploadProblem(new File(["x"], "scan.doc", { type: "application/msword" }))).toBe(TYPE_REFUSAL);
    // No type and an unknown extension is octet-stream to the route: refused here as well.
    expect(kycUploadProblem(new File(["x"], "photo.heic", { type: "" }))).toBe(TYPE_REFUSAL);
  });

  it("the picker's accept list is the route's allowlist, by extension and by type", () => {
    for (const ext of [".pdf", ".png", ".jpg", ".jpeg", ".docx"]) expect(KYC_UPLOAD_ACCEPT).toContain(ext);
    for (const mime of UPLOAD_MIME_ALLOWLIST) expect(KYC_UPLOAD_ACCEPT).toContain(mime);
    expect(KYC_UPLOAD_ACCEPT).not.toMatch(/image\/\*|\.doc,/);
  });

  it("withUploadType declares the type the extension says and keeps the bytes", async () => {
    const typed = withUploadType(new File(["hello"], "contract.docx", { type: "" }));
    expect(typed.type).toBe(DOCX);
    expect(typed.name).toBe("contract.docx");
    expect(await typed.text()).toBe("hello");
    const already = pdf();
    expect(withUploadType(already)).toBe(already);
  });
});

describe("uploadFailureMessage", () => {
  it("prefers the server's reason; names the body limit on 413 and the burst limit on a bare 429", () => {
    expect(uploadFailureMessage(400, TYPE_REFUSAL)).toBe(TYPE_REFUSAL);
    expect(uploadFailureMessage(413, undefined)).toMatch(/larger than 4 MB/);
    expect(uploadFailureMessage(413, "Request Entity Too Large")).toMatch(/larger than 4 MB/);
    expect(uploadFailureMessage(429, "")).toBe("Too many uploads — wait a minute and try again.");
    expect(uploadFailureMessage(429, "Too many uploads — slow down")).toBe("Too many uploads — slow down");
    expect(uploadFailureMessage(500, null)).toBe("Could not upload the document (HTTP 500). Please try again.");
  });
});

describe("the magic-link upload", () => {
  it("returns the route's reason for a refused type and for an expired link", async () => {
    mocks.fetch.mockResolvedValueOnce(json(400, { ok: false, error: TYPE_REFUSAL }));
    expect(await upload(pdf())).toEqual({ ok: false, recomputed: null, error: TYPE_REFUSAL });
    const expired = "This onboarding link has expired — ask the platform operator for a fresh invitation";
    mocks.fetch.mockResolvedValueOnce(json(401, { ok: false, error: expired }));
    expect((await upload(pdf())).error).toBe(expired);
  });

  it("reads the platform's 413 (no JSON body) as the size limit, not as a generic failure", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response("FUNCTION_PAYLOAD_TOO_LARGE", { status: 413 }));
    const result = await upload(pdf());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/larger than 4 MB/);
    expect(result.error).not.toMatch(/Please try again/);
  });

  it("still shows the maintenance notice", async () => {
    mocks.fetch.mockResolvedValueOnce(json(503, { ok: false, code: MAINTENANCE_CODE, message: "Back at 10:00 UTC" }));
    expect((await upload(pdf())).error).toBe(maintenanceRefusal("Back at 10:00 UTC", "devnet").message);
  });

  it("refuses a file the route would refuse without sending it", async () => {
    expect((await upload(new File(["x"], "photo.webp", { type: "image/webp" }))).error).toBe(TYPE_REFUSAL);
    expect((await upload(new File([new Uint8Array(KYC_UPLOAD_MAX_BYTES + 1)], "big.pdf", { type: "application/pdf" }))).error).toMatch(/larger than 4 MB/);
    expect((await upload(new File([], "empty.pdf", { type: "application/pdf" }))).error).toBe("The file is empty.");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("sends a .docx without a declared type as DOCX, with the token and the requirement, no wallet", async () => {
    mocks.fetch.mockResolvedValueOnce(json(200, { ok: true, data: { document_id: 1, sha256: "x", recomputed: "pending" } }));
    expect(await upload(new File(["docx bytes"], "contract.docx", { type: "" }))).toEqual({ ok: true, recomputed: "pending" });
    expect(mocks.fetch.mock.calls[0][0]).toBe("/api/clients/upload");
    const form = sentForm();
    expect((form.get("file") as File).type).toBe(DOCX);
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("token")).toBe("secret-token");
    expect(form.get("kind")).toBe("passport");
    expect(form.get("requirement_id")).toBe("7");
    expect(form.get("wallet")).toBeNull();
  });

  it("names the network when the request itself fails", async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect((await upload(pdf())).error).toBe("Network error — check your connection and try again.");
  });
});

describe("the operator upload", () => {
  it("never asks for a signature for a file the route would refuse", async () => {
    const result = await uploadClientDocument(session, CLIENT_ID, new File(["x"], "photo.webp", { type: "image/webp" }), "passport");
    expect(result).toEqual({ ok: false, recomputed: null, error: TYPE_REFUSAL });
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("signs the exact bytes, sends the typed file, and a refusal carries the server's reason", async () => {
    const refusal = "Only an Admin can lift a suspension or reverse a rejection";
    mocks.fetch.mockResolvedValueOnce(json(403, { ok: false, error: refusal }));
    const result = await uploadClientDocument(session, CLIENT_ID, new File(["docx bytes"], "contract.docx", { type: "" }), "incorporation", 9);
    expect(result).toEqual({ ok: false, recomputed: null, error: refusal });
    expect(mocks.sign).toHaveBeenCalledWith(
      session, "clients.upload", expect.objectContaining({ client_id: CLIENT_ID, kind: "incorporation", size: 10, requirement_id: 9 }),
    );
    const form = sentForm();
    expect((form.get("file") as File).type).toBe(DOCX);
    expect(JSON.parse(form.get("auth") as string)).toMatchObject({ signature: "sig" });
  });
});
