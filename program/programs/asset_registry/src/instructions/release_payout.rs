use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{PayoutVault, PayoutVaultState, RaiseType};

#[derive(Accounts)]
pub struct ReleasePayout<'info> {
    #[account(
        mut,
        seeds = [PAYOUT_SEED, vault.sale.as_ref()],
        bump = vault.bump,
        has_one = escrow @ RegistryError::Unauthorized,
        has_one = payment_mint @ RegistryError::Unauthorized,
        constraint = vault.state == PayoutVaultState::Active @ RegistryError::VaultNotActive,
    )]
    pub vault: Box<Account<'info, PayoutVault>>,

    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Founder's payment account — receives the tranche. Must belong to vault.founder.
    #[account(
        mut,
        constraint = founder_account.mint == vault.payment_mint @ RegistryError::Unauthorized,
        constraint = founder_account.owner == vault.founder @ RegistryError::NotFounder,
    )]
    pub founder_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub payment_token_program: Interface<'info, TokenInterface>,
}

/// Receiver KYC: NOT APPLICABLE — this escrow pays out the PAYMENT mint, a
/// plain SPL/Token-2022 token with no Mancipatio transfer hook and no
/// `KycRegistry`. The receiver-KYC regime governs share-class units only; the
/// destination here is additionally pinned to the entitled party by the
/// account constraints above.
pub fn handle_release_payout(ctx: Context<ReleasePayout>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let v = &ctx.accounts.vault;

    let amount = match v.raise_type {
        RaiseType::Mature => return err!(RegistryError::InvalidRaiseParams),
        RaiseType::Startup => {
            require!(
                v.tranches_released < v.num_tranches,
                RegistryError::NothingToRelease
            );
            let i = v.tranches_released as i64;
            let tranche_ts = v.start_ts + i * MONTH;
            require!(now >= tranche_ts, RegistryError::TrancheNotDue);
            require!(
                v.updates_posted > v.tranches_released as u32,
                RegistryError::UpdateRequired
            );
            if v.tranches_released + 1 == v.num_tranches {
                v.total_amount
                    .checked_sub(v.released)
                    .ok_or(RegistryError::Overflow)?
            } else {
                v.tranche_amount
            }
        }
    };
    require!(amount > 0, RegistryError::NothingToRelease);

    let sale_key = v.sale;
    let bump = v.bump;
    let signer: &[&[&[u8]]] = &[&[PAYOUT_SEED, sale_key.as_ref(), &[bump]]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.payment_token_program.key(),
            TransferChecked {
                from: ctx.accounts.escrow.to_account_info(),
                mint: ctx.accounts.payment_mint.to_account_info(),
                to: ctx.accounts.founder_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer,
        ),
        amount,
        ctx.accounts.payment_mint.decimals,
    )?;

    let v = &mut ctx.accounts.vault;
    v.released += amount;
    v.tranches_released += 1;
    if v.tranches_released == v.num_tranches {
        v.state = PayoutVaultState::Completed;
    }
    msg!("Released tranche {} — {}", v.tranches_released, amount);
    Ok(())
}
