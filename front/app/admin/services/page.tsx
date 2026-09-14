import Link from "next/link";

const CATALOG = [
  {
    group: "Issuance",
    items: [
      {
        name: "Issuer onboarding & KYB",
        href: "/admin/issuers",
        desc: "Register a legal entity and verify its KYB before it can tokenize anything.",
      },
      {
        name: "Asset registration",
        href: "/admin/assets",
        desc: "Record a company, real-world asset or instrument as an on-chain asset.",
      },
      {
        name: "Share-class structuring",
        href: "/admin/share-classes",
        desc: "Define share classes — rights, liquidation preference, voting weight, supply caps.",
      },
      {
        name: "Token-2022 mint deployment",
        href: "/admin/share-classes",
        desc: "Deploy the compliance-wired mint and mint units to the treasury.",
      },
    ],
  },
  {
    group: "Distribution & markets",
    items: [
      {
        name: "Primary launchpad sales",
        href: "/admin/launchpad",
        desc: "Open a priced sale of share-class units and place them with investors.",
      },
      {
        name: "OTC secondary trading",
        href: "/admin/otc",
        desc: "Escrow-settled peer-to-peer offers — post, fund, fill or cancel.",
      },
    ],
  },
  {
    group: "Custody & vesting",
    items: [
      {
        name: "Custody vaults",
        href: "/admin/custody",
        desc: "Program-owned escrow for conversions, delivery and redemption queues.",
      },
      {
        name: "Rights-Token vesting",
        href: "/admin/rights",
        desc: "Escrow an underlying token and release it on milestone Merkle claims.",
      },
    ],
  },
  {
    group: "Governance & compliance",
    items: [
      {
        name: "Advisory governance",
        href: "/admin/governance",
        desc: "Snapshot-weighted proposals and votes for share-class holders.",
      },
      {
        name: "Platform & sanctions control",
        href: "/admin/platform",
        desc: "Reserved fee field (nothing is charged on-chain), the pause switch and the transfer-hook sanctions blocklist.",
      },
    ],
  },
];

export default function ServicesPage() {
  return (
    <section className="min-w-0 flex-1">
      <h1 className="text-2xl font-semibold">Services</h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
        Everything Mancipatio offers — each service maps to an on-chain
        operation in this panel.
      </p>

      <div className="mt-8 space-y-8">
        {CATALOG.map((section) => (
          <div key={section.group}>
            <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-500">
              {section.group}
            </h2>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              {section.items.map((item) => (
                <Link
                  key={item.name}
                  href={item.href}
                  className="rounded-xl border border-slate-200 bg-white shadow-card p-5 transition-colors hover:border-slate-300"
                >
                  <h3 className="text-base font-semibold text-slate-900">
                    {item.name}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-600">
                    {item.desc}
                  </p>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
