use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenInterface;

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{
    CustodyVault, KycEntry, KycRegistry, KycStatus, Offer, OfferStatus, OtcDeal, OtcDealStatus,
    RentReclaimed, VaultState,
};
use crate::util::{close_empty_escrow, close_program_account, ensure, tombstone_program_account};

/// Returns the rent of a terminal account to its recorded owner (2D). The
/// target's 8-byte discriminator selects the arm:
///
/// | arm          | closable when                  | signer              | rent to              |
/// |--------------|--------------------------------|---------------------|----------------------|
/// | Offer        | status != Open                 | anyone (crank)      | `offer.maker`        |
/// | OtcDeal      | status != Open                 | `deal.admin`        | `deal.admin`         |
/// | CustodyVault | Realized / Reverted / Returned | `vault.authority`   | `vault.authority`    |
/// | KycEntry     | Revoked and `expiry <= now`    | `registry.authority`| `registry.authority` |
///
/// Offer, OtcDeal and CustodyVault parents are TOMBSTONED, not closed: their
/// escrows (which must be empty) are closed and the parent shrinks to the
/// 8-byte `CLOSED_ACCOUNT_TAG`, so the PDA can never be re-created with new
/// terms under an old id. A KycEntry is closed outright (re-approval through
/// `approve_holder` is the intended way back) and `entries_count` drops by one.
/// Not pause-gated: this is cleanup of already-terminal state.
#[derive(Accounts)]
pub struct ReclaimRent<'info> {
    /// Offer arm: any signer (the rent is fixed to the maker). Every other
    /// arm: must equal `owner`.
    pub caller: Signer<'info>,

    /// The recorded rent owner: `offer.maker` | `deal.admin` |
    /// `vault.authority` | `registry.authority`.
    /// CHECK: bound by key per arm in the handler.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,

    /// The terminal account, owned by this program. Its discriminator selects
    /// the arm, which deserializes it with `try_deserialize`; an unknown tag
    /// (a tombstone included) is refused.
    /// CHECK: owner and discriminator are checked first in the handler.
    #[account(mut)]
    pub target: UncheckedAccount<'info>,

    /// `Offer.escrow` | `OtcDeal.asset_escrow` | `CustodyVault.escrow` |
    /// `KycEntry.registry`.
    /// CHECK: bound by key per arm in the handler.
    #[account(mut)]
    pub linked: UncheckedAccount<'info>,

    /// `OtcDeal.payment_escrow`; `None` for every other arm.
    /// CHECK: bound by key in the OtcDeal arm.
    #[account(mut)]
    pub linked_b: Option<UncheckedAccount<'info>>,

    /// Token program owning `linked` (token arms only).
    pub token_program: Option<Interface<'info, TokenInterface>>,

    /// Token program owning `linked_b` (OtcDeal arm only).
    pub token_program_b: Option<Interface<'info, TokenInterface>>,
}

fn decode<T: AccountDeserialize>(info: &AccountInfo) -> Result<T> {
    let data = info.try_borrow_data()?;
    T::try_deserialize(&mut &data[..])
}

#[inline(never)]
fn bind(actual: &Pubkey, expected: &Pubkey) -> Result<()> {
    ensure(actual == expected, RegistryError::Unauthorized)
}

/// What a tombstoning arm needs, read from its parent.
struct Escrowed {
    kind: u8,
    closable: bool,
    /// `None`: permissionless (the Offer crank).
    signer: Option<Pubkey>,
    rent_owner: Pubkey,
    escrow: Pubkey,
    escrow_b: Option<Pubkey>,
    seed: &'static [u8],
    share_class: Pubkey,
    id: u64,
    bump: u8,
}

pub fn handle_reclaim_rent<'info>(ctx: Context<'info, ReclaimRent<'info>>) -> Result<()> {
    let accounts = &ctx.accounts;
    let caller = accounts.caller.key();
    let owner = accounts.owner.to_account_info();
    let target = accounts.target.to_account_info();
    let linked = accounts.linked.to_account_info();
    let before = owner.lamports();

    let mut tag = [0u8; 8];
    {
        let data = target.try_borrow_data()?;
        ensure(
            *target.owner == crate::ID && data.len() >= 8,
            RegistryError::Unauthorized,
        )?;
        tag.copy_from_slice(&data[..8]);
    }

    let parent = if tag == *Offer::DISCRIMINATOR {
        let o = decode::<Offer>(&target)?;
        Escrowed {
            kind: RECLAIM_OFFER,
            closable: o.status != OfferStatus::Open,
            signer: None,
            rent_owner: o.maker,
            escrow: o.escrow,
            escrow_b: None,
            seed: OFFER_SEED,
            share_class: o.share_class,
            id: o.offer_id,
            bump: o.bump,
        }
    } else if tag == *OtcDeal::DISCRIMINATOR {
        let d = decode::<OtcDeal>(&target)?;
        Escrowed {
            kind: RECLAIM_OTC,
            closable: d.status != OtcDealStatus::Open,
            signer: Some(d.admin),
            rent_owner: d.admin,
            escrow: d.asset_escrow,
            escrow_b: Some(d.payment_escrow),
            seed: OTC_DEAL_SEED,
            share_class: d.share_class,
            id: d.deal_id,
            bump: d.bump,
        }
    } else if tag == *CustodyVault::DISCRIMINATOR {
        // `Expired` is never written; only the three real terminal states.
        let v = decode::<CustodyVault>(&target)?;
        Escrowed {
            kind: RECLAIM_CUSTODY,
            closable: matches!(
                v.state,
                VaultState::Realized | VaultState::Reverted | VaultState::Returned
            ),
            signer: Some(v.authority),
            rent_owner: v.authority,
            escrow: v.escrow,
            escrow_b: None,
            seed: CUSTODY_SEED,
            share_class: v.share_class,
            id: v.vault_id,
            bump: v.bump,
        }
    } else if tag == *KycEntry::DISCRIMINATOR {
        // The KYC provider only, and only once the entry is Revoked AND past
        // its expiry: the whole validity window stays open for
        // `clawback_from_holder`, which needs a live entry.
        let entry = decode::<KycEntry>(&target)?;
        bind(linked.key, &entry.registry)?;
        bind(linked.owner, &crate::ID)?;
        let mut registry = decode::<KycRegistry>(&linked)?;
        bind(&caller, &registry.authority)?;
        bind(owner.key, &registry.authority)?;
        ensure(
            entry.status == KycStatus::Revoked && entry.expiry <= Clock::get()?.unix_timestamp,
            RegistryError::AccountNotClosable,
        )?;
        // `entries_count` counts live entries; re-approval counts it again.
        registry.entries_count = registry.entries_count.saturating_sub(1);
        registry.try_serialize(&mut &mut linked.try_borrow_mut_data()?[..])?;
        close_program_account(&target, &owner)?;
        return emit_reclaimed(RECLAIM_KYC, &target, &owner, before);
    } else {
        return ensure(false, RegistryError::Unauthorized);
    };

    if let Some(signer) = parent.signer {
        bind(&caller, &signer)?;
    }
    bind(owner.key, &parent.rent_owner)?;
    bind(linked.key, &parent.escrow)?;
    let linked_b = match (parent.escrow_b, accounts.linked_b.as_ref()) {
        (Some(key), Some(info)) => {
            bind(info.key, &key)?;
            Some(info.to_account_info())
        }
        (Some(_), None) => return ensure(false, RegistryError::Unauthorized),
        (None, _) => None,
    };
    ensure(parent.closable, RegistryError::AccountNotClosable)?;

    let id = parent.id.to_le_bytes();
    let seeds: &[&[u8]] = &[
        parent.seed,
        parent.share_class.as_ref(),
        &id,
        &[parent.bump],
    ];
    close_empty_escrow(
        &linked,
        accounts.token_program.as_ref(),
        &target,
        &owner,
        seeds,
    )?;
    if let Some(escrow_b) = linked_b {
        close_empty_escrow(
            &escrow_b,
            accounts.token_program_b.as_ref(),
            &target,
            &owner,
            seeds,
        )?;
    }
    tombstone_program_account(&target, &owner)?;
    emit_reclaimed(parent.kind, &target, &owner, before)
}

fn emit_reclaimed(kind: u8, target: &AccountInfo, owner: &AccountInfo, before: u64) -> Result<()> {
    emit!(RentReclaimed {
        kind,
        target: target.key(),
        owner: owner.key(),
        lamports: owner.lamports().saturating_sub(before),
    });
    Ok(())
}
