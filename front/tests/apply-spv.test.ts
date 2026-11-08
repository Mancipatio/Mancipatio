// The /apply branch for companies outside Serbia (lib/apply-spv.ts,
// components/serbian-spv-panel.tsx, app/(marketing)/apply/page.tsx): when the
// Serbian SPV panel shows, what the form sends, that the choice travels as the
// top-level signed param the routes read (company_formation_requested, 0056;
// no new column), that an edit keeps it, and that the admin queue shows it.
// The panel renders statically; the page wiring is pinned by source, as in
// tests/onboarding-page.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const remote = vi.hoisted(() => ({ signedFetch: vi.fn(async () => ({ id: "app-1", applications: [] })) }));
vi.mock("@/lib/siws-client", () => ({ signedFetch: remote.signedFetch }));

import {
  formationRequested,
  SERBIA_INCORPORATION,
  SERBIAN_SPV_GUIDE,
  SPV_CHOICE_LABEL,
  SPV_COSTS,
  SPV_REQUIREMENTS,
  spvPathApplies,
} from "@/lib/apply-spv";
import { SerbianSpvPanel } from "@/components/serbian-spv-panel";
import { listMyApplications, submitApplication, updateApplicationContent, type NewApplication } from "@/lib/launchpad";

const src = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const panel = (props: Partial<Parameters<typeof SerbianSpvPanel>[0]> = {}) =>
  renderToStaticMarkup(createElement(SerbianSpvPanel, {
    isIndividual: false, incorporation: "BVI", chosen: false, onChosenChange: () => {}, ...props,
  }));
/** The choice's checkbox tag (React orders its attributes as it likes). */
const checkbox = (html: string) => {
  const tag = /<input type="checkbox"[^>]*>/.exec(html)?.[0] ?? "";
  expect(tag).toContain('name="companyFormationRequested"');
  return tag;
};

beforeEach(() => remote.signedFetch.mockClear());

describe("when the Serbian SPV panel applies", () => {
  it("a company incorporated anywhere but Serbia, a company not incorporated yet, and every individual", () => {
    expect(SERBIA_INCORPORATION).toBe("Serbia");
    for (const incorporation of ["Not yet", "US (Delaware)", "BVI", "Cayman Islands", "UK", "Other", "", null]) {
      expect(spvPathApplies({ isIndividual: false, incorporation }), String(incorporation)).toBe(true);
    }
    expect(spvPathApplies({ isIndividual: false, incorporation: "Serbia" })).toBe(false);
    expect(spvPathApplies({ isIndividual: false, incorporation: " Serbia " })).toBe(false);
    expect(spvPathApplies({ isIndividual: true, incorporation: "Serbia" })).toBe(true);
  });

  it("sends the request only for a ticked choice while the panel applies; always for an individual", () => {
    expect(formationRequested({ isIndividual: false, incorporation: "BVI", spvChosen: true })).toBe(true);
    expect(formationRequested({ isIndividual: false, incorporation: "BVI", spvChosen: false })).toBe(false);
    expect(formationRequested({ isIndividual: false, incorporation: "Not yet", spvChosen: true })).toBe(true);
    // Ticked, then the answer switched back to Serbia: no stale request.
    expect(formationRequested({ isIndividual: false, incorporation: "Serbia", spvChosen: true })).toBe(false);
    expect(formationRequested({ isIndividual: true, incorporation: "Not yet", spvChosen: false })).toBe(true);
  });
});

describe("the panel", () => {
  it("explains the SPV, what to provide and the costs, with an unticked explicit choice", () => {
    const html = panel();
    expect(html).toContain("Issuing through a Serbian SPV");
    expect(html).toContain("Your company is incorporated in BVI, not in Serbia.");
    expect(html).toContain("Company ownership, debt and revenue share are issued through a");
    expect(html).toContain("Manci incorporates a Serbian special-purpose vehicle");
    expect(html).toContain("administers it for the issuance");
    for (const item of SPV_REQUIREMENTS) expect(html).toContain(item.replace(/'/g, "&#x27;"));
    expect(html).toContain(SPV_COSTS);
    expect(SPV_COSTS).toContain("quoted per engagement before any work starts");
    expect(html).toContain(SPV_CHOICE_LABEL);
    expect(checkbox(html)).not.toContain("checked");
    expect(checkbox(html)).not.toContain("disabled");
    expect(html).toContain(`href="${SERBIAN_SPV_GUIDE}"`);
  });

  it("shows the stored choice ticked", () => {
    expect(checkbox(panel({ chosen: true }))).toContain('checked=""');
    expect(panel({ chosen: true })).toContain("Your application will ask Manci to incorporate the SPV");
  });

  it("an individual has no choice to make: ticked and disabled", () => {
    const html = panel({ isIndividual: true, incorporation: "Not yet" });
    expect(html).toContain("You are applying as an individual");
    expect(checkbox(html)).toContain('checked=""');
    expect(checkbox(html)).toContain('disabled=""');
  });

  it("names the answer it reacts to", () => {
    expect(panel({ incorporation: "Not yet" })).toContain("Your company is not incorporated yet.");
    expect(panel({ incorporation: "Other" })).toContain("Your company is incorporated in a country other than Serbia, not in Serbia.");
  });
});

describe("the signed submission carries the choice the routes read", () => {
  const payload = { raise_type: "mature", company_name: "Acme" } as unknown as NewApplication;

  it("submit and resubmit send company_formation_requested at the top level, only when requested", async () => {
    await submitApplication(null, payload, { companyFormationRequested: true });
    expect(remote.signedFetch).toHaveBeenLastCalledWith(null, "/api/applications/submit", "applications.submit",
      { application: payload, company_formation_requested: true });
    await submitApplication(null, payload);
    expect(remote.signedFetch).toHaveBeenLastCalledWith(null, "/api/applications/submit", "applications.submit", { application: payload });
    await updateApplicationContent(null, "id-1", payload, { companyFormationRequested: true });
    expect(remote.signedFetch).toHaveBeenLastCalledWith(null, "/api/applications/resubmit", "applications.resubmit",
      { id: "id-1", application: payload, company_formation_requested: true });
    await updateApplicationContent(null, "id-1", payload, { companyFormationRequested: false });
    expect(remote.signedFetch).toHaveBeenLastCalledWith(null, "/api/applications/resubmit", "applications.resubmit", { id: "id-1", application: payload });
  });

  it("the routes read exactly that param (the content narrowing never does)", () => {
    for (const route of ["app/api/applications/submit/route.ts", "app/api/applications/resubmit/route.ts"]) {
      expect(src(route), route).toContain('company_formation_requested: kind === "individual" || params.company_formation_requested === true');
    }
    expect(src("app/api/applications/_lib.ts")).not.toContain("company_formation_requested");
  });

  it("the issuer journey's background read of the applicant's own applications never prompts", async () => {
    await listMyApplications(null, { interactive: false });
    expect(remote.signedFetch).toHaveBeenLastCalledWith(null, "/api/applications/mine", "applications.mine", {}, { interactive: false });
  });
});

describe("page wiring", () => {
  const apply = src("app/(marketing)/apply/page.tsx");

  it("the panel sits under the incorporation answer and only where the SPV path applies", () => {
    const step2 = apply.slice(apply.indexOf("{/* ── STEP 2: Company"), apply.indexOf("{/* ── STEP 3: Raise"));
    expect(step2.indexOf('id="incorporation"')).toBeLessThan(step2.indexOf("<SerbianSpvPanel"));
    expect(step2).toContain("{spvPathApplies({ isIndividual, incorporation: form.incorporation }) && (");
    expect(step2).toContain('onChosenChange={(chosen) => set("spvRequested", chosen)}');
  });

  it("both submission paths send the computed choice, and an edit restores the stored one", () => {
    expect(apply).toContain("const companyFormationRequested = formationRequested({");
    expect(apply).toContain("await updateApplicationContent(conn.wallet, editingApp.id, payload, { companyFormationRequested });");
    expect(apply).toContain("await submitApplication(conn.wallet, payload, { companyFormationRequested });");
    expect(apply).toContain("spvRequested: a.company_formation_requested === true,");
    // The review step and the status panel say it too.
    expect(apply).toContain('label: "Serbian SPV"');
    expect(apply).toContain("<Badge>Serbian SPV requested</Badge>");
  });

  it("the admin queue shows the request and links to the SPV registry", () => {
    const admin = src("app/admin/applications/page.tsx");
    expect(admin).toContain("{app.company_formation_requested ? (");
    expect(admin).toContain("SPV requested");
    expect(admin).toContain('href="/admin/spvs"');
  });
});
