use crate::{
    constants::*,
    error::RegistryError,
    legacy::*,
    state::{PayoutVault, ShareClass, VaultVote},
};
use anchor_lang::prelude::*;

/// Pays only the extra rent and appends zero-filled allocation. All active v1 fields,
/// version, rights, balances and authority stay unchanged; unused padding in
/// the new extension slots is normalized so stale Option bytes cannot decode. This is not a v2
/// migration and grants no new issuance or voting permissions.
#[derive(Accounts)]
pub struct PrepareLegacyAccount<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: owner, original discriminator/layout/version and canonical PDA
    /// are validated below before resizing. No arbitrary program account write.
    #[account(mut, owner = crate::ID)]
    pub legacy_account: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_prepare_legacy_account(ctx: Context<PrepareLegacyAccount>) -> Result<()> {
    let account = ctx.accounts.legacy_account.to_account_info();
    let (old_len, new_len, used_len, added_len, expected) = {
        let data = account.try_borrow_data()?;
        require!(data.len() >= 8, RegistryError::AccountMigrationRequired);
        if data[..8] == *ShareClass::DISCRIMINATOR {
            let mut cursor = &data[8..];
            let legacy = LegacyShareClass::deserialize(&mut cursor)?;
            let used_len = data.len() - cursor.len();
            require!(legacy.version == 1, RegistryError::AccountMigrationRequired);
            let expected = Pubkey::create_program_address(
                &[
                    SHARE_CLASS_SEED,
                    legacy.asset.as_ref(),
                    &[legacy.class_index],
                    &[legacy.bump],
                ],
                &crate::ID,
            )
            .map_err(|_| RegistryError::Unauthorized)?;
            (
                8 + LegacyShareClass::INIT_SPACE,
                8 + ShareClass::INIT_SPACE,
                used_len,
                9,
                expected,
            )
        } else if data[..8] == *PayoutVault::DISCRIMINATOR {
            let mut cursor = &data[8..];
            let legacy = LegacyPayoutVault::deserialize(&mut cursor)?;
            let used_len = data.len() - cursor.len();
            require!(legacy.version == 1, RegistryError::AccountMigrationRequired);
            let expected = Pubkey::create_program_address(
                &[PAYOUT_SEED, legacy.sale.as_ref(), &[legacy.bump]],
                &crate::ID,
            )
            .map_err(|_| RegistryError::Unauthorized)?;
            (
                8 + LegacyPayoutVault::INIT_SPACE,
                8 + PayoutVault::INIT_SPACE,
                used_len,
                9,
                expected,
            )
        } else if data[..8] == *VaultVote::DISCRIMINATOR {
            let mut cursor = &data[8..];
            let legacy = LegacyVaultVote::deserialize(&mut cursor)?;
            let used_len = data.len() - cursor.len();
            require!(legacy.version == 1, RegistryError::AccountMigrationRequired);
            let expected = Pubkey::create_program_address(
                &[
                    VAULT_VOTE_SEED,
                    legacy.payout_vault.as_ref(),
                    &[legacy.bump],
                ],
                &crate::ID,
            )
            .map_err(|_| RegistryError::Unauthorized)?;
            (
                8 + LegacyVaultVote::INIT_SPACE,
                8 + VaultVote::INIT_SPACE,
                used_len,
                8,
                expected,
            )
        } else {
            return err!(RegistryError::AccountMigrationRequired);
        }
    };
    require_keys_eq!(*account.key, expected, RegistryError::Unauthorized);
    require!(
        account.data_len() == old_len || account.data_len() == new_len,
        RegistryError::AccountMigrationRequired
    );
    let top_up = Rent::get()?
        .minimum_balance(new_len)
        .saturating_sub(account.lamports());
    if top_up > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: account.clone(),
                },
            ),
            top_up,
        )?;
    }
    if account.data_len() != new_len {
        account.resize(new_len)?;
    }
    // Option fields may once have been Some: old serialization does not clear
    // unused allocation after the active v1 prefix. Normalize only the new
    // slots there, never an active legacy field or its version/bump.
    account.try_borrow_mut_data()?[used_len..used_len + added_len].fill(0);
    msg!("Legacy account size prepared; original version and all legacy fields preserved");
    Ok(())
}
