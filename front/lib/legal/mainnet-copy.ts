// THE SLOT for counsel's mainnet legal texts. The devnet pilot's Terms and
// Privacy Policy stay where they are (app/(marketing)/legal/*/devnet-*.tsx);
// a mainnet build renders these instead, through
// components/legal/legal-document.tsx.
//
// What is here: the mainnet Terms of Service, Privacy Policy and the
// acceptance-dialog summary.
//
// Version 2026-10-03 (THIS TEXT): written by engineering from the owner's
// decisions D1-D7 of 2026-10-03, whose model counsel approved: units of an
// open class are bearer instruments that need no identity verification to
// buy, hold or transfer; buying needs only a wallet linked to the Service
// (connected and signed in, the Terms in force accepted, sanctions screening
// passed); buying in a primary sale outside the Service is not supported and
// may lead to the blocklist and clawback; public primary sales, each
// approved by the Operator; issuers may also transfer units from their
// treasury directly; KYC only to convert into company shares (where the
// issuer offers it, once switched on) and for physical delivery.
//
// Counsel confirmed the exact wording on 2026-10-03 (the owner's statement,
// recorded in PR #57): PURCHASE_RISK_WARNING.status is "counsel"
// (lib/legal/risk-warning.ts), a mainnet build takes this version, and it is
// the text live on mainnet. The hold for a LATER version stays in code, not
// only here, because MAINNET_LEGAL_COPY_APPROVED=true is set in production
// and is not bound to a version: wording counsel has not confirmed yet goes
// in with the risk warning's status set to "draft", which a mainnet build
// refuses (lib/legal/readiness.ts). The commit that records counsel's
// confirmation sets it back to "counsel", together with the expectations
// that follow it (tests/legal-slots.test.ts, scripts/ci/mainnet-build.sh);
// if that is on a later day, `version` and `lastUpdated` of both documents
// move to that day.
//
// Review of 2026-10-03 (PR #57): conversion into company shares is worded as
// not available yet (its module and on-chain custody entry are off on
// mainnet); "buying outside the Service" covers a purchase in a primary sale
// only, never units received by an issuer's direct transfer or from another
// wallet; the EUR 3,000,000 limit applies per issuer or, where it issues
// through an SPV, per SPV, as 0066 counts it, and the admin routes refuse a
// higher limit on mainnet (lib/raise-cap.ts).
//
// Version 2026-10-02 (the previous one): the owner stated on 2026-10-02 that
// counsel approved the drafts of 2026-09-30 (the mainnet kit's
// 05-mainnet-copy.draft.ts and 06-privacy.draft.ts, outside the repository);
// they were transferred verbatim, with three changes the owner decided the
// same day: both documents dated 2026-10-02 (version and lastUpdated), and
// clause 11 of the Privacy Policy stating which keys a hardware wallet holds
// instead of "hardware wallets for the keys that control the platform" (one
// company hardware wallet: super administrator, KYC authority, Blocklist
// Authority, treasury; a multisig whose member is a separate hardware wallet:
// the programs' upgrade authority; a second administrator: a software
// wallet). Clause 11 is unchanged in 2026-10-03.
//
// Changing a text:
//   - Each document is a LegalDocument (lib/legal/document.ts): plain
//     paragraphs and bulleted lists under numbered clauses.
//   - Leave out who the operator is, the governing law, the competent court
//     and the contact addresses: the pages render them from
//     lib/legal/operator.ts, so they cannot drift from the footer and
//     /legal/company.
//   - MAINNET_TERMS.version is the Terms version every wallet accepts
//     (TOS_VERSION, lib/tos-version.ts): give any material change of the
//     Terms a new version (every wallet then accepts again).
//   - MAINNET_TERMS.offeredModules: the modules clause 2 offers, as names
//     (TERMS_MODULES, lib/legal/document.ts). Keep it equal to clause 2: a
//     mainnet build refuses a NEXT_PUBLIC_FEATURE_* module flag that is on
//     while its module is not listed (next.config.ts
//     assertBuildMainnetModules); a listed module may be switched off. The
//     version that first lists a module should also say that the Operator
//     may suspend a module at any time, so that switching one off by flag
//     alone keeps the Terms accurate. tests/terms-modules.test.ts checks the
//     list against clause 2's "not available" list.
//   - MAINNET_TOS_GATE_POINTS: the short summary shown in the acceptance
//     dialog (components/tos-gate.tsx).
//   - Then `npx vitest run tests/legal-slots.test.ts --silent=false`: the
//     "mainnet legal slots" report must say complete. A mainnet build refuses
//     anything else, including text that still says devnet or "no real assets".
//
// Directive-free and import-free apart from types (next.config.ts loads it).

import type { LegalDocument, TermsDocument } from "./document";

/** The mainnet Terms of Service, version 2026-10-03 (owner's decisions D1-D7; wording confirmed by counsel on 2026-10-03). */
export const MAINNET_TERMS: TermsDocument | null = {
  version: "2026-10-03",
  lastUpdated: "2026-10-03",
  lede:
    "These Terms govern your use of the Manci tokenization platform on Solana mainnet: the website, its applications and the on-chain programs you use through them.",
  // The modules clause 2 offers. It offers primary sales and an issuer's
  // direct transfers, which have no switch, and lists every module that has
  // one as not available (payout airdrops as part of "distributions"): none.
  offeredModules: [],
  clauses: [
    {
      title: "1. Acceptance and scope",
      blocks: [
        {
          kind: "paragraph",
          text: "These Terms of Service (the \"Terms\") are an agreement between you and the company named as the operator on this page (the \"Operator\", \"we\", \"us\"). \"Manci\" or the \"Service\" means the website at manci.io, its applications, and the on-chain programs described in clause 4 as far as you use them through the Service.",
        },
        {
          kind: "paragraph",
          text: "You accept these Terms by signing the acceptance message with your wallet when the Service asks you to, or by registering as a client or an issuer. The Service records your wallet address together with the version of the Terms you accepted. If you do not accept these Terms, do not use the Service.",
        },
        {
          kind: "paragraph",
          text: "Each primary sale has its own offering document, which describes the instrument, the issuer's obligations and your rights against the issuer. Your purchase transaction records the identifier and the hash of the offering document in force. On the rights attached to an instrument the offering document prevails; on your use of the Service these Terms prevail.",
        },
      ],
    },
    {
      title: "2. Scope of the Service",
      blocks: [
        { kind: "paragraph", text: "The Service currently offers the following:" },
        {
          kind: "list",
          items: [
            "Primary sales of share-class tokens, open to the public: no invitation is needed. The Operator approves each sale (clause 7). To buy, you need a wallet linked to the Service as clause 7 describes. Buying, holding and transferring units of an open class need no identity verification (clause 6).",
            "Direct transfers by an issuer of units from its treasury to wallets it chooses (clause 7).",
          ],
        },
        { kind: "paragraph", text: "The following are not available at present, and the pages that carry them say so:" },
        {
          kind: "list",
          items: [
            "Conversion of tokens into company shares. Once the Operator switches it on, it will be available where the issuer offers it, and it will require identity verification (clause 6).",
            "Trading through Manci (OTC deals, offers and the resell board), vested (Startup) raises and their payout vaults, physical delivery, distributions, vesting, governance and Rights-Token issuances, which are switched off.",
          ],
        },
        {
          kind: "paragraph",
          text: "The on-chain programs have been through internal security reviews and automated testing only. No independent external audit has been completed.",
        },
        {
          kind: "paragraph",
          text: "The Operator may change the scope of the Service or switch further features on. Where a change affects your rights or obligations under these Terms, the Operator first publishes a new version of the Terms (clause 20).",
        },
      ],
    },
    {
      title: "3. Eligibility",
      blocks: [
        {
          kind: "list",
          items: [
            "You must be at least 18 years old and have full legal capacity. If you act for a company or another entity, you confirm that you are authorised to bind it, and these Terms bind it.",
            "You must not be located in, resident in or incorporated in a country or region where the Operator does not offer the Service, and you must not use a VPN or any other means to hide where you are.",
            "You, and anyone for whom you act, must not be the subject of sanctions under the sanctions lists the Operator applies, or be owned or controlled by such a person, and your wallet must not appear on such a list.",
            "You are responsible for making sure that using the Service, and buying and holding the instruments offered on it, is lawful where you live and where you act from, and for any tax on your purchases, holdings and sales.",
            "The information you give the Operator, in identity verification or otherwise, must be true and complete, and you must keep it up to date.",
          ],
        },
      ],
    },
    {
      title: "4. What the Operator does and does not do",
      blocks: [
        {
          kind: "paragraph",
          text: "The Service is technology through which issuers offer tokenized instruments and buyers acquire and hold them. Tokens are created and moved by two on-chain programs on the Solana network, asset_registry and transfer_hook, whose addresses are published on the Security page. Payments and escrowed tokens are held in accounts owned by those programs, not in a wallet of the Operator; the Operator's authorised keys can take the actions described in clause 9.",
        },
        {
          kind: "paragraph",
          text: "The Operator is not the issuer of the instruments offered on the Service and is not a party to the instrument between you and an issuer. Each issuer is responsible for its instrument, its offering document, its disclosures and the licences and consents its offering requires. The Operator does not take legal title to the off-chain assets that back tokens.",
        },
        {
          kind: "paragraph",
          text: "Nothing on the Service is investment, legal, tax or accounting advice, or a recommendation to buy, hold or sell any instrument. The Operator does not assess whether an instrument is suitable for you.",
        },
      ],
    },
    {
      title: "5. Your wallet, keys and transactions",
      blocks: [
        {
          kind: "list",
          items: [
            "You use a self-custodial wallet and you alone control its private keys and seed phrase. The Operator cannot sign for you, cannot recover a lost key and cannot reverse a transaction you signed.",
            "Tokens are bearer instruments: whoever controls the wallet that holds them can transfer them, subject to the transfer checks in clause 8. If tokens leave your control, the Operator cannot return them to you.",
            "A transaction confirmed on the Solana network is final. Check the amount, the price and the addresses before you sign.",
            "You pay the Solana network fees of the transactions you sign.",
            "To accept these Terms and to sign in, your wallet must be able to sign messages. A wallet that cannot sign messages cannot use the marketplace or the portfolio.",
          ],
        },
      ],
    },
    {
      title: "6. Identity verification and the investor passport",
      blocks: [
        {
          kind: "paragraph",
          text: "Identity verification (KYC) is required to convert tokens into company shares, where the issuer offers conversion, and to take delivery of a physical good, where delivery is offered. Buying, holding and transferring units of an open class (a class that is not KYC-gated) need no identity verification. The Operator can make a class KYC-gated (clause 8); buying or receiving units of such a class then requires a live investor passport. Issuers must pass verification of the legal entity (KYB) before they can issue.",
        },
        {
          kind: "paragraph",
          text: "When your verification is approved, the Operator writes an investor passport for your wallet to the Solana blockchain. The passport is public and records your wallet address, its status, a jurisdiction code, an investor category, its expiry, a code identifying the verification provider and a hash reference to your verification file; it contains no name and no document. A passport is valid for at most two years.",
        },
        {
          kind: "paragraph",
          text: "The Operator may revoke a passport, for example when a later review fails, when sanctions screening returns a match, or at your request. A wallet whose passport is revoked or has expired cannot receive units of a KYC-gated class; it keeps the units it already holds unless clause 9 applies.",
        },
      ],
    },
    {
      title: "7. Primary sales",
      blocks: [
        {
          kind: "paragraph",
          text: "A sale opens only after the Operator has approved it for that share class. The approval fixes the payment token, a price range, the most the sale may raise and the latest start date; within it, the issuer sets the price, the quantity and the dates. Primary sales are open to the public; no invitation is needed. The issuer chooses how long a sale runs, up to 365 days (for example 30 or 90 days).",
        },
        {
          kind: "paragraph",
          text: "You can buy units in a primary sale only through the Service. Before each purchase, your wallet must be connected to the Service and signed in, by signing the message the Service asks for; it must have accepted the version of these Terms in force; and it must pass the sanctions screening described in clause 10. Nothing more is required to buy units of an open class: in particular, you need no identity verification and no investor passport. You must still meet the conditions of clause 3 and confirm the offering document and the risk warning described below.",
        },
        {
          kind: "paragraph",
          text: "Buying units in a primary sale in any other way, for example by sending a purchase transaction to the on-chain programs directly or through other software, is not supported. The Operator monitors purchases on the blockchain. Where a purchase in a primary sale was made other than through the Service, the Operator may place the buyer's wallet on the blocklist and move its units into quarantine under clause 9. Units moved into quarantine are never returned, and the programs do not refund the price paid for them. Units you receive through an issuer's direct transfer (described below) or by a transfer from another wallet (clause 8) are not a purchase in a primary sale.",
        },
        {
          kind: "paragraph",
          text: "The Operator limits the amount each issuer may raise through the Service to at most EUR 3,000,000 over any period of twelve months; where an issuer issues through a special purpose vehicle, the limit applies to that vehicle. The Operator counts the issuer's sales, including sales approved but not yet closed, and the units it mints to its treasury, and does not approve a sale beyond the limit.",
        },
        {
          kind: "paragraph",
          text: "You pay in USDC. When your purchase is confirmed, the price moves from your wallet into the sale's escrow and the units are minted to your wallet in the same transaction; when the sale closes, the issuer receives the proceeds. A confirmed purchase is final: it cannot be cancelled, and for the sales the Service currently offers (clause 2) the programs have no instruction that refunds its price to you. Any claim for your money back is a claim against the issuer under the offering document.",
        },
        {
          kind: "paragraph",
          text: "Before you buy, the Service shows you the offering document and a risk warning that you must confirm.",
        },
        {
          kind: "paragraph",
          text: "An issuer may also transfer units from its treasury directly to wallets it chooses. Such a transfer is the issuer's own act, not a primary sale through the Service: the Operator does not approve it, and the Service processes no payment for it, records no offering document for it and shows no risk warning for it. Any rights in respect of units received this way are against the issuer. Those units are subject to clauses 8 and 9 like any other units.",
        },
      ],
    },
    {
      title: "8. Transfers and transfer checks",
      blocks: [
        { kind: "paragraph", text: "Every transfer of a share-class token runs through the transfer_hook program:" },
        {
          kind: "list",
          items: [
            "a wallet on the blocklist cannot send tokens, except into the burn-only quarantine described in clause 9;",
            "on a KYC-gated class, the receiving wallet must hold a live passport from a permitted jurisdiction.",
          ],
        },
        {
          kind: "paragraph",
          text: "The Operator, through its Blocklist Authority role, can switch a share class between open and KYC-gated transfers in either direction, and can point a KYC-gated class to another passport registry. A wallet on the blocklist is also refused as a buyer in a primary sale and as a party to a trade through Manci. Transfers from wallet to wallet do not pass through the Operator and are not stopped by an emergency pause; the checks above still apply.",
        },
      ],
    },
    {
      title: "9. What the Operator can do without your signature",
      blocks: [
        {
          kind: "paragraph",
          text: "The on-chain programs give the Operator's authorised keys the following powers. They can be used without your signature and without notice to you:",
        },
        {
          kind: "list",
          items: [
            "Emergency pause. Any administrator can pause one or more areas of platform-mediated activity: onboarding, primary sales, trading through Manci, custody entry, distributions and payouts to issuers. Only the super administrator can resume them. A pause never blocks exits: cancellations, expiries, refunds, claims and custody returns keep working.",
            "Issuer proceeds freeze. Any administrator can freeze the proceeds of one issuer: its sales, withdrawals and payouts to it stop, and only the super administrator can lift the freeze. While it lasts, money that buyers have already paid into that issuer's sale stays locked in the sale's escrow: it is neither paid to the issuer nor refunded to buyers, who keep the units they bought.",
            "Blocklist. The Blocklist Authority can add any wallet, including a program escrow, to the blocklist, for example after a sanctions match or a purchase in a primary sale made other than through the Service (clause 7), and can remove it.",
            "Clawback. An administrator can move a holder's units, without the holder's signature, into a quarantine vault of the same share class from which they can only be burned: on any class, when the holder's wallet is on the blocklist; on a KYC-gated class, when the holder's passport was revoked, or expired at least 30 days earlier. Units moved into quarantine are never returned on-chain, including when the wallet is later removed from the blocklist.",
            "Share-class mode. The Blocklist Authority can switch a class between open and KYC-gated transfers (clause 8).",
            "Permitted jurisdictions. The Operator's KYC authority can change at any time, with immediate effect, which jurisdictions' passports KYC-gated classes accept. A holder whose jurisdiction is no longer permitted cannot buy or receive further units of such a class.",
            "Roles and recovery. Adding an administrator or replacing the super administrator takes effect only after 48 hours, during which it can be cancelled; pausing and removing an administrator take effect at once. If the super administrator's or the Blocklist Authority's key is lost, the holder of the programs' upgrade authority can move that role to a new key after 7 days unless the current key holder cancels. If an issuer loses its key, the super administrator can move the issuer's authority to a new key after 7 days unless the issuer cancels.",
            "Program upgrades. The Operator controls the upgrade authority of both programs and can replace their code. An upgrade can change any behaviour these Terms describe, including the waiting periods above.",
          ],
        },
        {
          kind: "paragraph",
          text: "Currently, one key of the Operator holds the super administrator, administrator, Blocklist Authority and KYC authority roles together; a second key holds the administrator role only, and a separate key controls the upgrade authority of both programs. The Operator uses these powers to comply with the law, sanctions and orders of courts and authorities, to protect users and the Service, to act on purchases in a primary sale made other than through the Service (clause 7), and in the other cases these Terms describe.",
        },
      ],
    },
    {
      title: "10. Sanctions screening and geographic restrictions",
      blocks: [
        {
          kind: "paragraph",
          text: "The Operator screens wallets against sanctions lists, and the Service screens your wallet before each purchase. The Service refuses a wallet that matches, and the match is reported to the Operator's compliance function. A purchase in a primary sale sent directly to the programs bypasses this screening and is not supported (clause 7); the Operator screens such a purchase afterwards and may blocklist the wallet and claw back its units (clause 9), whether or not the screening finds a match. If the Operator cannot check the list, the Service refuses the request rather than letting it through.",
        },
        {
          kind: "paragraph",
          text: "The Service refuses transactional requests from countries and regions where it is not offered, based on the network location of the request, and refuses them when that location cannot be determined. These checks are a first line of defence and do not replace your obligations under clause 3.",
        },
      ],
    },
    {
      title: "11. Fees",
      blocks: [
        {
          kind: "paragraph",
          text: "The Operator currently charges buyers and holders no fee for using the Service. No platform fee is taken on-chain on purchases, and the programs' yield-routing feature, which would pay a share of routed yield to the Operator, is switched off. You pay the Solana network fees of your own transactions (clause 5).",
        },
        {
          kind: "paragraph",
          text: "Issuers pay what their engagement agreement with the Operator provides. The Operator will publish a new version of these Terms before it introduces any fee for buyers or holders.",
        },
      ],
    },
    {
      title: "12. Risks",
      blocks: [
        {
          kind: "paragraph",
          text: "Tokenized instruments carry risk, including the total loss of the money you commit. They are illiquid: there is no exchange listing and no guaranteed buyer. Distributions, conversion and redemption depend on the issuer performing, and a claim against an issuer is not a payment. Conversion into company shares is not available yet (clause 2); once it is, it will be available only where the issuer offers it, and only after identity verification. Software, including the on-chain programs, the Service and the Solana network, can fail. The value and availability of USDC depend on its issuer.",
        },
        {
          kind: "paragraph",
          text: "Digital asset transactions are not covered by deposit insurance or by any investor protection or compensation scheme.",
        },
        {
          kind: "paragraph",
          text: "The risk disclosure page and the risk warning shown before each purchase describe these risks in more detail. Do not commit money you cannot afford to lose entirely.",
        },
      ],
    },
    {
      title: "13. Issuers",
      blocks: [
        { kind: "paragraph", text: "If you use the Service as an issuer, you must also:" },
        {
          kind: "list",
          items: [
            "keep your KYB information accurate and tell the Operator promptly of any material change to the entity, its beneficial owners or its compliance position;",
            "obtain every licence, approval and consent your offering requires, and publish an offering document that meets the law that applies to it;",
            "treat your issuer authority wallet as a master key: a hardware wallet or a multisig is strongly recommended, and recovering a lost key takes at least 7 days (clause 9);",
            "accept that the Operator may refuse or revoke a sale approval, pause issuance and freeze your proceeds under clause 9.",
          ],
        },
        {
          kind: "paragraph",
          text: "Your engagement agreement with the Operator governs the rest of the relationship between you and the Operator.",
        },
      ],
    },
    {
      title: "14. Prohibited use",
      blocks: [
        { kind: "paragraph", text: "You must not use the Service for:" },
        {
          kind: "list",
          items: [
            "breaking any law or sanctions, or helping anyone else to do so;",
            "hiding your location or identity, using another person's identity or wallet, or acting for a person who is not eligible under clause 3;",
            "money laundering, terrorist financing, fraud or market manipulation;",
            "buying in a primary sale other than through the Service (clause 7);",
            "interfering with the Service or the on-chain programs, or exploiting a defect in them instead of reporting it to the security contact published on the Security page;",
            "scraping, overloading or attacking the Service.",
          ],
        },
      ],
    },
    {
      title: "15. Suspension, termination and wind-down",
      blocks: [
        {
          kind: "paragraph",
          text: "The Operator may refuse, suspend or end your access to the Service, suspend or reject your client profile and revoke your passport if you breach these Terms, if the law, sanctions or an authority requires it, or to protect other users or the Service. You may stop using the Service at any time.",
        },
        {
          kind: "paragraph",
          text: "Ending your access to the Service does not take your tokens: they stay in your wallet, subject to clauses 8 and 9.",
        },
        {
          kind: "paragraph",
          text: "If the Operator stops operating the Service, it will announce the stop in advance, stop new activity and keep the exits of existing positions open for as long as its wind-down plan provides.",
        },
      ],
    },
    {
      title: "16. Availability of the Service",
      blocks: [
        {
          kind: "paragraph",
          text: "The Service is provided as it is and as available. The Operator does not guarantee uptime, latency or that any feature will continue. Maintenance can interrupt the Service, and during maintenance the Service refuses signed requests and transactions.",
        },
      ],
    },
    {
      title: "17. Liability",
      blocks: [
        {
          kind: "paragraph",
          text: "To the extent the law allows, the Operator is not liable for: losses caused by the performance or default of an issuer; the loss of your keys or a transaction you signed; defects in, or the behaviour of, the Solana network, wallets, USDC or other third-party software; the use of its powers under clause 9 in line with these Terms; or indirect or consequential loss or lost profit.",
        },
        {
          kind: "paragraph",
          text: "Nothing in these Terms limits liability that cannot be limited under the applicable law, including liability for fraud or wilful misconduct.",
        },
      ],
    },
    {
      title: "18. Personal data",
      blocks: [
        {
          kind: "paragraph",
          text: "The Privacy Policy describes how the Operator processes personal data. The Service records your wallet address with each acceptance of these Terms. Information written to the Solana blockchain, including your passport, if one is issued (clause 6), and your transactions, is public and cannot be deleted.",
        },
      ],
    },
    {
      title: "19. Complaints and notices",
      blocks: [
        {
          kind: "paragraph",
          text: "Send complaints and legal notices to the legal contact shown below, or use the contact form. Include your wallet address and the transaction or sale concerned.",
        },
        {
          kind: "paragraph",
          text: "The Operator sends notices to the contact details you have given it, or publishes them on the Service.",
        },
      ],
    },
    {
      title: "20. Changes to these Terms",
      blocks: [
        {
          kind: "paragraph",
          text: "The Operator may change these Terms. Each version carries its own date. When a new version comes into force, the Service asks you to accept it with your wallet before you can use the marketplace or the portfolio again. Until you do, your tokens stay in your wallet and remain subject to clauses 8 and 9.",
        },
      ],
    },
    {
      title: "21. General",
      blocks: [
        {
          kind: "list",
          items: [
            "These Terms, together with the Privacy Policy, the offering document of each sale you take part in and the risk warning you confirm, are the whole agreement between you and the Operator on your use of the Service.",
            "If a provision of these Terms is invalid, the others remain in force.",
            "You may not transfer your rights under these Terms without the Operator's consent. The Operator may transfer them to a successor that takes over the operation of the Service.",
            "These Terms are written in English. A translation is for convenience only.",
          ],
        },
      ],
    },
  ],
};

/** The mainnet Privacy Policy, version 2026-10-03 (owner's decisions D1-D7; wording confirmed by counsel on 2026-10-03). */
export const MAINNET_PRIVACY: LegalDocument | null = {
  version: "2026-10-03",
  lastUpdated: "2026-10-03",
  lede:
    "This Privacy Policy explains what personal data we collect when you use Manci, why we use it, who receives it, how long we keep it and which rights you have. It also explains what becomes public on the Solana blockchain when you use the platform, which no one can delete.",
  clauses: [
    {
      title: "1. Who is responsible",
      blocks: [
        {
          kind: "paragraph",
          text: "The company named as the controller at the top of this page (the \"Operator\", \"we\", \"us\") is responsible for the personal data described in this policy. Manci is a platform for issuing and holding tokenized interests in real-world assets on the Solana blockchain. This policy covers the website manci.io, the investor and issuer consoles, sign-in, identity verification, and our communication with you.",
        },
        {
          kind: "paragraph",
          text: "Some features described below are available only where an issuer offers them, or not at all times. Where a feature is not offered to you, we do not collect the data it needs. You do not need to verify your identity to buy or hold tokens of an open class (a class that is not KYC-gated under our Terms).",
        },
      ],
    },
    {
      title: "2. The blockchain is public and permanent",
      blocks: [
        {
          kind: "paragraph",
          text: "Manci runs on Solana, a public blockchain that we do not control. Anything recorded on it can be read by anyone, is copied by independent computers around the world, and cannot be changed or deleted by us or by anyone else. This includes:",
        },
        {
          kind: "list",
          items: [
            "your wallet address and every transaction it signs or receives through the platform, with the tokens, amounts and times involved;",
            "your token balances and the history of your holdings;",
            "your investor passport, if we issue one: the wallet it belongs to, its status, a numeric code of your jurisdiction, your investor category, its expiry and a one-way reference to your verification file with us (it contains no name and no document);",
            "the fact that a wallet was placed on the blocklist, that its tokens were moved into quarantine, or that an issuer's proceeds were frozen, if we take one of these measures under our Terms;",
            "the identifier and fingerprint of the offering document you accepted, which your purchase transaction records.",
          ],
        },
        {
          kind: "paragraph",
          text: "Blockchain explorers and analytics companies index this data. If anyone learns that a wallet is yours, for example because you told them or because it was linked to your identity elsewhere, they can see that wallet's full history. When you exercise your rights, we cannot erase or correct on-chain records; we can only stop linking them to the data we hold off-chain. Please consider this before you connect a wallet or complete verification.",
        },
      ],
    },
    {
      title: "3. Personal data we collect",
      blocks: [
        {
          kind: "paragraph",
          text: "We collect the following data, mostly from you and your wallet, and in part from public sources and our own systems:",
        },
        {
          kind: "list",
          items: [
            "Wallet and sign-in data: the public addresses of the wallets you connect, the messages you sign to prove that you control them, and short-lived one-time values we keep so that a signed message cannot be reused.",
            "Account data: the display name you choose, your email address and whether you have confirmed it, and, if you sign in with or link a Google account, that account's identifier and email address. We ask Google only for your account identifier and email address.",
            "Identity verification (KYC) data, when you verify, for example to convert tokens into company shares: your full legal name, date of birth, nationality, country of residence, address, city and postal code, your email address and, optionally, your phone number, and the documents we request, such as a passport or national identity card, proof of address, a photograph of your face, evidence of the source of your funds and bank statements.",
            "Company verification (KYB) data, when you act for a company: its name, registration number, country, registered address and website, your role, your name, country of residence, address and contact details, a copy of your passport or identity card, and corporate documents such as the certificate of incorporation or a registry extract, board resolutions and a description of the company's ownership and beneficial owners.",
            "Verification records: the status and history of our verification decisions and their dates, the documents we requested and their review status, notes our staff add to your file, and a log of each time our staff open or export your documents.",
            "Investor passport requests: the wallet, the jurisdiction you state, any note you add, and the outcome.",
            "Transaction records: your purchases (wallet, sale, amount and transaction reference), including purchases in a primary sale made outside the platform that we see on the blockchain, each acceptance of our Terms (wallet, version and time) and, if you raise funds, the fundraising limits and sale approvals that apply to you. We also copy the platform's public on-chain transactions into our database to show your portfolio and history.",
            "Issuer applications: when you apply to raise funds, information about the company (for example its valuation, revenue, existing investors and plans), the founder's name, email address, social media profiles and statement, pitch materials, and the history of our review.",
            "Requests you make where these services are offered: contact details and notes for converting tokens into shares, a delivery address and contact details for the delivery of goods, requests for over-the-counter trades, and contact details you add to a resale listing, which the resale board shows publicly.",
            "Messages: your name, email address, company and message when you use the contact form or write to us.",
            "Sanctions screening results: before each purchase through the platform, when a wallet uses certain other features, and afterwards for each purchase we see on the blockchain, we check the wallet against public sanctions lists, currently the list of Specially Designated Nationals published by the United States Treasury. A match creates an internal compliance record with the wallet, the list and the details of the match.",
            "Technical data: your IP address and the country derived from it, which we use while handling a request to limit abuse, to run a bot check and to refuse access from countries where the service is not offered. We store the IP address only as a one-way hash in short-lived abuse counters. Our hosting provider keeps request and error logs, which include IP addresses and can include other identifiers contained in error messages, such as email or wallet addresses. The error reports we send to our error-monitoring provider have identifiers such as email and wallet addresses removed as far as we can detect them.",
          ],
        },
        {
          kind: "paragraph",
          text: "Our staff review verification documents themselves. We do not use facial recognition or any other biometric matching on your photograph. We do not collect data for advertising and we do not sell personal data.",
        },
      ],
    },
    {
      title: "4. Why we use it",
      blocks: [
        {
          kind: "list",
          items: [
            "To create and run your account, let you sign in and provide the features you use: to perform our agreement with you.",
            "To verify the identity of investors and issuers, keep records of that verification, screen wallets against sanctions lists, monitor purchases in primary sales made outside the platform, and prevent money laundering, terrorist financing and fraud: to comply with our legal obligations and, where no specific law requires a step, for our legitimate interest in keeping the platform lawful and safe.",
            "To issue, renew and revoke investor passports and to apply the transfer rules of the tokens you hold: to perform our agreement with you and to comply with our legal obligations.",
            "To review applications from issuers and decide on them: to take the steps you ask for before entering into an agreement.",
            "To secure the platform, limit abuse, refuse access from countries where the service is not offered, and find and fix errors: our legitimate interest in a secure and lawful service.",
            "To send you messages about your account, sign-in, verification, requests and transactions: to perform our agreement with you. We do not send marketing email.",
            "To keep evidence of what was agreed and done, and to establish, exercise or defend legal claims: our legitimate interest and our legal obligations.",
            "To answer lawful requests from authorities and courts: to comply with our legal obligations.",
          ],
        },
        {
          kind: "paragraph",
          text: "Where we ask for your consent, you can withdraw it at any time; this does not affect what we did before. Some features require verification by law or under our Terms: if you do not give us the data we ask for, we cannot offer you those features.",
        },
      ],
    },
    {
      title: "5. Automated checks",
      blocks: [
        {
          kind: "paragraph",
          text: "Our staff make verification decisions. Some checks run automatically: a request from a wallet that appears on a sanctions list we screen against, or from a country where the service is not offered, is refused automatically, and an expired verification or passport automatically stops the features that require it. If you believe such a refusal is wrong, contact us and a person will review it. When a purchase in a primary sale made outside the platform comes from a wallet that appears on a sanctions list we screen against, an alert is raised automatically; whether to blocklist a wallet that bought in a primary sale outside the platform and move its tokens is decided by our staff.",
        },
      ],
    },
    {
      title: "6. Who receives your data",
      blocks: [
        {
          kind: "list",
          items: [
            "Our staff and the people who operate the platform for us, each only as far as their role requires. Only administrators and staff with the verification role can open identity documents, through links that expire after two minutes (ten minutes in a data export, which only administrators can create), and every opening and export is logged.",
            "Service providers that process data for us under our instructions: Supabase (database and file storage), Vercel (website hosting and server functions), our email delivery and mailbox providers, Cloudflare (bot check on the email sign-in and contact forms), Helius (blockchain infrastructure, including the requests your browser sends to read the blockchain and submit transactions, and notices of platform transactions), and Sentry (error monitoring).",
            "Google, if you choose to sign in with or link a Google account. Google handles that sign-in under its own privacy terms.",
            "Issuers see the purchases made in their own sales (wallet, amount and status), which are also public on the blockchain; they do not receive your verification data from us. Where you request a conversion of tokens into shares or a delivery of goods, where these services are offered, we share with the issuer, the custodian or a public register only the details needed to carry it out.",
            "Authorities, courts and our professional advisers, where the law requires it or where it is necessary to establish, exercise or defend legal claims, including reports that anti-money-laundering or sanctions law requires.",
            "A successor or trustee, if the business is transferred or wound down, bound by the same obligations as in this policy.",
          ],
        },
        {
          kind: "paragraph",
          text: "Anyone can read what is recorded on the blockchain (clause 2). We do not sell personal data and do not share it for advertising.",
        },
      ],
    },
    {
      title: "7. Where your data is processed",
      blocks: [
        {
          kind: "paragraph",
          text: "Our database and file storage are hosted in Ireland and our server functions run in Dublin, Ireland. Other service providers, for example for email, blockchain infrastructure, the bot check and Google sign-in, may process data in other countries, including the United States. The controller named at the top of this page is incorporated outside the European Economic Area, and our staff and service providers may access the data from other countries. Where the law that applies requires it, we protect these transfers with appropriate safeguards, such as the standard contractual clauses approved by the European Commission. Data on the blockchain is replicated worldwide.",
        },
      ],
    },
    {
      title: "8. How long we keep it",
      blocks: [
        {
          kind: "list",
          items: [
            "Verification data and documents, verification records and transaction records: while our relationship with you lasts and afterwards for the period that the anti-money-laundering and record-keeping laws that apply to us require. We then delete your documents and verification details and remove your name and contact details from your file. We keep a minimal record of our verification decisions and of your transactions, linked to your wallet, because the on-chain records cannot be removed and we must be able to account for them.",
            "Your account (display name, email address and linked Google account): until you ask us to delete it or we close the account.",
            "Issuer applications, messages and service requests: as long as we need them to handle the matter, and afterwards as long as the law or the defence of legal claims requires.",
            "Sanctions screening records and the log of our staff's actions: for the period that the law requires for compliance records.",
            "Your acceptances of our Terms: as long as the Terms can be relied on by you or by us, including after the rest of your file has been deleted.",
            "Email sign-in links expire after 20 minutes and are deleted after they expire. Links to confirm a new email address expire after 30 minutes; the new address stays pending in your account until you confirm it, cancel the change or ask for another link. One-time sign-in values are deleted within minutes after they expire. Hashed abuse counters are deleted after about a day without use.",
            "Copies of blockchain transactions in our database: we keep the decoded records to show your history and, once we have processed the raw notices we received about them, delete those notices 90 days after we received them.",
            "Request logs and error reports of our hosting and error-monitoring providers: for the periods those providers apply to our account.",
            "Data on the blockchain: permanently (clause 2).",
          ],
        },
      ],
    },
    {
      title: "9. Cookies and browser storage",
      blocks: [
        {
          kind: "paragraph",
          text: "We use only the cookies and browser storage the platform needs to work. We do not use analytics, advertising or tracking cookies.",
        },
        {
          kind: "list",
          items: [
            "manci_session: keeps you signed in with your wallet for up to 12 hours, so that you do not have to sign every request.",
            "manci_account: keeps you signed in to your account for up to 7 days after you sign in with an email link or Google.",
            "manci_google_link: protects a Google sign-in or the linking of a Google account while it is in progress, for up to 10 minutes.",
            "Browser storage, which stays on your device: the wallet you connected last, when your wallet session ends, how your wallet signs messages, the page to return to after sign-in, and the state of transactions you started but have not finished.",
          ],
        },
        {
          kind: "paragraph",
          text: "Cloudflare's bot check loads on the email sign-in and contact forms and processes information about your browser and connection to tell people from automated traffic. Your wallet is software from another provider, with its own privacy terms.",
        },
      ],
    },
    {
      title: "10. Your rights",
      blocks: [
        {
          kind: "paragraph",
          text: "Depending on where you live and on the law that applies to our processing, for example the EU General Data Protection Regulation, the UK General Data Protection Regulation or the Data Protection Act, 2021 of the British Virgin Islands, you may have the right to:",
        },
        {
          kind: "list",
          items: [
            "access your personal data and receive a copy of it;",
            "have inaccurate data corrected and incomplete data completed;",
            "have your data erased;",
            "have our processing of your data restricted;",
            "object to processing that we base on our legitimate interests;",
            "receive the data you gave us in a structured, machine-readable format and have it passed to someone else;",
            "withdraw a consent you gave;",
            "complain to a data protection supervisory authority, for example in the country where you live or work.",
          ],
        },
        {
          kind: "paragraph",
          text: "Some of these rights are limited: we cannot erase or change on-chain records (clause 2), and we may keep data that the law requires us to keep, or that we need for legal claims, until that period ends.",
        },
        {
          kind: "paragraph",
          text: "To exercise a right, write to the privacy contact shown at the top of this page. We will ask you to show that the data is yours, for example by signing a message with your wallet or by replying from your email address. We answer within one month; where the law allows a longer period for a complex request, we will tell you.",
        },
      ],
    },
    {
      title: "11. Security",
      blocks: [
        {
          kind: "paragraph",
          text: "We protect personal data with technical and organisational measures appropriate to the risk, including: encrypted connections; identity documents kept in private storage that browsers cannot reach directly; database tables with personal data closed to the public keys the website uses; staff access to documents through links that expire within minutes (two minutes for a single view, ten minutes in a data export), with every opening and export logged; wallet signatures for administrative actions; our company's hardware wallet, which holds the super administrator, KYC authority and Blocklist Authority roles and the treasury; and a multisig, with a separate hardware wallet as its member, that holds the authority to upgrade the on-chain programs. A second administrator uses a software wallet.",
        },
        {
          kind: "paragraph",
          text: "No system is completely secure. If a personal data breach affects you, we will inform you and the competent authorities where the law requires it.",
        },
      ],
    },
    {
      title: "12. Children",
      blocks: [
        {
          kind: "paragraph",
          text: "The platform is not intended for anyone under 18. We do not knowingly collect data about children; if we learn that we have, we will delete it unless the law requires us to keep it.",
        },
      ],
    },
    {
      title: "13. Changes to this policy",
      blocks: [
        {
          kind: "paragraph",
          text: "We may update this policy when our services or the law change. We will publish the new version on this page with a new date and, where a change is material and we have your email address, tell you by email before it takes effect.",
        },
      ],
    },
    {
      title: "14. Contact",
      blocks: [
        {
          kind: "paragraph",
          text: "Questions about this policy and requests about your personal data go to the privacy contact shown at the top of this page.",
        },
      ],
    },
  ],
};

/** The summary for the Terms acceptance dialog (components/tos-gate.tsx), version 2026-10-03 (wording confirmed by counsel on 2026-10-03). */
export const MAINNET_TOS_GATE_POINTS: string[] | null = [
  "You can buy in a primary sale only on the Manci site, with this wallet signed in, these Terms accepted and sanctions screening passed. Buying an open class needs no identity verification; converting tokens into company shares does.",
  "Tokens are bearer instruments held in your own wallet. A lost key or a confirmed transaction cannot be reversed, and a confirmed purchase is not refunded.",
  "Without your signature, the Operator can pause platform flows, freeze an issuer's proceeds, blocklist wallets (for example after a sanctions match or a purchase in a primary sale made outside the Manci site), and move the tokens of blocklisted holders, or, on a KYC-gated class, of holders whose passport was revoked or has been expired for at least 30 days, into a burn-only quarantine.",
  "The on-chain programs have had internal security reviews only, and no independent external audit. You can lose all of the money you commit, and no investor protection scheme covers it.",
  "Your acceptance is recorded against your wallet address and this version of the Terms.",
];
