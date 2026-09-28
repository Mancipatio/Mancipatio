# Orderly wind-down plan (DRAFT for legal review)

**Status: draft by engineering, 2026-09-28, for the lawyer.** It describes
what happens on the chain and in the application if Manci stops operating,
in what order, and who signs. The legal questions are marked **[legal]**; the
Terms need a matching termination clause (kritičar-4). Nothing here has been
rehearsed yet (planned for the 6.5 tabletop on devnet).

## When this plan applies

- the licence is withdrawn or not renewed, or the regulator orders a stop;
- insolvency or liquidation of the legal entity;
- the owner decides to stop the service;
- the operator is unavailable (no one can use the operator keys) for longer
  than **[legal: period]**.

## What users hold, and what depends on us

Users' share-class tokens sit in their own wallets; payment tokens they have
committed sit in program-owned escrow accounts (PDAs), never in a Manci
wallet. Wallet-to-wallet transfers never depend on us (the transfer hook does
not read the pause), except that a KycGated class only moves to wallets with
a live passport. Several exits, however, need an operator signature:

| Where value waits | Who can release it | Without the operator |
|---|---|---|
| Primary sale, still open | the issuer closes it (`close_sale`); buyers then claim per the sale's outcome | the issuer can still act; claims are the buyers' own |
| Unused sale approval | any Admin revokes it | it expires on its own date |
| Payout vault, frozen | only an Admin opens the investors' vote (`open_vault_vote`); finalizing and claiming are open to anyone | **stuck** until an Admin opens the vote |
| OTC deal with an expiry | anyone expires it after the expiry (`expire_otc_deal`) | released after the expiry |
| OTC deal without an expiry (`expires_at = 0`) | only an Admin cancels it (`cancel_otc_deal`) | **stuck** |
| OTC offer | the maker cancels; anyone expires it after its expiry | released by the maker or after the expiry |
| Delivery escrow with a deadline | the operating Admin at any time; anyone after the deadline (`return_custody_vault`) | released after the deadline |
| Delivery escrow without a deadline (`deadline = 0`) | only the operating Admin | **stuck** |
| Conversion / redemption vault | the operating Admin (trigger, realize, revert); revert is open to anyone only after a positive deadline | **stuck** without a deadline |
| Push distribution not fully sent | any Admin sends the batches or closes it (funds back to the funder) | **stuck** |
| Yield routed, rights milestones | holders claim what is published; publishing needs an Admin (and for rights, the Admin who opened the issuance) | what is not yet published stays |
| KycGated classes | holders need a live passport to receive; passports expire | transfers to new holders stop as passports expire |

The **stuck** rows are why the plan must run while the operator keys are
still usable, and why engineering proposes (for the program freeze, package
8.3) that every OTC deal and delivery escrow must carry an expiry or a
deadline, so their exits become permissionless after it.

## Order of the wind-down

Times are placeholders **[legal: notice periods]**; T is the announced stop.

| When | Step | Who signs | Where |
|---|---|---|---|
| T − 30 days | Announce the stop to users, issuers and the regulator; publish the exit timetable; stop accepting new clients | owner | email, site banner, regulator notice |
| T − 30 days | Pause entry flows: onboarding, primary issuance, trading through Manci, custody entry (the exits stay open) | any Admin | `/admin/platform` PauseFlagsPanel |
| T − 30 days | Revoke every unused sale approval | any Admin | `/admin/applications` |
| T − 30 … T − 7 | Issuers close their open sales; buyers claim; payout vaults run their votes (an Admin opens each) and investors claim | issuers, Admins, investors | `/issuer/launchpad`, `/admin/payouts`, `/portfolio` |
| T − 30 … T − 7 | Cancel OTC deals without an expiry; let the others expire | any Admin | `/admin/otc` |
| T − 30 … T − 7 | Return, revert or realize every custody vault | the operating Admin | `/admin/custody` |
| T − 30 … T − 7 | Finish or close every push distribution; publish or close outstanding yield and rights milestones | Admins | `/admin/payouts`, `/admin/rights` |
| T − 7 | Decide the transferability after the stop **[legal]**: keep KycGated classes as they are (new receivers need passports nobody issues any more) or switch them to Open | the blocklist authority | `/admin/share-classes` or `chain:emergency hook-mode` |
| T − 7 | Blocklist review: which blocks stay (sanctions, orders) and which are lifted | the blocklist authority | `/admin/blocklist` |
| T | Pause distributions and issuer proceeds as well; the site switches to an exit-only notice that still lists the claim pages | super admin, owner | `/admin/platform`, deployment |
| T | Operator keys: hand the super admin, BA and KYC authority to the successor or trustee the lawyer names, or retire them **[legal]** | current holders | `chain:handover` plan, `/account/roles` |
| T | Upgrade authority: the Squads members decide, with the lawyer, between making both programs immutable (`set-upgrade-authority` to none through Squads) and handing the vault to the trustee **[legal]** | Squads members | `chain:squads-export` |
| T + retention | Keep the database read-only for the record-keeping period (**[legal: AML records, 10 years?]**), then delete; answer data-subject requests meanwhile | owner / data-protection contact | Supabase |

## Questions for the lawyer

1. Which notice periods apply to users and to issuers, and what the regulator
   must receive and when.
2. Whether a trustee or successor operator must take the operator keys, or
   whether retiring them (with every stuck row above released first) is
   enough.
3. The transferability decision at the stop (KycGated or Open).
4. The record-keeping periods for KYC, KYB and transaction records, and what
   may be deleted after the stop.
5. The termination clause in the Terms and the issuer agreement (what the
   issuer must do in a wind-down: close its sales, its payout duties).
6. Whether the program must require an expiry on every OTC deal and a
   deadline on every delivery escrow before the audit freeze (engineering's
   recommendation).
