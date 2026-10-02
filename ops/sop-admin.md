# Admin operating procedures (mainnet)

Day-to-day procedures for the people who hold the operator keys: the super
admin (SA), the Admins, the KYC provider and the blocklist authority (BA). With
the company wallet model (runbook §19) one wallet holds all four roles; the
procedures do not change, only who signs.

This is the operational part of the AML/CFT programme and of the internal
controls the lawyer reviews (runbook §0, Legal gate). The criteria below are
placeholders where the lawyer's written procedures decide (marked **[legal]**);
the steps and the checks are what the application enforces. The deploy,
upgrade and incident procedures are in `ops/runbook-mainnet.md`.

## Rules for every procedure

- **One page, one key.** Each action names its page. The operator front
  checks the role (`/admin/*` is default-deny per role) and every builder
  re-reads the live authority before it signs; the program enforces the same
  rule again.
- **Read the wallet screen before approving.** Check the program (asset
  registry `FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS`, transfer hook
  `GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy`), the fee payer (your own
  key) and, on a Ledger in blind-signing mode, compare the message hash when
  the tool shows one. Never approve a transaction you did not start.
- **Evidence first, signature second.** Attach or record what the decision
  rests on before signing (the document review, the screening result, the
  application). Every action writes an `audit_events` row (`/admin/audit`);
  add the reason in the field the dialog offers.
- **Four eyes where the law asks.** A single operator cannot provide a second
  review. Until there are two people, record in the decision note that the
  second review was not possible, and keep the decisions the lawyer marks as
  four-eyes (**[legal]**: at least KYB, clawback and large sale approvals)
  pending until a second person reviews.
- **Maintenance off.** Every browser transaction is refused in maintenance;
  when the front or the database is down, the only out-of-band actions are
  the ones `chain:emergency` offers (runbook §11).

## Daily

1. **Alarms** — `/admin/compliance`. Work every open alert from the top
   (critical, high). For each: read the summary and the explorer link,
   decide, write what you did in the resolution note, resolve. The first
   responses per alert are in the runbook (§15, Responses). An alert you do
   not understand stays open and goes to the incident lead.
2. **Health** — `/admin/health`: indexer ready and fresh, no stuck queue.
   `/api/health/alarms` must be 200 (the external monitor watches it).
3. **Queues** — the admin menu badges show what waits: KYC requests,
   applications, OTC, custody, inquiries. Nothing should wait more than
   **[legal]** business days.

## KYC: documents, profile, passport

Who: the KYC provider (or an Admin for the profile work); the passport itself
is signed by the KYC registry authority. Pages: `/admin/kyc`,
`/admin/clients/<id>`.

1. **Open the request** on `/admin/kyc` → Passport requests → *Mark in
   review*, then open the client's dossier (`/admin/clients/<id>`). Document
   views are logged.
2. **Documents first.** Review each uploaded document against its
   requirement and approve, reject or request another one; the profile
   cannot be verified while a document is requested, submitted or rejected
   (owner decision 25.9.).
3. **Screening** **[legal]**: sanctions and PEP screening of the person, the
   source-of-funds question where the risk calls for it, the country against
   the approved and blocked jurisdictions. Record the result in the note.
4. **Profile decision**: verified, more information, or rejected. Only an
   Admin lifts a suspension or reverses a rejection.
5. **Passport**: back on `/admin/kyc`, *Issue passport* (`approve_holder` in
   the pinned registry). Before signing, the page re-reads the wallet's
   blocklist entry and open AML alerts and refuses when either is unknown or
   bad. The KYC key pays the passport's rent (runbook §1): keep it funded.
6. **Expiry and renewal**: a passport carries its expiry; a KycGated holder
   with an expired passport cannot receive units. Renew from a fresh review
   before the expiry **[legal: review period]**.
7. **Revoke** (`revoke_holder`, `/admin/clients/<id>`) when the review fails
   later, the person asks for it, or screening turns positive. A revoked
   KycGated holder can then be clawed back (below).

What is recorded: the document decisions and the profile decision (notes and
`audit_events`), the passport transaction.

## KYB: issuer verification

Who: the super admin only (`verify_issuer_kyb`). Page: `/admin/issuers`
(the pending ones first), with the dossier on `/admin/clients?q=<wallet>`.

1. Open the issuer's KYB dossier: the company register extract, the
   beneficial owners, the directors' KYC, the authority of the person who
   applied **[legal: list]**.
2. Screen the company and its beneficial owners **[legal]**.
3. *Verify* or *Reject* on `/admin/issuers`. The page re-reads the issuer on
   the chain before sending and reconciles after it.
4. Issuer permissions (`/admin/issuers` → permissions panel, SA only): grant
   only what the approved application needs (mint rights stay off unless a
   sale approval covers them).

## Sale approvals (`approve_sale`, the €3M ceiling)

Who: any Admin; the no-application approval on `/admin/launchpad` is the
super admin's. Page: `/admin/applications` → the application → *Approve
sale*.

1. The application is approved on its merits first (the issuer is KYB
   verified; the terms, the whitepaper and the documents are reviewed
   **[legal]**).
2. *Approve sale*: set the share class, the payment token (mainnet: USDC
   only), the minimum and maximum price per unit, the raise type, the payout
   schedule and the date the sale must open by. The dialog shows the capacity
   left under the ceiling; the server reserves the EUR value under a lock
   before you sign and compares the on-chain approval with the reservation
   afterwards.
3. The USDC rate must be fresh (below): an approval counted at a stale rate
   is refused.
4. **Revoke** an unused approval (*Revoke* on the same page, any Admin) when
   the issuer withdraws, the terms change, or the approving Admin's key is
   removed: an approval stays valid after its Admin record is gone.

## FX rate (automatic, with a manual fallback)

Who: the super admin. Page: `/admin/limits` → payment token rates.

1. Since migration 0080 the USDC → EUR rate is automatic (runbook §15
   "Automatic EUR rate"): the median of four public USDC/EUR markets,
   checked against the ECB reference rate (within 2.5 %, widening to at most
   5 % as the ECB fix ages over a weekend or holiday), renewed every minute
   and valid 15 minutes. The page shows which rate counts (Automatic, Manual, Manual
   override), the sources, the ECB anchor and the last run. The method is a
   rate source like any other: the lawyer accepts it **[legal: source]**.
2. Every week (and at once when `fx:auto-stale` or `fx:fallback` fires),
   keep the manual fallback current: the USDC → EUR rate (kind `rate`, maximum age at most
   7 days) from the source the lawyer accepts. It counts only while the
   automatic rate is missing or out of date.
3. Tick "Override the automatic rate" only on purpose (a feed you distrust,
   a depeg decided with the owner); save the rate again unticked to end it.
   `/api/health` warns while an override counts, and the page warns before
   saving when the override is more than 2 % away from a current automatic
   rate (an out-of-date automatic rate raises no warning). An override
   keeps counting after its own maximum age (shown "Out of date"):
   approvals then refuse until you renew it or save it unticked. Every save
   or delete of a manual rate is in the audit log (`/admin/audit`,
   `fx_rate_update` / `fx_rate_delete`), with the automatic rate that was
   current and the gap to it.
4. On mainnet `/api/health` fails when no rate is fresh (`stale`,
   `missing`), except before the first sale approval and the first sale:
   then a missing or out-of-date rate only warns
   (`missing_before_first_sale` / `stale_before_first_sale`). Off mainnet it
   only warns. It also warns from 80 % of the maximum age of a manual rate
   that counts, and while the automatic rate counts but the manual
   fallback is missing or out of date (`fallback_missing` /
   `fallback_stale`). The alarm `fx:auto-stale` is high only on mainnet,
   for a mint in use (a live approval, an open sale or a raise limit hold
   paid in it) that no fresh manual rate covers; otherwise it is medium on
   mainnet and low elsewhere.
5. Before the off switch of the automatic rate (runbook §15 "Off switch",
   and before an Instant Rollback to a front without it, §10) the manual
   USDC rate must be fresh: refresh it here first. The off switch itself
   raises `fx:auto-stale` for a few minutes; it clears after about 10
   minutes.
6. EURC or any other mint is added in code first (with its address checked
   against the issuer's published address), never on this page alone.

## Blocklist and clawback

Who: the BA blocks and unblocks (`/admin/blocklist`); an Admin claws back
(`/admin/kyc` → clawback panel). Out of band: `chain:emergency block` /
`unblock` (runbook §11).

1. Block on a sanctions hit, a court or authority order, or a confirmed theft
   **[legal: triggers]**. Record the reason and the evidence.
2. Blocking is sender-side: the wallet can still receive. Clawback moves its
   units into a quarantine vault for the issuer's burn-and-attest flow.
3. Blocking a program account (an escrow) stops exits from it: the tools ask
   for an explicit confirmation.
4. Unblock only with the reason recorded (a cleared screening, a lifted
   order).

## Pause

Any Admin may pause; only the super admin resumes. Page: `/admin/platform` →
PauseFlagsPanel (per area or *Pause everything*); out of band:
`chain:emergency pause` (runbook §11).

- Pause an area when a flow through the platform is being abused, a bug is
  suspected, or before a program upgrade (runbook §9).
- Pausing stops entry flows only (onboarding, primary sales, OTC through
  Manci, custody entry, distributions, issuer proceeds); exits, claims and
  wallet-to-wallet transfers keep working.
- Resume only when the cause is understood and written in the incident
  record.

## Custody, OTC, payouts

- **Custody** (`/admin/custody`): open a vault only for an approved
  conversion or delivery; the Admin who opens it operates it (trigger,
  realize, return, revert). Before an Admin leaves, move its vaults
  (propose by the SA, accept by the new operator). Trigger a delivery vault
  only when the beneficiary's passport is verified and valid past the
  planned realize: the trigger does not check it and the realize refuses
  it (runbook §11, "Accepted program risks").
- **OTC deals** (`/admin/otc`): create a deal with an expiry; cancel one that
  must not settle (any Admin).
- **Payouts and distributions** (`/admin/payouts`): recompute the snapshot
  independently before signing a root or a distribution **[an independent
  recomputation tool is a follow-up]**; the Admin who funds a distribution is
  its funder (refunds and rent return to that key).

## Weekly and monthly

- Weekly: the manual FX fallback (the automatic rate shows as current); alarm backlog zero; `chain:inventory` (read-only) shows no
  unexpected Admin record, proposal or buffer; the balances of the operator
  keys above the refill lines (runbook §1).
- Monthly: the list of Admin records against the people who should hold them
  (`/admin/admins`); open sale approvals; passports expiring within a month;
  a restore drill of the backups (runbook §14) each quarter.
