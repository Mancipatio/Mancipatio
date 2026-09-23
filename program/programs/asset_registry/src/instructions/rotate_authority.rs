use crate::{
    constants::*,
    error::RegistryError,
    state::{Admin, AuthorityTransfer, CustodyVault, Platform, VaultState},
};
use anchor_lang::prelude::*;

pub(crate) fn validate_new_authority(current: Pubkey, proposed: Pubkey) -> Result<()> {
    require!(
        proposed != Pubkey::default() && proposed != current,
        RegistryError::InvalidProposedAuthority
    );
    Ok(())
}
pub(crate) fn write_proposal(
    record: &mut AuthorityTransfer,
    target: Pubkey,
    current: Pubkey,
    proposed: Pubkey,
    proposer: Pubkey,
    bump: u8,
) {
    record.target = target;
    record.current_authority = current;
    record.new_authority = proposed;
    record.proposed_by = proposer;
    record.bump = bump;
}

#[derive(Accounts)]
pub struct ProposePlatformAdmin<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump, constraint = platform.admin == authority.key() @ RegistryError::Unauthorized)]
    pub platform: Account<'info, Platform>,
    #[account(init_if_needed, payer = authority, space = 8 + AuthorityTransfer::INIT_SPACE,
        seeds = [AUTHORITY_TRANSFER_SEED, platform.key().as_ref()], bump)]
    pub transfer: Account<'info, AuthorityTransfer>,
    pub system_program: Program<'info, System>,
}

pub fn handle_propose_platform_admin(
    ctx: Context<ProposePlatformAdmin>,
    new_admin: Pubkey,
) -> Result<()> {
    validate_new_authority(ctx.accounts.platform.admin, new_admin)?;
    write_proposal(
        &mut ctx.accounts.transfer,
        ctx.accounts.platform.key(),
        ctx.accounts.platform.admin,
        new_admin,
        ctx.accounts.authority.key(),
        ctx.bumps.transfer,
    );
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptPlatformAdmin<'info> {
    #[account(mut)]
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Account<'info, Platform>,
    #[account(mut, close = new_admin, seeds = [AUTHORITY_TRANSFER_SEED, platform.key().as_ref()], bump = transfer.bump,
        constraint = transfer.target == platform.key() && transfer.current_authority == platform.admin
            && transfer.proposed_by == platform.admin && transfer.new_authority == new_admin.key() @ RegistryError::InvalidAuthorityTransfer)]
    pub transfer: Account<'info, AuthorityTransfer>,
    /// CHECK: derived old role, validated and closed in the handler if present.
    /// It may be unresolved on an older deployment that revoked its own role.
    #[account(mut, seeds = [ADMIN_SEED, platform.admin.as_ref()], bump)]
    pub old_admin_record: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = new_admin, space = 8 + Admin::INIT_SPACE,
        seeds = [ADMIN_SEED, new_admin.key().as_ref()], bump)]
    pub new_admin_record: Account<'info, Admin>,
    pub system_program: Program<'info, System>,
}

/// Rotates application administration only; the ProgramData upgrade authority
/// is an independent deployment role and is never changed by this instruction.
pub fn handle_accept_platform_admin(ctx: Context<AcceptPlatformAdmin>) -> Result<()> {
    let previous = ctx.accounts.platform.admin;
    let old = ctx.accounts.old_admin_record.to_account_info();
    if !old.data_is_empty() {
        require!(
            crate::util::is_active_admin(&old, &previous),
            RegistryError::Unauthorized
        );
        // Close the validated old Admin PDA, including when migrating a legacy
        // operational role. A missing old role needs no repair just to rotate.
        let recipient = ctx.accounts.new_admin.to_account_info();
        let refunded = recipient
            .lamports()
            .checked_add(old.lamports())
            .ok_or(RegistryError::Overflow)?;
        **recipient.try_borrow_mut_lamports()? = refunded;
        **old.try_borrow_mut_lamports()? = 0;
        old.assign(&anchor_lang::system_program::ID);
        old.resize(0)?;
    }
    let record = &mut ctx.accounts.new_admin_record;
    record.admin = ctx.accounts.new_admin.key();
    record.added_by = previous;
    record.bump = ctx.bumps.new_admin_record;
    ctx.accounts.platform.admin = ctx.accounts.new_admin.key();
    msg!(
        "Platform operational admin rotated — {} -> {}",
        previous,
        ctx.accounts.platform.admin
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(new_authority: Pubkey)]
pub struct ProposeCustodyAuthority<'info> {
    #[account(mut)]
    pub super_admin: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump, constraint = platform.admin == super_admin.key() @ RegistryError::Unauthorized)]
    pub platform: Account<'info, Platform>,
    #[account(seeds = [CUSTODY_SEED, custody_vault.share_class.as_ref(), &custody_vault.vault_id.to_le_bytes()], bump = custody_vault.bump,
        constraint = matches!(custody_vault.state, VaultState::Active | VaultState::Triggered) @ RegistryError::InvalidVaultState)]
    pub custody_vault: Box<Account<'info, CustodyVault>>,
    #[account(seeds = [ADMIN_SEED, new_authority.as_ref()], bump = new_admin_record.bump)]
    pub new_admin_record: Account<'info, Admin>,
    #[account(init_if_needed, payer = super_admin, space = 8 + AuthorityTransfer::INIT_SPACE,
        seeds = [AUTHORITY_TRANSFER_SEED, custody_vault.key().as_ref()], bump)]
    pub transfer: Account<'info, AuthorityTransfer>,
    pub system_program: Program<'info, System>,
}

/// The platform can recover an operator's vault after that operator's Admin
/// role was revoked. It never changes the beneficiary or custody contract.
pub fn handle_propose_custody_authority(
    ctx: Context<ProposeCustodyAuthority>,
    new_authority: Pubkey,
) -> Result<()> {
    validate_new_authority(ctx.accounts.custody_vault.authority, new_authority)?;
    write_proposal(
        &mut ctx.accounts.transfer,
        ctx.accounts.custody_vault.key(),
        ctx.accounts.custody_vault.authority,
        new_authority,
        ctx.accounts.super_admin.key(),
        ctx.bumps.transfer,
    );
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptCustodyAuthority<'info> {
    #[account(mut)]
    pub new_authority: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Account<'info, Platform>,
    #[account(mut, seeds = [CUSTODY_SEED, custody_vault.share_class.as_ref(), &custody_vault.vault_id.to_le_bytes()], bump = custody_vault.bump,
        constraint = matches!(custody_vault.state, VaultState::Active | VaultState::Triggered) @ RegistryError::InvalidVaultState)]
    pub custody_vault: Box<Account<'info, CustodyVault>>,
    #[account(seeds = [ADMIN_SEED, new_authority.key().as_ref()], bump = new_admin_record.bump)]
    pub new_admin_record: Account<'info, Admin>,
    #[account(mut, close = new_authority, seeds = [AUTHORITY_TRANSFER_SEED, custody_vault.key().as_ref()], bump = transfer.bump,
        constraint = transfer.target == custody_vault.key() && transfer.current_authority == custody_vault.authority
            && transfer.proposed_by == platform.admin && transfer.new_authority == new_authority.key() @ RegistryError::InvalidAuthorityTransfer)]
    pub transfer: Account<'info, AuthorityTransfer>,
}

pub fn handle_accept_custody_authority(ctx: Context<AcceptCustodyAuthority>) -> Result<()> {
    ctx.accounts.custody_vault.authority = ctx.accounts.new_authority.key();
    msg!(
        "Custody operational authority rotated — vault {}",
        ctx.accounts.custody_vault.key()
    );
    Ok(())
}
