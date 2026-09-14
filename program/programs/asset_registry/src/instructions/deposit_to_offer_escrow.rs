use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Offer, OfferDeposited, OfferStatus};
use crate::util::hook_transfer;

#[derive(Accounts)]
pub struct DepositToOfferEscrow<'info> {
    /// The offer's maker — the only party whose units this ledger may record,
    /// and the only party the refund paths pay out to.
    pub maker: Signer<'info>,

    #[account(
        mut,
        seeds = [OFFER_SEED, offer.share_class.as_ref(), &offer.offer_id.to_le_bytes()],
        bump = offer.bump,
        has_one = maker @ RegistryError::Unauthorized,
        has_one = mint @ RegistryError::Unauthorized,
        has_one = escrow @ RegistryError::Unauthorized,
        constraint = offer.status == OfferStatus::Open @ RegistryError::OfferNotOpen,
    )]
    pub offer: Box<Account<'info, Offer>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The maker's share-class token account — debited exactly `amount`.
    #[account(
        mut,
        constraint = maker_share_account.mint == mint.key() @ RegistryError::Unauthorized,
        constraint = maker_share_account.owner == maker.key() @ RegistryError::Unauthorized,
    )]
    pub maker_share_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    // remaining_accounts — the transfer-hook accounts for the maker → escrow
    // leg, in meta-list order:
    //   Open (3):     [BlockEntry(maker), ExtraAccountMetaList,
    //                  transfer_hook program]
    //   KycGated (9): [BlockEntry(maker), TransferHookConfig, KycRegistry,
    //                  asset_registry program, KycEntry(offer PDA),
    //                  EscrowMarker(offer PDA), EscrowMarker(maker),
    //                  ExtraAccountMetaList, transfer_hook program]
    // The destination owner is the offer PDA, whose `EscrowMarker` exempts the
    // leg from receiver KYC — funding an escrow is an ENTRY, and the maker gets
    // the deposit back (by the ledger) even if their passport lapses meanwhile.
}

/// Funds an open offer's escrow from the maker's own wallet — the ONLY
/// instruction that credits `offer.deposited`.
///
/// Why it exists: `create_offer` is permissionless and opens an EMPTY escrow
/// with an `EscrowMarker`. Until this instruction existed the maker funded it
/// with a bare client-side `transfer_checked`, so the program had no evidence
/// of who put what in — while `cancel_offer` / `expire_offer` swept the FULL
/// escrow balance to `offer.maker` with the receiver-KYC checks skipped
/// (the offer PDA's source marker makes the hook look away). That turned every
/// offer into a laundry: a wallet with no `KycEntry` opens an offer for one
/// unit, ANY holder of the mint — an issuer treasury sitting on freshly minted
/// units, or an ordinary approved holder — raw-transfers N units into the
/// escrow (the destination marker exempts that leg too), and `cancel_offer`
/// hands all N to the unvetted maker. No privileged signer required.
///
/// The fix is bookkeeping, not prohibition — a raw transfer into the escrow
/// still cannot be prevented on-chain, it just no longer buys anything:
///
///   * deposits routed through here are recorded on `offer.deposited`;
///   * `cancel_offer` / `expire_offer` release at most `deposited` with no
///     receiver check (a refund of the maker's own property must never be
///     stranded by a lapsed passport), and any surplus only to a receiver whose
///     `KycEntry` passes;
///   * `take_offer` requires `deposited >= offer.amount`, so a maker can never
///     sell units somebody else put in the escrow.
pub fn handle_deposit_to_offer_escrow<'info>(
    ctx: Context<'info, DepositToOfferEscrow<'info>>,
    amount: u64,
) -> Result<()> {
    crate::util::require_supported_mint(
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.token_program.key(),
        true,
    )?;

    require!(amount > 0, RegistryError::InvalidDepositAmount);

    // Capped at what the offer actually sells. Without this the ledger could
    // exceed `offer.amount`, and `take_offer` — which fills exactly
    // `offer.amount` and then marks the offer `Filled` — would strand the
    // excess forever: no instruction accepts a `Filled` offer, and the escrow
    // is signed only by the offer PDA. Capping keeps the invariant
    // `deposited <= amount`, so a fill always drains the ledger to zero and a
    // maker's own units can never be trapped by over-funding.
    let projected = ctx
        .accounts
        .offer
        .deposited
        .checked_add(amount)
        .ok_or(RegistryError::Overflow)?;
    require!(
        projected <= ctx.accounts.offer.amount,
        RegistryError::InvalidDepositAmount
    );

    // Deposit leg: maker wallet → offer escrow. Hook-aware; the maker is a real
    // transaction signer so empty signer seeds suffice.
    hook_transfer(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.maker_share_account.to_account_info(),
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.escrow.to_account_info(),
        &ctx.accounts.maker.to_account_info(),
        ctx.remaining_accounts,
        amount,
        ctx.accounts.mint.decimals,
        &[],
    )?;

    let offer = &mut ctx.accounts.offer;
    offer.deposited = offer
        .deposited
        .checked_add(amount)
        .ok_or(RegistryError::Overflow)?;

    emit!(OfferDeposited {
        offer: offer.key(),
        mint: offer.mint,
        maker: ctx.accounts.maker.key(),
        amount,
        total_deposited: offer.deposited,
    });

    msg!(
        "OTC offer {} — {} units deposited ({} credited total)",
        offer.offer_id,
        amount,
        offer.deposited
    );
    Ok(())
}
