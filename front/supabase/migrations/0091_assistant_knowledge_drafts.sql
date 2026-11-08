-- 0091: assistant knowledge DRAFTS for the features merged on 2026-11-08
-- (cap table, issuer updates, SEO, fee schedule, conversion timeline and
-- emails, issuer journey, token migration, certificates).
--
-- Every row is inserted as a draft: nothing here reaches the public assistant
-- until an Admin reviews it on /admin/assistant and publishes it (the
-- server's published projection reads published rows only, 0084). Entries
-- whose provenance names "Counsel review" carry legal wording to confirm
-- first. Two proposals were left out because 0084 already publishes the
-- same answer (platform-operator, fees-and-costs).
--
-- No new table or column: the rows take this deployment's network from
-- public.deployment_network(), like 0084's seed. Re-running the migration
-- never overwrites editorial work (on conflict do nothing).
begin;
set local lock_timeout = '15s';

insert into public.assistant_knowledge
  (network, id, title, category, keywords, body, sources, provenance, status)
select public.deployment_network(), seed.id, seed.title, seed.category, seed.keywords,
  seed.body, seed.sources, seed.provenance, 'draft'
from jsonb_to_recordset($manci_knowledge_drafts$
[
  {
    "id": "asset-supply-and-conversions",
    "title": "What does \"Supply and conversions\" on an asset page show?",
    "category": "answer",
    "keywords": [
      "supply",
      "max supply",
      "100 %",
      "issued",
      "outstanding",
      "circulating",
      "in conversion",
      "converted",
      "registered ownership",
      "cap table",
      "company register",
      "share register",
      "APR",
      "conversion record",
      "decision document",
      "SHA-256",
      "realize transaction",
      "burn",
      "ponuda",
      "udeo",
      "registar",
      "konverzija",
      "upisani udeo"
    ],
    "body": "Each asset page on Manci shows a Supply and conversions panel for every share class that has a token mint. It states what 100 % of the company is (the class's maximum supply in units, and what one unit is as a percentage), how many units were issued (the lifetime minted counter, which burns never lower), how many are outstanding (the circulating supply), how many sit in conversion custody (units deposited into open conversion escrows), and how many units were converted into registered ownership, with their number and their share of the company as recorded.\n\nBelow the figures, the conversion record lists each conversion recorded in the company register: the date of the registry decision, the units, the percentage of the company, the registry (for a Serbian company, the Business Registers Agency, APR), the SHA-256 of the registry decision document, and a link to the realize transaction on a Solana explorer, the transaction in which the escrowed units were burned.\n\nThe figures are read from the Solana programs and from the register entries the platform operator records after each registry decision. Case numbers and the identities of holders are not published. Whether conversion into registered ownership is offered at a given time depends on the Terms in force.",
    "sources": [
      {
        "title": "Explore assets",
        "href": "/marketplace"
      },
      {
        "title": "Custody & delivery",
        "href": "/solutions/custody"
      }
    ],
    "provenance": [
      {
        "title": "Pull request #86: Cap table: reconcile the chain with the company register (0086)",
        "section": "Assistant knowledge drafts",
        "date": "2026-11-08"
      },
      {
        "title": "Counsel review",
        "section": "Legal wording to be confirmed before publication",
        "date": "2026-11-08"
      }
    ]
  },
  {
    "id": "check-a-conversion-record",
    "title": "How can I check a conversion listed on an asset page?",
    "category": "procedure",
    "keywords": [
      "verify conversion",
      "check conversion",
      "conversion record",
      "registry decision",
      "decision document",
      "SHA-256",
      "hash",
      "shasum",
      "certutil",
      "realize transaction",
      "burn",
      "explorer",
      "APR",
      "provera",
      "rešenje",
      "heš"
    ],
    "body": "1. Open the asset's page on Manci and find the Supply and conversions panel.\n2. In the conversion record, find the row with the decision date and the number of units.\n3. Compute the SHA-256 of your copy of the registry decision document, for example with `shasum -a 256 <file>` on macOS or Linux, or `certutil -hashfile <file> SHA256` on Windows, and compare it with the published hash. Equal hashes mean it is the same document; a single changed byte gives a different hash.\n4. Open the realize transaction link. On the Solana explorer the transaction shows the escrowed units being burned from the conversion custody vault.\n5. Compare the figures: the units issued minus the units burned equal the units outstanding.\n\nThe panel does not publish case numbers or the identities of holders. The registered stake itself is recorded in the company register (for a Serbian company, the APR); the record on Manci points to that decision.",
    "sources": [
      {
        "title": "Explore assets",
        "href": "/marketplace"
      },
      {
        "title": "Security & controls",
        "href": "/security"
      }
    ],
    "provenance": [
      {
        "title": "Pull request #86: Cap table: reconcile the chain with the company register (0086)",
        "section": "Assistant knowledge drafts",
        "date": "2026-11-08"
      },
      {
        "title": "Counsel review",
        "section": "Legal wording to be confirmed before publication",
        "date": "2026-11-08"
      }
    ]
  },
  {
    "id": "issuer-updates-for-holders",
    "title": "Where do I find company updates and reports for tokens I hold?",
    "category": "answer",
    "keywords": [
      "updates",
      "company updates",
      "issuer updates",
      "reports",
      "quarterly report",
      "annual report",
      "financial statement",
      "notice",
      "investor relations",
      "holders only",
      "holder updates",
      "documents",
      "issuer news",
      "izveštaj",
      "kvartalni izveštaj",
      "godišnji izveštaj",
      "obaveštenje",
      "vesti kompanije"
    ],
    "body": "Issuers can publish updates for the holders of their tokens: company updates, quarterly and annual reports, financial statements and notices, each with up to ten documents. Public updates appear on the asset's page under \"Updates from the issuer\". Some updates are for holders only: they are shown to a wallet only after the platform reads on chain that the wallet holds units of one of that asset's share classes (for an update that covers every asset of the issuer, units of one of the issuer's assets). Holders also see the updates of the companies they hold on their portfolio page. Updates are written and published by the issuer: Manci checks that each document matches its recorded SHA-256 fingerprint, but it does not verify what an update says. A published update cannot be edited. The issuer can withdraw it with a reason, and the platform can withdraw it in moderation; a withdrawn update is no longer shown.",
    "sources": [
      {
        "title": "Explore assets",
        "href": "/marketplace",
        "section": "Asset pages: Updates from the issuer"
      }
    ],
    "provenance": [
      {
        "title": "Pull request #87: Investor relations: issuer updates, reports and verified documents for holders",
        "section": "Assistant knowledge drafts",
        "date": "2026-11-08"
      }
    ]
  },
  {
    "id": "verify-issuer-update-document",
    "title": "How can I check that an issuer's document has not been changed?",
    "category": "procedure",
    "keywords": [
      "verify document",
      "document hash",
      "sha-256",
      "sha256",
      "fingerprint",
      "checksum",
      "shasum",
      "certutil",
      "tampered",
      "changed document",
      "anchored on chain",
      "memo",
      "provera dokumenta",
      "heš",
      "otisak dokumenta"
    ],
    "body": "Every document attached to an issuer update shows its SHA-256 fingerprint, which the server computed from the stored file when it was uploaded; the stored file cannot be replaced afterwards. To check a copy: 1) open the document from the update and save it; 2) compute its SHA-256 (macOS or Linux: shasum -a 256 <file>; Windows: certutil -hashfile <file> SHA256); 3) compare the result with the fingerprint shown next to the document (Copy puts the full value on the clipboard). If they differ, the file is not the published one. When an update shows \"Anchored on chain by the issuer\", its transaction carries a memo the issuer's wallet signed: \"manci-update:<update id> sha256:<fingerprint of the published update>\". That fingerprint covers the update's text and the SHA-256 of every document, so the transaction fixes what was published and when. It does not confirm that the content is accurate.",
    "sources": [
      {
        "title": "Explore assets",
        "href": "/marketplace",
        "section": "Asset pages: Updates from the issuer"
      }
    ],
    "provenance": [
      {
        "title": "Pull request #87: Investor relations: issuer updates, reports and verified documents for holders",
        "section": "Assistant knowledge drafts",
        "date": "2026-11-08"
      }
    ]
  },
  {
    "id": "official-manci-website-and-accounts",
    "title": "Which website and social account are Manci's own?",
    "category": "answer",
    "keywords": [
      "official",
      "website",
      "domain",
      "www.manci.io",
      "manci.io",
      "x",
      "twitter",
      "manci_rwa",
      "social media",
      "impersonation",
      "fake account",
      "scam",
      "phishing",
      "seed phrase",
      "private key",
      "contact",
      "support"
    ],
    "body": "Manci's website is https://www.manci.io. Its account on X is @Manci_rwa (https://x.com/Manci_rwa), linked from the site's pages. Support requests go through the contact form at https://www.manci.io/contact, and the Company and licence page lists the operator's legal, privacy and security contacts.\n\nManci is self-custodial: you alone control your wallet's private keys and seed phrase, and the operator cannot sign for you or recover a lost key (Terms of Service, clause 5). Never share a seed phrase or a private key with anyone, including someone who says they are from Manci. If you are unsure whether a site, account or message is genuine, open https://www.manci.io yourself and use the contact form.",
    "sources": [
      {
        "title": "Contact & support",
        "href": "/contact"
      },
      {
        "title": "Company and licence",
        "href": "/legal/company"
      },
      {
        "title": "Terms of Service",
        "href": "/legal/terms",
        "section": "5. Your wallet, keys and transactions"
      }
    ],
    "provenance": [
      {
        "title": "Pull request #88: Search indexing readiness, the freshness heartbeat in /api/health, distribution test timeout",
        "section": "Assistant knowledge drafts",
        "date": "2026-11-08"
      },
      {
        "title": "Counsel review",
        "section": "Legal wording to be confirmed before publication",
        "date": "2026-11-08"
      }
    ]
  },
  {
    "id": "conversion-fee-shown-before-request",
    "title": "Will I see any fee before I request a conversion?",
    "category": "procedure",
    "keywords": [
      "conversion fee",
      "convert",
      "registered ownership",
      "conversion request",
      "notary",
      "business register",
      "invoice",
      "pricing"
    ],
    "body": "Yes. Where conversion into registered ownership is offered, the conversion request form shows any Manci fee published for conversion before you submit: the amount, who pays it and when it is invoiced, with a link to the Pricing page. If no conversion fee is published, the form shows none. Fees are invoiced in euros after the request is approved, off-chain; the tokens you deposit into escrow are not used to pay them. Notary and business-register costs are third-party costs, quoted before work starts.",
    "sources": [
      {
        "title": "Pricing",
        "href": "/pricing"
      },
      {
        "title": "Terms of Service",
        "href": "/legal/terms",
        "section": "11. Fees"
      }
    ],
    "provenance": [
      {
        "title": "Pull request #89: Fees: admin-controlled fee schedule, charges ledger and published pricing (0089)",
        "section": "Assistant knowledge drafts",
        "date": "2026-11-08"
      }
    ]
  },
  {
    "id": "conversion-steps-and-durations",
    "title": "How long does converting tokens into registered company shares take?",
    "category": "procedure",
    "keywords": [
      "conversion",
      "convert tokens",
      "registered shares",
      "timeline",
      "how long",
      "duration",
      "notary",
      "business register",
      "APR",
      "escrow",
      "vault deadline",
      "burn",
      "konverzija",
      "koliko traje"
    ],
    "body": "Where conversion is offered, a request moves through five steps: Requested; Approved, escrow vault open; Units in escrow; Notary and business register filing (off-chain); Registered, units burned. Typical durations, not guaranteed: Manci reviews a request in about 2 business days; you deposit the units any time until the escrow vault's on-chain deadline; the notary appointment and the filing typically take 5-10 business days; the register's decision typically follows about 5 business days after the filing, after which the escrowed units are burned. A request can also end as Cancelled (before any deposit; no units move) or Returned (the escrowed units go back to your wallet; after the vault deadline you can reclaim them yourself). Your Conversion page shows each request's current step, who acts next and the vault deadline, and Manci emails you when the status changes. Converting requires a verified identity (KYC) and an approved investor passport.",
    "sources": [
      {
        "title": "Custody and conversion",
        "href": "/solutions/custody"
      },
      {
        "title": "Legal structure",
        "href": "/legal-structure"
      }
    ],
    "provenance": [
      {
        "title": "Pull request #92: Conversion timeline, conversion status emails and a portfolio CSV export",
        "section": "Assistant knowledge drafts",
        "date": "2026-11-08"
      },
      {
        "title": "Counsel review",
        "section": "Legal wording to be confirmed before publication",
        "date": "2026-11-08"
      }
    ]
  },
  {
    "id": "portfolio-csv-export",
    "title": "Can I export my Manci transactions for my own records?",
    "category": "answer",
    "keywords": [
      "export",
      "CSV",
      "records",
      "bookkeeping",
      "cost basis",
      "FIFO",
      "accountant",
      "tax records",
      "transaction history",
      "izvoz",
      "porez"
    ],
    "body": "Yes. Portfolio, Activity (/portfolio/history) has an Export CSV button. The file lists one row per event: the date (UTC), asset, share class, event type, units in and out, the price and total in USDC where Manci recorded one, the EUR equivalent where the platform has a USDC/EUR rate for that day, and the transaction signature, followed by a FIFO cost-basis summary per share class (units held, cost basis, average cost, realized results). Units received without a known price, such as a transfer from another wallet, have an unknown cost, and units sent without one have unknown proceeds; those rows are flagged for you to complete from your own records. Units burned when converted into registered shares are listed as a disposal with zero proceeds. The file is generated in your browser from your own records after one wallet sign-in. It is a record for your own bookkeeping, not tax advice; ask a tax adviser how to report it.",
    "sources": [
      {
        "title": "Investor guide",
        "href": "/investors"
      }
    ],
    "provenance": [
      {
        "title": "Pull request #92: Conversion timeline, conversion status emails and a portfolio CSV export",
        "section": "Assistant knowledge drafts",
        "date": "2026-11-08"
      }
    ]
  },
  {
    "id": "conversion-status-emails",
    "title": "Will Manci email me about my conversion request?",
    "category": "answer",
    "keywords": [
      "email",
      "notification",
      "conversion status",
      "request update",
      "deposit",
      "escrow",
      "cancelled",
      "returned",
      "obavestenje",
      "mejl"
    ],
    "body": "Yes. Each status change of a conversion request (received, escrow vault open, units in escrow, registered and burned, cancelled, returned) sends you one short email: to the address you confirmed for your account, otherwise the one in your verified profile, otherwise the contact you entered on the request if it is an email address. The email names the request, the asset and units, what happens next and, where there is one, the transaction. It never contains your identity documents or other verification data, and Manci never asks for your recovery phrase or private keys. Your Conversion page always shows the current status, even if an email does not arrive.",
    "sources": [
      {
        "title": "Privacy Policy",
        "href": "/legal/privacy"
      },
      {
        "title": "Custody and conversion",
        "href": "/solutions/custody"
      }
    ],
    "provenance": [
      {
        "title": "Pull request #92: Conversion timeline, conversion status emails and a portfolio CSV export",
        "section": "Assistant knowledge drafts",
        "date": "2026-11-08"
      },
      {
        "title": "Counsel review",
        "section": "Legal wording to be confirmed before publication",
        "date": "2026-11-08"
      }
    ]
  },
  {
    "id": "issuing-from-outside-serbia",
    "title": "My company is outside Serbia. Can it issue on Manci?",
    "category": "answer",
    "keywords": [
      "outside Serbia",
      "foreign company",
      "SPV",
      "special purpose vehicle",
      "Serbian company",
      "incorporation",
      "BVI",
      "Delaware",
      "strana firma",
      "firma van Srbije",
      "osnivanje",
      "srpski SPV"
    ],
    "body": "Company ownership, debt and revenue share on Manci are issued by a Serbian company. A company incorporated elsewhere, or a founder without a company, can ask in the application for Manci to incorporate a Serbian special-purpose vehicle (SPV) by ticking \"I want Manci to incorporate a Serbian SPV for this issuance\". Manci incorporates and administers the SPV for the issuance; the notary certification and the registration with the Serbian Business Registers Agency (APR) happen outside the platform. You usually provide identity verification on Manci (KYC or KYB), your company's registry extract and founding documents, who owns and controls the company, the decision of its competent body approving the issuance, and the issuance terms; the exact list is confirmed for your engagement. Incorporation, notary, registry, translation and legal drafting are third-party costs, quoted per engagement before any work starts. Whether an instrument needs an SPV, and the SPV's role, is confirmed for each case; this answer is not legal advice.",
    "sources": [
      {
        "title": "Issuing through a Serbian SPV",
        "href": "/solutions/serbian-spv"
      },
      {
        "title": "Fees & costs",
        "href": "/pricing"
      },
      {
        "title": "Legal structure",
        "href": "/legal-structure",
        "section": "Built per issuance, not assumed once"
      }
    ],
    "provenance": [
      {
        "title": "Pull request #93: Issuer journey tracker, a Serbian SPV path for companies outside Serbia, and an ESOP vesting preset",
        "section": "Assistant knowledge drafts",
        "date": "2026-11-08"
      },
      {
        "title": "Counsel review",
        "section": "Legal wording to be confirmed before publication",
        "date": "2026-11-08"
      }
    ]
  },
  {
    "id": "esop-vesting",
    "title": "Can a company vest tokens to its employees (ESOP)?",
    "category": "answer",
    "keywords": [
      "ESOP",
      "employee equity",
      "employees",
      "vesting",
      "cliff",
      "grant",
      "team allocation",
      "zaposleni",
      "opcije za zaposlene",
      "vesting raspored"
    ],
    "body": "Where the vesting module is offered, a company can set up a vesting series with the ESOP preset: nothing unlocks for the first 12 months, then 25% of the allocation, then 1/48 every month until month 48. Amounts are exact whole units, and every setting can be changed before the terms are submitted for review. Approval timing only delays delivery: a vested tranche is delivered once the company approves it or when the approval window lapses. Cancelling a series stops future vesting for every recipient of that series, and each keeps what has vested, so leaver terms per person need one series per grant. The plan's own terms (who is granted what, leaver terms, tax and employment matters) are the company's document. Vesting series are a pilot module; check whether it is offered on your network.",
    "sources": [
      {
        "title": "Employee equity (ESOP) vesting",
        "href": "/solutions/esop"
      },
      {
        "title": "Vesting & claims",
        "href": "/solutions/rights-vesting"
      }
    ],
    "provenance": [
      {
        "title": "Pull request #93: Issuer journey tracker, a Serbian SPV path for companies outside Serbia, and an ESOP vesting preset",
        "section": "Assistant knowledge drafts",
        "date": "2026-11-08"
      },
      {
        "title": "Counsel review",
        "section": "Legal wording to be confirmed before publication",
        "date": "2026-11-08"
      }
    ]
  },
  {
    "id": "issuance-steps-and-whose-turn",
    "title": "What are the steps of an issuance, and how do I see whose turn it is?",
    "category": "procedure",
    "keywords": [
      "issuance steps",
      "issuer journey",
      "whose turn",
      "status",
      "next step",
      "koraci izdavanja",
      "status izdavanja",
      "ko je na potezu",
      "KYB",
      "application"
    ],
    "body": "An issuance runs in eight steps: company verification (KYB); application review; the legal structure (a Serbian company issuing directly, or a Serbian SPV that Manci incorporates); the shareholders' decision and the issuance documents, whose hash is recorded on the asset; the asset and its share classes on-chain; units minted; placement, through an approved primary sale or direct issuance to named holders; and holders, who can convert units into registered ownership with KYC where conversion is offered. The issuer workspace shows each step's status and who acts next: your company, Manci or the token holders. Steps that happen outside the platform, such as notary and business-register filings, are marked as such.",
    "sources": [
      {
        "title": "Issuing an asset",
        "href": "/how-it-works"
      },
      {
        "title": "Issuer registration & KYB",
        "href": "/solutions/issuer-registry"
      },
      {
        "title": "Issuing through a Serbian SPV",
        "href": "/solutions/serbian-spv"
      }
    ],
    "provenance": [
      {
        "title": "Pull request #93: Issuer journey tracker, a Serbian SPV path for companies outside Serbia, and an ESOP vesting preset",
        "section": "Assistant knowledge drafts",
        "date": "2026-11-08"
      }
    ]
  },
  {
    "id": "verify-a-certificate",
    "title": "How do I check a Manci certificate?",
    "category": "procedure",
    "keywords": [
      "certificate",
      "verify certificate",
      "check certificate",
      "certificate number",
      "MC-2026",
      "authority",
      "proof of holding",
      "SHA-256",
      "signature",
      "anchor",
      "potvrda",
      "sertifikat"
    ],
    "body": "Manci certificates of tokenized interest carry a number such as MC-2026-0001 and a SHA-256 fingerprint. Open the verification page and enter the number with the SHA-256 printed on the certificate, or choose the certificate's JSON file, which is read in your browser and not uploaded; the link printed on the certificate fills in both. With the number alone the page says only whether the certificate exists and is valid or revoked. With the fingerprint it also shows what the certificate states: the company, the asset and share class, the units and the share of the company at the Solana slot it names, the signer's key, the signature and the anchor transaction. It never shows a holder's name or identification number; if your copy of the JSON matches the fingerprint, the holder details in it are the ones that were signed. A valid certificate states on-chain facts at the slot it names; a holding may have changed since.",
    "sources": [
      {
        "title": "Verify a certificate",
        "href": "/certificates/verify"
      }
    ],
    "provenance": [
      {
        "title": "Pull request #91: Certificates of tokenized interest: issue, sign, anchor, print and verify (0087)",
        "section": "Assistant knowledge drafts",
        "date": "2026-11-08"
      }
    ]
  },
  {
    "id": "certificate-of-tokenized-interest",
    "title": "What is a certificate of tokenized interest?",
    "category": "answer",
    "keywords": [
      "certificate",
      "certificate of tokenized interest",
      "holding certificate",
      "issuance certificate",
      "confirmation for authorities",
      "proof of ownership",
      "state authority",
      "tax office",
      "court",
      "bank"
    ],
    "body": "A certificate of tokenized interest is a numbered document the platform operator issues, for example for an authority. A holding certificate states how many units of a share class a wallet held at a given Solana slot and what share of the company they stand for on the asset's scale; an issuance certificate states a share class as issued (its maximum supply, the units issued and in circulation). Each certificate is signed with the operator's Super Admin wallet key and its fingerprint is anchored on Solana, so whoever holds it can check it with its number and fingerprint. It is not an extract from a company register and does not by itself transfer or register an interest: the rights attached to the units are those set out in the asset's legal documentation. To ask for one, contact the Manci team.",
    "sources": [
      {
        "title": "Verify a certificate",
        "href": "/certificates/verify"
      },
      {
        "title": "Contact & support",
        "href": "/contact"
      }
    ],
    "provenance": [
      {
        "title": "Pull request #91: Certificates of tokenized interest: issue, sign, anchor, print and verify (0087)",
        "section": "Assistant knowledge drafts",
        "date": "2026-11-08"
      },
      {
        "title": "Counsel review",
        "section": "Legal wording to be confirmed before publication",
        "date": "2026-11-08"
      }
    ]
  },
  {
    "id": "token-migration-overview",
    "title": "Can a company bring its existing token holders to Manci?",
    "category": "answer",
    "keywords": [
      "token migration",
      "migrate a token",
      "existing token",
      "token swap",
      "exchange token",
      "token holders",
      "community",
      "share class",
      "units",
      "lot",
      "ratio",
      "opt-in window",
      "Swap Terms",
      "SPL token",
      "Token-2022",
      "Solana",
      "company shares",
      "migracija tokena"
    ],
    "body": "Where Manci offers a token migration campaign, a company that already issued a token on Solana can give that token's holders units of its share class on Manci. The company's shareholders decide what share of the company goes to the holders, and the campaign publishes a fixed ratio: one unit for every lot of the old token. The lot is rounded up to a round number, so the units can never add up to more than the shareholders decided. Holders opt in during a window of 60 to 90 days by depositing whole lots from their own wallet; Manci's operator then sends their units from the company's treasury wallet to the same wallet. Each campaign has its own Swap Terms, published with their SHA-256 hash, which set the ratio, the window, what happens to units nobody claims and what the units represent. The exchange itself needs no identity verification; converting units into a registered ownership stake later is a separate step that requires KYC, where it is offered. Each campaign page lists every deposit and delivery as proof, and a final report with its hash once the campaign completes. A campaign is not investment advice and does not promise any value.",
    "sources": [
      {
        "title": "Token migrations",
        "href": "/migrations"
      }
    ],
    "provenance": [
      {
        "title": "Pull request #90: Token migration V1: exchange an existing Solana token for Manci share-class units",
        "section": "Assistant knowledge drafts",
        "date": "2026-11-08"
      },
      {
        "title": "Counsel review",
        "section": "Legal wording to be confirmed before publication",
        "date": "2026-11-08"
      }
    ]
  },
  {
    "id": "token-migration-how-to-deposit",
    "title": "How do I exchange my tokens in a token migration campaign?",
    "category": "procedure",
    "keywords": [
      "how to migrate",
      "deposit tokens",
      "token migration deposit",
      "lots",
      "memo",
      "retry recording",
      "my deposits",
      "portfolio migration",
      "wallet",
      "sign",
      "window",
      "delivery",
      "units",
      "exchange tokens",
      "Swap Terms"
    ],
    "body": "1. Open the campaign under Token migrations and read its Swap Terms: the ratio (one unit per lot), the window dates and the rules for deposits.\n2. Connect the wallet that holds the old token and open Migrate a token in your portfolio, where it is offered. The page shows your balance and how many whole lots you can deposit.\n3. Choose the number of lots. Manci checks the campaign, your wallet and that you accepted the Terms in force; your wallet then asks you to sign one transaction that sends exactly that many lots to the campaign's deposit account, with a memo naming the campaign.\n4. Keep the page open until the deposit is final (usually 15 to 30 seconds) and sign once more to record it. If the page closes first, it offers Retry recording the next time; never deposit the same tokens again.\n5. Manci's operator delivers your units to the same wallet. My deposits and the campaign page show the deposit and the delivery transactions.\nDeposits cannot be withdrawn. A deposit that is not a whole number of lots, arrives outside the window, comes from an excluded wallet or exceeds the campaign's units cap is returned in full to the wallet it came from.",
    "sources": [
      {
        "title": "Token migrations",
        "href": "/migrations",
        "section": "How a migration works"
      }
    ],
    "provenance": [
      {
        "title": "Pull request #90: Token migration V1: exchange an existing Solana token for Manci share-class units",
        "section": "Assistant knowledge drafts",
        "date": "2026-11-08"
      },
      {
        "title": "Counsel review",
        "section": "Legal wording to be confirmed before publication",
        "date": "2026-11-08"
      }
    ]
  },
  {
    "id": "token-migration-refunds-and-proof",
    "title": "What happens to a token migration deposit that breaks the rules, and how can I check a campaign?",
    "category": "policy",
    "keywords": [
      "refund",
      "irregular deposit",
      "returned tokens",
      "outside the window",
      "not a whole lot",
      "excluded wallet",
      "units cap",
      "held for review",
      "compliance",
      "cancelled campaign",
      "proof",
      "final report",
      "SHA-256",
      "hash",
      "explorer",
      "token migration"
    ],
    "body": "A token migration deposit earns units only when it is a whole number of lots (at least one), arrives inside the campaign's window, comes from a wallet that is not excluded, fits under the campaign's units cap and carries the campaign's memo. Any other deposit is recorded as irregular and returned in full to the wallet it came from; no units are delivered for it. A deposit from a wallet that matches a sanctions list is held for review: it is neither delivered nor returned until the compliance review concludes. If a campaign is cancelled before any unit is delivered, its accepted deposits are returned as well. Every campaign page lists each deposit with its wallet, amount, units, status and transactions, so anyone can check it on a Solana explorer. When a campaign completes, Manci publishes a final report of every deposit, delivery and refund with its SHA-256 hash: download the file and compare its hash with the one on the campaign page.",
    "sources": [
      {
        "title": "Token migrations",
        "href": "/migrations"
      }
    ],
    "provenance": [
      {
        "title": "Pull request #90: Token migration V1: exchange an existing Solana token for Manci share-class units",
        "section": "Assistant knowledge drafts",
        "date": "2026-11-08"
      },
      {
        "title": "Counsel review",
        "section": "Legal wording to be confirmed before publication",
        "date": "2026-11-08"
      }
    ]
  }
]
$manci_knowledge_drafts$::jsonb) as seed
  (id text, title text, category text, keywords text[], body text, sources jsonb, provenance jsonb)
on conflict (network, id) do nothing;

commit;
