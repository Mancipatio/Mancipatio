use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{Admin, Distribution, DistributionStatus, EscrowMarker, ShareClass};

#[derive(Accounts)]
#[instruction(distribution_id: u64)]
pub struct CreateDistribution<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Admin gate — only an admin may open distributions.
    #[account(
        seeds = [ADMIN_SEED, authority.key().as_ref()],
        bump = admin_record.bump,
    )]
    pub admin_record: Box<Account<'info, Admin>>,

    #[account(
        seeds = [SHARE_CLASS_SEED, share_class.asset.as_ref(), &[share_class.class_index]],
        bump = share_class.bump,
        has_one = mint @ RegistryError::Unauthorized,
        constraint = share_class.mint_initialized @ RegistryError::MintNotInitialized,
    )]
    pub share_class: Box<Account<'info, ShareClass>>,

    /// Share-class mint the distribution relates to (indexing only).
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// Payment mint being distributed (e.g. USDT).
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        space = 8 + Distribution::INIT_SPACE,
        seeds = [DISTRIBUTION_SEED, share_class.key().as_ref(), &distribution_id.to_le_bytes()],
        bump
    )]
    pub distribution: Box<Account<'info, Distribution>>,

    /// Escrow holding the payment tokens; authority is the `Distribution` PDA.
    #[account(
        init,
        payer = authority,
        seeds = [DISTRIBUTION_ESCROW_SEED, distribution.key().as_ref()],
        bump,
        space = crate::util::payment_escrow_space(&payment_mint.to_account_info(), &payment_token_program.key())?,
        owner = payment_token_program.key(),
    )]
    /// CHECK: allocated above, initialized with the bound mint and PDA owner in the handler.
    pub escrow: UncheckedAccount<'info>,

    /// Marks the distribution PDA as a platform escrow authority — the
    /// transfer hook exempts escrow legs from receiver-KYC while this exists.
    /// Closed by `close_distribution`.
    #[account(
        init,
        payer = authority,
        space = 8 + EscrowMarker::INIT_SPACE,
        seeds = [ESCROW_MARKER_SEED, distribution.key().as_ref()],
        bump
    )]
    pub escrow_marker: Box<Account<'info, EscrowMarker>>,

    /// Funds the distribution — transfers exactly `total_amount` into the
    /// escrow. Recorded on the `Distribution`; `close_distribution` refunds
    /// the remainder (and the escrow's rent) to this wallet.
    pub funder: Signer<'info>,

    /// Funder's payment token account — debited `total_amount`.
    #[account(
        mut,
        constraint = funder_payment_account.mint == payment_mint.key() @ RegistryError::Unauthorized,
        constraint = funder_payment_account.owner == funder.key() @ RegistryError::Unauthorized,
    )]
    pub funder_payment_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub payment_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    #[account(init, payer = authority, space = 8 + crate::state::DistributionPlan::INIT_SPACE,
        seeds = [DISTRIBUTION_PLAN_SEED, distribution.key().as_ref()], bump)]
    pub plan: Box<Account<'info, crate::state::DistributionPlan>>,

    /// Emergency-pause gate (read-only). Keep LAST among named accounts: old
    /// account indices and the remaining-accounts hook tail keep their positions.
    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = !platform.is_paused(PAUSE_DISTRIBUTIONS) @ RegistryError::PlatformPaused,
    )]
    pub platform: Box<Account<'info, crate::state::Platform>>,
}

/// Opens a push-based pro-rata revenue distribution (business-doc §2–§5) and
/// funds its escrow atomically: the funder transfers exactly `total_amount`
/// payment units in the same instruction, after which the distribution is
/// `Distributing`. The pro-rata per holder is computed off-chain against
/// `snapshot_supply`; the program executes and records the payouts.
pub fn handle_create_distribution(
    ctx: Context<CreateDistribution>,
    distribution_id: u64,
    total_amount: u64,
    snapshot_supply: u64,
    batch_root: [u8; 32],
    batch_count: u32,
) -> Result<()> {
    require!(
        batch_root != [0; 32] && batch_count > 0 && snapshot_supply > 0,
        RegistryError::InvalidDistributionPlan
    );
    crate::util::initialize_token_escrow(
        &ctx.accounts.escrow.to_account_info(),
        &ctx.accounts.payment_mint.to_account_info(),
        &ctx.accounts.distribution.to_account_info(),
        &ctx.accounts.payment_token_program.to_account_info(),
    )?;

    require!(total_amount > 0, RegistryError::InvalidDistributionParams);

    // fund the escrow (payment mint has no hook — plain CPI, funder signs)
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.payment_token_program.key(),
            TransferChecked {
                from: ctx.accounts.funder_payment_account.to_account_info(),
                mint: ctx.accounts.payment_mint.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            },
        ),
        total_amount,
        ctx.accounts.payment_mint.decimals,
    )?;

    let d = &mut ctx.accounts.distribution;
    d.admin = ctx.accounts.authority.key();
    d.funder = ctx.accounts.funder.key();
    d.share_class = ctx.accounts.share_class.key();
    d.mint = ctx.accounts.mint.key();
    d.payment_mint = ctx.accounts.payment_mint.key();
    d.escrow = ctx.accounts.escrow.key();
    d.total_amount = total_amount;
    d.snapshot_supply = snapshot_supply;
    d.distributed_amount = 0;
    d.paid_count = 0;
    d.status = DistributionStatus::Distributing;
    d.distribution_id = distribution_id;
    d.version = DISTRIBUTION_STATE_VERSION;
    d.bump = ctx.bumps.distribution;

    ctx.accounts.plan.distribution = d.key();
    ctx.accounts.plan.batch_root = batch_root;
    ctx.accounts.plan.batch_count = batch_count;
    ctx.accounts.plan.version = STATE_VERSION;
    ctx.accounts.plan.bump = ctx.bumps.plan;

    ctx.accounts.escrow_marker.bump = ctx.bumps.escrow_marker;

    msg!(
        "Distribution {} opened — {} funded against supply {}",
        distribution_id,
        total_amount,
        snapshot_supply
    );
    Ok(())
}
