/**
 * Curated public-facing summaries, not a live deployment or legal-status feed.
 *
 * Evidence reviewed:
 * - outputs/partner-integration-2026-11-05/build/deck.mjs (primary presentation).
 * - outputs/metaplex-technical-2026-11-05/build/deck.mjs (proposed integration).
 * - outputs/deck-intro-2026-10-22/deck.txt (older overview; newer evidence wins).
 * - Existing public guides linked below. Links are public reading/next steps;
 *   private presentation attachments are intentionally not exposed.
 *
 * Do not infer country authorisation, an appointed law firm, a licence, legal
 * sufficiency, guaranteed return, or live availability from these summaries.
 * Older guides contain devnet-only and freely-transferable generalisations;
 * newer presentation evidence and class-specific controls qualify those claims.
 * No wallet inventories, personal documents, keys or operational state belong here.
 */
export const KNOWLEDGE_VERSION = "2026-11-07";

export type KnowledgeEntry = {
  id: string;
  updatedAt?: string;
  category?: "answer" | "policy" | "procedure";
  title: string;
  keywords: string[];
  answer: string;
  sources: { title: string; href: string; section?: string }[];
  provenance?: { title: string; section: string; date: string }[];
};

export const KNOWLEDGE_ENTRIES: KnowledgeEntry[] = [
  {
    id: "platform-operator",
    title: "Where is the Manci platform operator registered?",
    keywords: ["operator", "registered company", "headquarters", "incorporated", "BVI", "British Virgin Islands", "Manci International", "platform jurisdiction"],
    answer: "The published mainnet operator record identifies Manci International Ltd., incorporated in the British Virgin Islands, company number 2219023. The mainnet service Terms use BVI law and courts. The platform operator is distinct from the issuer and the company whose shares are tokenized: their jurisdictions and the legal transfer process are determined by the specific issuance. A Serbian company-interest pilot does not make the platform operator a Serbian company or establish worldwide offering permissions. See Company & licence and the applicable Terms for the published details.",
    sources: [{ title: "Company & licence", href: "/legal/company" }, { title: "Terms of Service", href: "/legal/terms" }],
    provenance: [{ title: "Published Manci mainnet operator record", section: "Platform entity, governing law and issuer distinction", date: "2026-11-07" }],
  },
  // Partner deck, slide 2 "Manci on Solana"; slide 17 "System responsibilities".
  {
    id: "what-is-manci",
    provenance: [{"title": "Manci — Partner Integration presentation", "section": "Slide 2: Manci on Solana", "date": "2026-11-05"}, {"title": "Manci — Partner Integration presentation", "section": "Slide 17: System responsibilities", "date": "2026-11-05"}],
    title: "What is Manci?",
    keywords: ["manci", "mancipatio", "platform", "platforma", "tokenization", "tokenizacija", "rwa", "solana", "šta radite"],
    answer: "Manci combines legal structuring and Solana software for issuing and managing tokens linked to documented asset rights. The issuance documents define the claim; the platform records tokens, eligibility, escrow and transactions. The platform operator, the asset issuer and the company whose interests are involved are distinct roles. A token does not create legal rights beyond its issuance terms.",
    sources: [{ title: "Issuing an asset", href: "/how-it-works" }, { title: "Legal structure", href: "/legal-structure" }],
  },
  // Partner deck, slide 3 "How the token relates to the company" takes precedence
  // over intro deck slide 3 "Every token is a right to a real company share".
  {
    id: "token-and-legal-ownership",
    provenance: [{"title": "Manci — Partner Integration presentation", "section": "Slide 3: How the token relates to the company", "date": "2026-11-05"}],
    title: "Does buying a token make me a company owner?",
    keywords: ["ownership", "owner", "own", "owning", "shareholder", "share", "vlasništvo", "vlasnik", "vlasnič", "posedujem", "posedovanje", "udeo", "akcija", "član kompanije", "pravno", "vlasnička struktura", "token to ownership", "token u vlasništvo"],
    answer: "Holding a token gives the rights defined in that token's issuance instrument. For a convertible company-interest token, this can include a right to acquire a registered company interest. Registered membership follows a separate legal transfer and registry process; moving tokens between wallets does not itself update the company register. Check the issuer, underlying company, rights, unit ratio and conversion conditions in the specific issuance documents.",
    sources: [{ title: "Legal structure", href: "/legal-structure", section: "Built per issuance, not assumed once" }, { title: "Company ownership", href: "/markets/types/equity" }],
  },
  // Partner deck, slide 13 "Conversion into registered ownership". Its notes
  // distinguish the intended flow from historical pilot chronology.
  {
    id: "conversion-process",
    category: "procedure",
    provenance: [{"title": "Manci — Partner Integration presentation", "section": "Slide 13: Conversion into registered ownership", "date": "2026-11-05"}],
    title: "How does token conversion into a registered interest work?",
    keywords: ["convert", "conversion", "redeem", "konverzija", "konver", "pretvaranje", "pretvar", "vlasnič", "vlasnička struktura", "registracija", "APR", "burn", "spaljivanje", "pravni prenos", "koraci"],
    answer: "The documented workflow is: check the beneficiary and conversion terms, place the required tokens in escrow, execute the legal company-interest transfer and obtain registry evidence, then have the authorised operator record the evidence and retire the relevant tokens. Records are reconciled afterwards. In Serbia the company registry is APR. The smart contract can handle token custody and burning; it cannot perform the legal transfer or update APR by itself. The exact documents and sequence are agreed for the issuance.",
    sources: [{ title: "Legal structure", href: "/legal-structure" }, { title: "Custody & delivery", href: "/solutions/custody" }],
  },
  // Partner deck, slide 8 "Partial company tokenization". Deliberately use its
  // illustrative example, not the private pilot's member or balance details.
  {
    id: "token-percentage",
    provenance: [{"title": "Manci — Partner Integration presentation", "section": "Slide 8: Partial company tokenization", "date": "2026-11-05"}],
    title: "How much of a company does one token represent?",
    keywords: ["percentage", "percent", "ratio", "supply", "procenat", "postotak", "odnos", "jedan token", "1 token", "20%", "cap table", "deo kompanije"],
    answer: "There is no universal ratio: the issuer defines the selected company portion and the percentage represented by each token in the instrument. Illustratively, a 20% portion at 0.001% of the whole company per token gives 20,000 tokens. Then 1,000 tokens represent rights to 1% of the whole company, or 5% of that token pool. These are example figures, not an offer or automatic registered ownership.",
    sources: [{ title: "Share classes & supply", href: "/solutions/share-classes" }, { title: "Company ownership", href: "/markets/types/equity" }],
  },
  // Partner deck, slide 6 "APR registered security for a token claim" expressly
  // rejects blanket security/licence inferences. /legal-structure and /risks agree.
  {
    id: "pledge-and-enforcement",
    provenance: [{"title": "Manci — Partner Integration presentation", "section": "Slide 6: APR registered security for a token claim", "date": "2026-11-05"}],
    title: "What protects the token holder if the issuer does not perform?",
    keywords: ["pledge", "lien", "collateral", "security", "enforcement", "zaloga", "založno", "obezbeđenje", "zaštita", "ne ispuni", "garancija", "default", "recourse"],
    answer: "The instrument defines the issuer's obligations and the holder's enforcement route. Some structures include a registered pledge over a company interest, but its beneficiary, secured claim, amount and scope must be checked for that issuance. A pledge documented for one pilot is not blanket collateral for every token holder or future issuance. Legal recourse can take time and cost money; a registered claim does not guarantee recovery.",
    sources: [{ title: "Legal structure", href: "/legal-structure" }, { title: "Risk disclosure", href: "/risks", section: "Conversion runs through an off-chain legal process" }],
  },
  // Partner deck, slide 7 "The APR decision is anchored in the conversion";
  // slide 10 "Token issuance". A matching hash is not legal approval.
  {
    id: "documents-and-proof",
    provenance: [{"title": "Manci — Partner Integration presentation", "section": "Slide 7: The APR decision is anchored in the conversion", "date": "2026-11-05"}, {"title": "Manci — Partner Integration presentation", "section": "Slide 10: Token issuance", "date": "2026-11-05"}],
    title: "Which documents establish my rights?",
    keywords: ["documents", "whitepaper", "hash", "proof", "dokumenti", "dokumentacija", "ugovor", "bela knjiga", "dokaz", "terms", "prava"],
    answer: "Read the documents for the exact asset and class: who owes the obligation, what the token represents, conversion and transfer conditions, and any security or income rights. The document library distinguishes fixed, server-verified versions from historical references. A file hash links a record to exact document bytes; it does not independently prove legal validity or regulatory approval. A primary purchase records the document version accepted at that time.",
    sources: [{ title: "Whitepapers & disclosures", href: "/markets/whitepapers" }, { title: "Investor guide", href: "/investors", section: "Before your first purchase" }],
  },
  // Partner deck, slides 4 "The documented pilot", 5 "APR recorded the ownership
  // change", 7 "The APR decision is anchored in the conversion". No attachments,
  // member names, addresses or private case identifiers are published here.
  {
    id: "documented-pilot",
    provenance: [{"title": "Manci — Partner Integration presentation", "section": "Slide 4: The documented pilot", "date": "2026-11-05"}, {"title": "Manci — Partner Integration presentation", "section": "Slide 7: The APR decision is anchored in the conversion", "date": "2026-11-05"}],
    title: "Has the token-to-ownership process been demonstrated?",
    keywords: ["pilot", "proven", "demonstrated", "example", "first conversion", "dokazano", "primer", "prva konverzija", "APR odluka", "mainnet pilot"],
    answer: "The November 2026 presentation documents a Serbian pilot with an APR ownership-change decision and a separate Solana custody-and-burn record linked by the document hash. Those are distinct legal and blockchain records, with separate dates; the legal decision preceded the token burn. This demonstrates that specific case, not automatic registry updates or approval of every future issuance. Ask the team for the appropriate public evidence and the terms relevant to your proposed issuance.",
    sources: [{ title: "Ask the team for pilot evidence", href: "/contact" }, { title: "Legal structure", href: "/legal-structure" }],
  },
  // Partner deck, slide 15 "Geographic access and jurisdiction rules"; intro
  // deck slide 9 describes expansion ambitions, not licensed country coverage.
  {
    id: "supported-countries",
    provenance: [{"title": "Manci — Partner Integration presentation", "section": "Slide 15: Geographic access and jurisdiction rules", "date": "2026-11-05"}],
    title: "In which countries can Manci operate?",
    keywords: ["countries", "country", "jurisdiction", "supported", "zemlje", "zemlja", "zemlj", "države", "držav", "jurisdikcija", "Srbija", "Serbia", "EU", "USA", "UK", "Balkan", "Dubai", "Croatia", "Hrvatska", "global"],
    answer: "The reviewed materials document a Serbian company-interest pilot. They do not establish a verified worldwide list of authorised offerings, licensed services or supported investor countries. Availability must be confirmed for the issuer's country, the underlying asset, the instrument and the investor's residence/status. A country appearing in a presentation, country selector or team biography is not proof that an offering is permitted there. Send those details to the team for a specific assessment.",
    sources: [{ title: "Discuss your jurisdiction", href: "/contact" }, { title: "Legal structure", href: "/legal-structure", section: "Working through a specific structure" }],
  },
  // Partner deck, slides 11 "Investor verification and wallet eligibility",
  // 14 "Wallet allowlists and transfer policy", 15 "Geographic access...".
  {
    id: "investor-geography",
    provenance: [{"title": "Manci — Partner Integration presentation", "section": "Slide 11: Investor verification and wallet eligibility", "date": "2026-11-05"}, {"title": "Manci — Partner Integration presentation", "section": "Slide 15: Geographic access and jurisdiction rules", "date": "2026-11-05"}],
    title: "Can I invest from my country?",
    keywords: ["eligible", "eligibility", "residency", "invest from", "mogu li", "investiram", "prebivalište", "rezident", "državljanstvo", "geoblock", "VPN", "blocked country", "dozvoljeno"],
    answer: "Eligibility is assessed for the selected offering and wallet, including identity status, jurisdiction, expiry and any instrument-specific restrictions. Application geographic controls and on-chain wallet rules are different layers; accessing the website is not an eligibility approval. The knowledge base cannot approve a country or person, and a VPN does not establish legal eligibility. Ask the team about your residence, issuer and intended instrument before committing funds.",
    sources: [{ title: "Eligibility & passports", href: "/solutions/compliance" }, { title: "Contact & support", href: "/contact" }],
  },
  // Intro deck slide 9 "A lean team, raising a seed round" identifies legal
  // roles. It is not a verified directory of retained firms or local mandates.
  {
    id: "lawyers-and-local-counsel",
    provenance: [{ title: "From token to registered owner", section: "Slide 9: A lean team, raising a seed round — legal roles only; no country-specific engagement mandate", date: "2026-10-22" }],
    title: "Which lawyers or law firms work with Manci?",
    keywords: ["lawyer", "lawyers", "law firm", "counsel", "attorney", "legal team", "advokat", "advokati", "advokatska kancelarija", "pravnici", "pravnik", "pravni tim", "ko radi pravno", "partneri"],
    answer: "Manci has a legal team for structuring instruments and preparing documentation. For your issuance, ask the team to confirm the responsible lawyer, country, scope of work and quotation. The reviewed materials do not establish a universal law-firm mandate or representation in every country; the engagement needs to be confirmed for your case.",
    sources: [{ title: "Contact the legal team", href: "/contact", section: "What happens next" }, { title: "Legal structure", href: "/legal-structure" }],
  },
  // Partner deck slide 3; /legal-structure explicitly makes SPV applicability
  // instrument-specific. Do not propagate older universal legal caps as advice.
  {
    id: "spv-and-issuer",
    provenance: [{"title": "Manci — Partner Integration presentation", "section": "Slide 3: How the token relates to the company", "date": "2026-11-05"}],
    title: "Do I need a Serbian SPV?",
    keywords: ["SPV", "special purpose", "Serbian company", "srpska firma", "društvo", "osnivanje", "izdavalac", "issuer", "firma u Srbiji"],
    answer: "An SPV is an entity established for a defined purpose. Manci's public materials discuss Serbian SPV structures, but the required entity and its relationship to the underlying asset must be established for the chosen instrument. Do not assume that registering a Serbian company makes a foreign offering lawful or that every asset needs the same structure. The engagement should identify the issuer, obligated parties, underlying company or asset and applicable documents.",
    sources: [{ title: "Legal structure", href: "/legal-structure", section: "Built per issuance, not assumed once" }, { title: "Fees & costs", href: "/pricing" }],
  },
  // /how-it-works "The issuance process"; partner deck slide 10 "Token issuance".
  {
    id: "issuer-getting-started",
    category: "procedure",
    provenance: [{"title": "Manci — Partner Integration presentation", "section": "Slide 10: Token issuance", "date": "2026-11-05"}],
    title: "How can my company start tokenizing?",
    keywords: ["start", "apply", "issue", "issuer onboarding", "početak", "početi", "tokenizujem", "izdavanje", "prijava", "moja kompanija", "my company", "KYB"],
    answer: "Start with the issuer guide and describe the company, asset, rights you want to issue, jurisdictions, amount and intended recipients. An equity raise has an application route; other structures start with a team discussion. The process covers KYB and authority review, legal/commercial terms, documents, asset and class registration, then the approved distribution route. Registration alone does not complete KYB or authorise a public sale.",
    sources: [{ title: "Issuing an asset", href: "/how-it-works" }, { title: "Issuer registration & KYB", href: "/solutions/issuer-registry" }, { title: "Apply for an equity raise", href: "/apply" }],
  },
  // Partner deck slide 11 "Investor verification and wallet eligibility";
  // /investors and the current account/verification flow.
  {
    id: "kyc-wallet-and-privacy",
    category: "policy",
    provenance: [{"title": "Manci — Partner Integration presentation", "section": "Slide 11: Investor verification and wallet eligibility", "date": "2026-11-05"}],
    title: "Why do I need KYC and a wallet passport?",
    keywords: ["KYC", "passport", "verification", "verify", "identity", "pasoš", "identitet", "verifikacija", "dokumenti lični", "privacy", "privatnost", "wallet povezivanje"],
    answer: "KYC reviews the investor's identity; KYB reviews the issuing business. Wallet eligibility is a separate record, with status, jurisdiction and expiry. Verifying an account does not automatically approve every wallet or every offering. Use the verification page for account checks and Portfolio to review the connected wallet's status. Identity documents remain off-chain; do not paste passports, identity numbers, seed phrases or private keys into this assistant.",
    sources: [{ title: "Investor guide", href: "/investors" }, { title: "Eligibility & passports", href: "/solutions/compliance" }, { title: "Privacy policy", href: "/legal/privacy" }],
  },
  // Partner deck slide 14 "Wallet allowlists and transfer policy"; /security
  // "Transfer checks depend on the class" is the newer canonical guide.
  {
    id: "transfer-restrictions",
    category: "policy",
    provenance: [{"title": "Manci — Partner Integration presentation", "section": "Slide 14: Wallet allowlists and transfer policy", "date": "2026-11-05"}],
    title: "Can tokens be transferred freely?",
    keywords: ["transfer", "restriction", "allowlist", "whitelist", "blocklist", "Open", "KycGated", "prenos", "slobodno", "ograničenja", "blokiran", "istekao", "revoked"],
    answer: "The transfer policy is defined per token class. Open-mode classes apply source-owner blocklist checks; KYC-gated classes also require the receiving wallet's approved, unexpired passport and permitted jurisdiction. Escrow and issuance routes have additional checks. Holding a transferable token does not by itself make its holder eligible for legal conversion or physical delivery. Read the selected class's terms and current eligibility requirements.",
    sources: [{ title: "Security & controls", href: "/security", section: "Transfer checks depend on the class" }],
  },
  // Partner deck slide 12 "Asset discovery and trading"; /solutions/otc;
  // /risks "These instruments are illiquid".
  {
    id: "selling-and-liquidity",
    provenance: [{"title": "Manci — Partner Integration presentation", "section": "Slide 12: Asset discovery and trading", "date": "2026-11-05"}],
    title: "Can I sell without converting into company ownership?",
    keywords: ["sell", "selling", "OTC", "secondary", "liquidity", "market", "prodaja", "prodam", "trgovina", "likvidnost", "kupac", "izađem", "exit"],
    answer: "The supported OTC model lets a holder offer tokens for sale instead of converting, subject to the instrument, transfer policy and an enabled trading route. A funded offer can exchange payment and tokens through escrow. A listing is not a buyer, an active market or a guarantee of liquidity. You may be unable to sell at the desired price, time, or at all; confirm current market availability in the app.",
    sources: [{ title: "OTC trading", href: "/solutions/otc" }, { title: "Risk disclosure", href: "/risks", section: "These instruments are illiquid" }],
  },
  // Partner deck slides 12/13; /solutions/custody and /security.
  {
    id: "escrow-and-custody",
    provenance: [{"title": "Manci — Partner Integration presentation", "section": "Slide 13: Conversion into registered ownership", "date": "2026-11-05"}],
    title: "Who holds tokens during a transaction or conversion?",
    keywords: ["escrow", "custody", "vault", "deposit", "depozit", "čuvanje", "sredstva", "ko drži", "return", "povraćaj", "cancel", "otkazivanje"],
    answer: "Supported sale, OTC and conversion workflows use program-controlled escrow accounts. The program checks the parties, asset, deposited amounts and permitted actions. Legal execution and evidence review remain responsibilities of the authorised participants. Return or cancellation depends on that route's state, terms and deadline; escrow does not mean every deposit can be refunded immediately or that an off-chain obligation is automatically fulfilled.",
    sources: [{ title: "Custody & delivery", href: "/solutions/custody" }, { title: "Security & controls", href: "/security" }],
  },
  // /how-it-works "Income distributions" and /risks "Distributions depend on
  // the issuer paying"; no guaranteed yield is supported by any deck.
  {
    id: "income-and-dividends",
    title: "Do tokens pay dividends or a guaranteed return?",
    keywords: ["dividend", "yield", "income", "return", "profit", "payout", "dividenda", "prinos", "zarada", "isplata", "garantovan", "revenue"],
    answer: "Income rights depend on the instrument; not every token pays dividends, interest or revenue share. The terms define who is entitled, the calculation and timing. Distributions require actual funding by the issuer: a smart contract can distribute deposited funds but cannot create missing revenue. Some payout rights follow a fixed recipient snapshot, not the current token holder. Neither tokenization nor a pledge guarantees profit or recovery.",
    sources: [{ title: "Income distributions", href: "/how-it-works#distributions" }, { title: "Governance and payout rights", href: "/solutions/governance" }, { title: "Risk disclosure", href: "/risks" }],
  },
  // /solutions/rights-vesting and /investors "After a purchase".
  {
    id: "vesting-and-claims",
    category: "procedure",
    title: "How do vesting and claims work?",
    keywords: ["vesting", "claim", "unlock", "schedule", "cliff", "raspored", "otključavanje", "preuzimanje", "dospeće", "push", "alokacija"],
    answer: "Vesting releases an allocation according to the recorded schedule and series conditions. Review your position for the token, exact amount, unlock times, delivery mode and any approval, cancellation or recovery conditions. Use Portfolio's Vesting page for eligible claims. A scheduled amount is not proof that the escrow is funded or that a push executor has delivered it; those states must be checked separately.",
    sources: [{ title: "Vesting & claims", href: "/solutions/rights-vesting" }],
  },
  // Public /markets/types comparison and lib/instruments.ts. Availability and
  // rights must not be inherited from the existence of a category page.
  {
    id: "asset-types",
    title: "What can be tokenized?",
    keywords: ["assets", "instruments", "bonds", "real estate", "royalty", "imovina", "instrumenti", "nekretnina", "obveznica", "udeo", "roba", "umetnina", "autorska prava"],
    answer: "The guides cover company interests, debt, real estate, royalty rights, revenue share, fungible goods, unique physical assets and bespoke structures. The right differs: a debt claim is not company membership, rental income is not property title, and a delivery right is not a dividend. A listed category is not confirmation of a live offering or approval in your jurisdiction. Start with the relevant fact sheet and the terms of the actual issuance.",
    sources: [{ title: "Compare asset types", href: "/markets/types" }, { title: "Discuss a custom asset", href: "/contact" }],
  },
  // /pricing "What is not ours"; intro deck slide 6 "Issuers pay; we earn at
  // every step" describes a model, not a binding current fee schedule.
  {
    id: "fees-and-costs",
    title: "What does tokenization cost?",
    keywords: ["pricing", "fee", "cost", "quote", "price", "cena", "trošak", "troškovi", "naknada", "provizija", "besplatno", "koliko košta"],
    answer: "Separate platform fees from legal structuring, incorporation, filings and transaction costs. The published pricing page describes a launch phase without platform fees and third-party work quoted per engagement. That is not an all-inclusive quote or a promise of permanently free service. Request a current written quotation covering the instrument, jurisdictions, documents, distribution and ongoing servicing before work begins.",
    sources: [{ title: "Fees & costs", href: "/pricing" }, { title: "Request an engagement quote", href: "/contact" }],
  },
  // /how-it-works six-step issuance process; /legal-structure engagement copy.
  // No reviewed source establishes a fixed completion SLA or legal approval time.
  {
    id: "time-and-required-information",
    title: "How long does issuance or conversion take?",
    keywords: ["timeline", "duration", "how long", "requirements", "documents needed", "koliko traje", "rok", "trajanje", "potrebno", "šta treba", "dani", "nedelje"],
    answer: "The materials do not establish a fixed completion time. Issuance and conversion depend on the entity, instrument, jurisdictions, completeness of documents, review and any required registry steps. A fast token transaction does not imply an equally fast legal process. For an estimate, provide the company and asset, desired rights and size, investor countries and existing legal documents through the contact route; use the designated private upload flow for sensitive documents.",
    sources: [{ title: "Issuing an asset", href: "/how-it-works" }, { title: "Contact & support", href: "/contact" }],
  },
  // Partner deck slide 16 "What is implemented and what is available" is a
  // 5 Nov snapshot. Do not expose pause bits, inventory or key configuration.
  {
    id: "current-availability",
    provenance: [{"title": "Manci — Partner Integration presentation", "section": "Slide 16: What is implemented and what is available", "date": "2026-11-05"}],
    title: "Is Manci live, and can I transact now?",
    keywords: ["live", "available", "mainnet", "devnet", "production", "paused", "ready", "radi", "dostupno", "sada", "aktivno", "pauzirano", "pilot", "testnet"],
    answer: "Implemented features and currently enabled public operations are different. The November 2026 presentation describes a mainnet pilot with onboarding and browsing available, while new financial operations were paused at that snapshot. Older guides describe devnet. This knowledge base cannot confirm today's deployment or permission to transact: check the network and notices in the app and confirm the specific operation with the team. Devnet test tokens have no economic value.",
    sources: [{ title: "Confirm current availability", href: "/contact" }],
  },
  // Partner deck slide 18 "Integration with Metaplex"; technical deck slide 2
  // "Three routes on the same Solana network", slide 6 "Responsibilities after
  // protocol adoption", slide 13 "Three Metaplex products, three compatibility decisions".
  {
    id: "partners-and-metaplex",
    provenance: [{"title": "Manci — Partner Integration presentation", "section": "Slide 18: Integration with Metaplex", "date": "2026-11-05"}, {"title": "Manci × Metaplex — Technical Integration & Migration", "section": "Slide 2: Three routes on the same Solana network; slide 6: Responsibilities after protocol adoption", "date": "2026-11-05"}],
    title: "Is Manci integrated with Metaplex or another partner?",
    keywords: ["Metaplex", "MPL-3643", "Genesis", "partner", "integration", "interoperability", "integracija", "partnerstvo", "saradnja", "Token-2022", "protocol"],
    answer: "The November presentations discuss proposed Metaplex integration routes and compatibility tests. They do not prove a working integration, commercial agreement or endorsement. Sharing Solana or Token-2022 does not establish compatible identity, transfer, escrow or metadata behaviour. Any adopted token protocol would still leave issuer documentation, legal conversion and operating accountability to the responsible parties. Ask the team for the status of a named integration.",
    sources: [{ title: "Ask about integrations", href: "/contact" }, { title: "Share classes & Token-2022", href: "/solutions/share-classes" }],
  },
  // /faq transaction-pending question and /docs/pilot recovery guide; partner
  // deck slide 17 "System responsibilities" separates settlement and indexing.
  {
    id: "pending-transaction-recovery",
    provenance: [{"title": "Manci — Partner Integration presentation", "section": "Slide 17: System responsibilities", "date": "2026-11-05"}],
    title: "My transaction is pending in the app. Should I pay again?",
    keywords: ["pending", "retry", "recovery", "transaction", "receipt", "transakcija", "ponovo", "zaglavljeno", "uplata", "potvrda", "greška", "payment", "timeout"],
    answer: "Do not repeat a purchase or deposit just to update its app record. Keep the existing transaction receipt and check its network and status first. Blockchain settlement and app recording are separate; a recording delay does not establish that the payment failed. Use the available retry-record or recovery action for the existing operation, or contact support with its public transaction signature. Never share private keys or recovery phrases.",
    sources: [{ title: "Quick answers", href: "/faq" }, { title: "Recovery guide", href: "/docs/pilot" }],
  },
  // /risks and /legal-structure; partner deck slide 6 explicitly says a pledge
  // decision is not a platform or offering licence. No external audit claim.
  {
    id: "licensing-audit-and-advice",
    provenance: [{"title": "Manci — Partner Integration presentation", "section": "Slide 6: APR registered security for a token claim", "date": "2026-11-05"}, {"title": "Manci — Partner Integration presentation", "section": "Slide 16: What is implemented and what is available", "date": "2026-11-05"}],
    title: "Does the legal structure mean the product is licensed or risk-free?",
    keywords: ["licence", "license", "regulator", "approval", "audit", "safe", "risk", "MiCA", "licenca", "regulisano", "odobrenje", "revizija", "bezbedno", "rizik", "porez", "tax", "legal advice"],
    answer: "No such conclusion follows from a token, document hash, company registration or pledge record. The relevant authorisations and disclosures must be checked for the exact issuer, instrument, service and jurisdiction. Internal security review is not an independent external audit. The materials describe issuer, liquidity, legal and software risks, including total loss. The assistant explains documented processes; it cannot issue a legal opinion, confirm a licence, calculate your tax or recommend an investment.",
    sources: [{ title: "Risk disclosure", href: "/risks" }, { title: "Security & controls", href: "/security" }, { title: "Ask about your specific case", href: "/contact" }],
  },
];
