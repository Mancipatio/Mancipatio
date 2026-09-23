use crate::{
    constants::*,
    error::RegistryError,
    state::{
        Admin, Distribution, DistributionBatch, DistributionPlan, DistributionStatus, YieldPaid,
    },
};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

#[derive(Accounts)]
#[instruction(distribution_id: u64, batch_id: u32)]
pub struct DistributeBatch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [ADMIN_SEED, authority.key().as_ref()], bump = admin_record.bump)]
    pub admin_record: Box<Account<'info, Admin>>,
    #[account(mut, seeds = [DISTRIBUTION_SEED, distribution.share_class.as_ref(), &distribution_id.to_le_bytes()], bump = distribution.bump,
        has_one = escrow @ RegistryError::Unauthorized, has_one = payment_mint @ RegistryError::Unauthorized)]
    pub distribution: Box<Account<'info, Distribution>>,
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: The bound token escrow is decoded only for a new payout. An exact
    /// receipt replay may arrive after close_distribution closed this account.
    #[account(mut)]
    pub escrow: UncheckedAccount<'info>,
    pub payment_token_program: Interface<'info, TokenInterface>,
    #[account(seeds = [DISTRIBUTION_PLAN_SEED, distribution.key().as_ref()], bump = plan.bump,
        has_one = distribution @ RegistryError::InvalidDistributionPlan)]
    pub plan: Box<Account<'info, DistributionPlan>>,
    #[account(init_if_needed, payer = authority, space = 8 + DistributionBatch::INIT_SPACE,
        seeds = [DISTRIBUTION_BATCH_SEED, distribution.key().as_ref(), &batch_id.to_le_bytes()], bump)]
    pub batch: Box<Account<'info, DistributionBatch>>,
    pub system_program: Program<'info, System>,

    /// Emergency-pause gate (read-only). Keep LAST among named accounts: old
    /// account indices and the remaining-accounts hook tail keep their positions.
    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = !platform.is_paused(PAUSE_DISTRIBUTIONS) @ RegistryError::PlatformPaused,
    )]
    pub platform: Box<Account<'info, crate::state::Platform>>,
    // remaining_accounts: one committed recipient token account per amount.
}

/// Pays exactly a funder-co-signed immutable batch commitment. Replaying the
/// same batch is a no-op; a different payload at that ID is rejected.
pub fn handle_distribute_batch<'info>(
    ctx: Context<'info, DistributeBatch<'info>>,
    distribution_id: u64,
    batch_id: u32,
    amounts: Vec<u64>,
    proof: Vec<[u8; 32]>,
) -> Result<()> {
    require!(
        !amounts.is_empty()
            && amounts.len() <= MAX_DISTRIBUTION_BATCH_SIZE
            && amounts.len() == ctx.remaining_accounts.len()
            && amounts.iter().all(|a| *a > 0),
        RegistryError::InvalidDistributionParams
    );
    require!(
        ctx.accounts.distribution.version == DISTRIBUTION_STATE_VERSION
            && ctx.accounts.plan.version == STATE_VERSION
            && batch_id < ctx.accounts.plan.batch_count
            && proof.len() <= 32,
        RegistryError::InvalidDistributionPlan
    );
    let mut entries = Vec::with_capacity(amounts.len());
    for (recipient, amount) in ctx.remaining_accounts.iter().zip(&amounts) {
        require_keys_eq!(
            *recipient.owner,
            ctx.accounts.payment_token_program.key(),
            RegistryError::InvalidDistributionRecipient
        );
        let token = InterfaceAccount::<TokenAccount>::try_from(recipient)
            .map_err(|_| RegistryError::InvalidDistributionRecipient)?;
        require_keys_eq!(
            token.mint,
            ctx.accounts.payment_mint.key(),
            RegistryError::InvalidDistributionRecipient
        );
        entries.push((*recipient.key, token.owner, *amount));
    }
    let hash =
        crate::util::distribution_batch_leaf(&ctx.accounts.distribution.key(), batch_id, &entries);
    if ctx.accounts.batch.version != 0 {
        require!(
            ctx.accounts.batch.version == STATE_VERSION
                && ctx.accounts.batch.distribution == ctx.accounts.distribution.key()
                && ctx.accounts.batch.batch_id == batch_id
                && ctx.accounts.batch.batch_hash == hash,
            RegistryError::InvalidDistributionPlan
        );
        return Ok(());
    }
    require!(
        crate::util::verify_merkle_proof(ctx.accounts.plan.batch_root, hash, &proof),
        RegistryError::InvalidMerkleProof
    );
    require!(
        ctx.accounts.distribution.status == DistributionStatus::Distributing,
        RegistryError::DistributionNotActive
    );
    let escrow_info = ctx.accounts.escrow.to_account_info();
    require_keys_eq!(
        *escrow_info.owner,
        ctx.accounts.payment_token_program.key(),
        RegistryError::Unauthorized
    );
    let escrow = TokenAccount::try_deserialize(&mut escrow_info.try_borrow_data()?.as_ref())?;
    require!(
        escrow.owner == ctx.accounts.distribution.key()
            && escrow.mint == ctx.accounts.payment_mint.key(),
        RegistryError::Unauthorized
    );
    let total = amounts
        .iter()
        .try_fold(0u64, |sum, amount| sum.checked_add(*amount))
        .ok_or(RegistryError::Overflow)?;
    let new_distributed = ctx
        .accounts
        .distribution
        .distributed_amount
        .checked_add(total)
        .ok_or(RegistryError::Overflow)?;
    require!(
        new_distributed <= ctx.accounts.distribution.total_amount,
        RegistryError::DistributionOverdraw
    );
    let share_class = ctx.accounts.distribution.share_class;
    let id = distribution_id.to_le_bytes();
    let bump = [ctx.accounts.distribution.bump];
    let signer: &[&[&[u8]]] = &[&[DISTRIBUTION_SEED, share_class.as_ref(), &id, &bump]];
    for (recipient, &amount) in ctx.remaining_accounts.iter().zip(&amounts) {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.payment_token_program.key(),
                TransferChecked {
                    from: escrow_info.clone(),
                    mint: ctx.accounts.payment_mint.to_account_info(),
                    to: recipient.clone(),
                    authority: ctx.accounts.distribution.to_account_info(),
                },
                signer,
            ),
            amount,
            ctx.accounts.payment_mint.decimals,
        )?;
        emit!(YieldPaid {
            distribution: ctx.accounts.distribution.key(),
            recipient: *recipient.key,
            amount
        });
    }
    let paid_count = u32::try_from(amounts.len()).map_err(|_| RegistryError::Overflow)?;
    ctx.accounts.distribution.distributed_amount = new_distributed;
    ctx.accounts.distribution.paid_count = ctx
        .accounts
        .distribution
        .paid_count
        .checked_add(paid_count)
        .ok_or(RegistryError::Overflow)?;
    let batch = &mut ctx.accounts.batch;
    batch.distribution = ctx.accounts.distribution.key();
    batch.batch_id = batch_id;
    batch.batch_hash = hash;
    batch.total_amount = total;
    batch.paid_count = paid_count;
    batch.version = STATE_VERSION;
    batch.bump = ctx.bumps.batch;
    Ok(())
}
