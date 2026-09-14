//! Original v1 layouts copied field-for-field from the v1 program.
//! Used only to authenticate size preparation; never infer appended history.
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace)]
pub struct LegacyShareClass {
    pub asset: Pubkey,
    pub mint: Pubkey,
    pub class_index: u8,
    pub class_type: ShareClassType,
    pub rights_bitfield: u8,
    pub liq_pref_multiplier_bps: u16,
    pub liq_seniority: u8,
    pub voting_weight: u32,
    pub convertible_to: Option<Pubkey>,
    pub max_supply: Option<u64>,
    pub circulating_supply: u64,
    pub locked_supply: u64,
    pub mintable_post_launch: bool,
    pub mint_initialized: bool,
    pub supply_locked: bool,
    pub version: u8,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace)]
pub struct LegacyPayoutVault {
    pub sale: Pubkey,
    pub share_class: Pubkey,
    pub payment_mint: Pubkey,
    pub escrow: Pubkey,
    pub founder: Pubkey,
    pub raise_type: RaiseType,
    pub total_amount: u64,
    pub released: u64,
    pub start_ts: i64,
    pub cliff_months: u8,
    pub vesting_months: u8,
    pub num_tranches: u8,
    pub tranche_amount: u64,
    pub tranches_released: u8,
    pub updates_posted: u32,
    pub last_update_ts: i64,
    pub founder_yield_claimable: u64,
    pub investor_yield_pool: u64,
    pub investor_yield_root: [u8; 32],
    pub total_weight: u64,
    pub state: PayoutVaultState,
    pub metadata_hash: [u8; 32],
    pub version: u8,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace)]
pub struct LegacyVaultVote {
    pub payout_vault: Pubkey,
    pub snapshot_root: [u8; 32],
    pub start_ts: i64,
    pub end_ts: i64,
    pub return_weight: u64,
    pub extend_weight: u64,
    pub outcome: VaultVoteOutcome,
    pub version: u8,
    pub bump: u8,
}
