// /admin/clients "+ Add client": after a create the modal must show its
// success view with the onboarding link (magic-link) and Copy — the link is
// returned once, by POST /api/clients/create, and no other screen shows it.
// The parent used to unmount the modal in onSuccess, right after submit()
// had stored the token, so the view never rendered and the link of a client
// invited without a wallet was lost. Source-text checks, the repo's way of
// pinning page wiring (tests run in node without React rendering; see
// tests/role-surfaces.test.ts, which keeps its own mount check on this page).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(join(process.cwd(), "app/admin/clients/page.tsx"), "utf8");

describe("the Add client modal keeps its success view", () => {
  it("onSuccess only refreshes the list; the modal closes through Done or Open detail", () => {
    const start = page.indexOf("<AddClientModal");
    expect(start).toBeGreaterThan(-1);
    const mount = page.slice(start, page.indexOf("/>", start));
    expect(mount).toContain("onClose={() => setShowAdd(false)}");
    const onSuccess = mount.slice(mount.indexOf("onSuccess="));
    expect(onSuccess).toContain("refresh()");
    expect(onSuccess).not.toContain("setShowAdd(false)");
    // The admin-only mount tests/role-surfaces.test.ts pins stays as it is.
    expect(page).toContain("{showAdd && isAdmin && (");
  });

  it("a created row always switches to the success view, with the link or the linked wallet", () => {
    expect(page).toContain("const createdSuccess = !!createdId;");
    expect(page).not.toContain("!!createdId && (inviteLink || createdWallet)");
    expect(page).toContain("value={inviteLink}");
    expect(page).toContain("void navigator.clipboard.writeText(inviteLink);");
    expect(page).toContain("value={createdWallet}");
    // Neither (a token that could not be issued): a way to send one, not a blank.
    expect(page).toContain("No upload link could be issued for this dossier.");
  });

  it("a stray click outside cannot close the link away; the hint says it is shown once", () => {
    expect(page).toContain("!submitting && !createdSuccess) onClose();");
    expect(page).toContain("Valid for 14 days. Copy it now — it is not shown again.");
    // The token still reaches the modal from the create response.
    expect(page).toContain("setCreatedToken(row.onboarding_token);");
    expect(page).toContain("onSuccess();");
  });
});
