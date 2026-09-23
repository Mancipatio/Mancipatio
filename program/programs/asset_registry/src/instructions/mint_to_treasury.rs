use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, MintTo, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::RegistryError;
use crate::state::{
    Asset, AssetStatus, CustodyVault, Issuer, RealizeAction, RightsIssuance, ShareClass,
    TreasuryMinted, VaultState, VaultType,
};

#[derive(Accounts)]
pub struct MintToTreasury<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Global Admin or issuer-local MINT capability; the signer must also be the issuer.
    /// The treasury destination (the signer's own token account) additionally
    /// requires the global Admin record: MINT alone only funds the admin-created
    /// custody / rights escrows.
    /// CHECK: validated by require_issuer_permission before any state change/CPI.
    pub admin_record: UncheckedAccount<'info>,

    #[account(
        seeds = [ISSUER_SEED, issuer.legal_entity_id.as_ref()],
        bump = issuer.bump,
        constraint = issuer.kyb_status == crate::state::KybStatus::Verified @ RegistryError::IssuerNotVerified,
        has_one = authority @ RegistryError::Unauthorized,
    )]
    pub issuer: Box<Account<'info, Issuer>>,

    #[account(
        seeds = [ASSET_SEED, issuer.key().as_ref(), asset.asset_id.as_bytes()],
        bump = asset.bump,
        has_one = issuer @ RegistryError::Unauthorized,
        constraint = asset.status == AssetStatus::Active @ RegistryError::AssetNotActive,
    )]
    pub asset: Box<Account<'info, Asset>>,

    #[account(
        mut,
        seeds = [SHARE_CLASS_SEED, asset.key().as_ref(), &[share_class.class_index]],
        bump = share_class.bump,
        has_one = mint @ RegistryError::Unauthorized,
        constraint = share_class.mint_initialized @ RegistryError::MintNotInitialized,
    )]
    pub share_class: Box<Account<'info, ShareClass>>,

    #[account(
        mut,
        seeds = [SHARE_MINT_SEED, share_class.key().as_ref()],
        bump,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// Destination token account — receives the freshly minted units. Bound in
    /// the handler: owned by the signing issuer authority (the treasury) or the
    /// escrow of an `Active` burn-only `CustodyVault` / a `RightsIssuance` of
    /// this very mint (proven by deserializing that account, not by its owner
    /// program — and, for a vault, by its exit shape).
    #[account(
        mut,
        constraint = destination.mint == mint.key() @ RegistryError::Unauthorized,
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,

    /// Emergency-pause gate (read-only). Keep LAST among named accounts: old
    /// account indices and the remaining-accounts hook tail keep their positions.
    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = !platform.is_paused(PAUSE_PRIMARY) @ RegistryError::PlatformPaused,
    )]
    pub platform: Box<Account<'info, crate::state::Platform>>,
    // remaining_accounts: when the destination is a program escrow, append the
    // escrow's parent account — the `CustodyVault` or `RightsIssuance` PDA that
    // owns it. The handler DESERIALIZES it as that concrete type and requires
    // `escrow == destination` plus a matching mint, so any other
    // registry-owned account (e.g. a permissionlessly created `Offer`) is
    // rejected. See the destination binding in the handler.
}

/// Mints `amount` share-class units into a destination token account. The
/// `ShareClass` PDA is the mint authority and signs the Token-2022 CPI.
/// Enforces `max_supply`, bumps `circulating_supply`, binds the destination
/// (issuer treasury, Admin issuer keys only; or the escrow of an `Active`
/// burn-only `CustodyVault` / a `RightsIssuance` of this mint) and emits
/// `TreasuryMinted`.
pub fn handle_mint_to_treasury(ctx: Context<MintToTreasury>, amount: u64) -> Result<()> {
    crate::util::require_issuer_permission(
        &ctx.accounts.admin_record.to_account_info(),
        &ctx.accounts.issuer,
        &ctx.accounts.authority.key(),
        ISSUER_PERMISSION_MINT,
    )?;

    crate::util::require_immutable_owner(&ctx.accounts.destination.to_account_info())?;

    let class_index = ctx.accounts.share_class.class_index;
    let sc_bump = ctx.accounts.share_class.bump;
    let (new_supply, new_lifetime) =
        crate::util::next_issuance_supply(&ctx.accounts.share_class, amount)?;

    require!(
        !ctx.accounts.share_class.supply_locked || ctx.accounts.share_class.mintable_post_launch,
        RegistryError::SupplyLocked
    );

    // Destination binding — `mint_to` does not run the transfer hook, so this
    // is the only receiver control on treasury emission. Exactly two shapes are
    // accepted:
    //
    //   1. the signing issuer authority's own token account (the treasury);
    //   2. the escrow of an ADMIN-GATED escrow parent of THIS mint — an
    //      `Active` BURN-ONLY `CustodyVault` (`open_custody_vault`) or a
    //      `RightsIssuance` (`create_rights_issuance`) — passed in
    //      `remaining_accounts` and deserialized as that concrete type, with
    //      `escrow == destination` and a matching mint / share class.
    //
    // Deserializing (rather than checking `ai.owner == crate::ID`, which any
    // initialized registry account satisfies) is what makes this a binding:
    // `create_offer` is permissionless and creates an `Offer` PDA + escrow +
    // `EscrowMarker`, so an owner-only check let anyone conjure a mint
    // destination whose `cancel_offer` exit pays the whole escrow balance out
    // to the (non-KYC'd) maker. Minting straight to a wallet stays rejected:
    // route it through a sale (`buy`, KYC-gated) or a hook-checked transfer
    // out of the treasury instead.
    //
    // The TYPE alone is not enough, though — see the shape gate below.
    let dest_owner = ctx.accounts.destination.owner;
    let destination_key = ctx.accounts.destination.key();
    let share_class_key = ctx.accounts.share_class.key();
    let mint_key = ctx.accounts.mint.key();
    let bound_to_authority = dest_owner == ctx.accounts.authority.key();
    let mut bound_to_escrow_parent = false;
    for ai in ctx.remaining_accounts.iter() {
        if *ai.key != dest_owner || ai.owner != &crate::ID || ai.data_is_empty() {
            continue;
        }
        let Ok(data) = ai.try_borrow_data() else {
            continue;
        };
        // Custody escrow: same share class, same mint, and the destination is
        // the vault's own escrow. Only `Active` — a vault past a terminal path
        // has no exit left, so freshly minted units would be stranded.
        if let Ok(vault) = CustodyVault::try_deserialize(&mut data.as_ref()) {
            if vault.share_class != share_class_key
                || vault.mint != mint_key
                || vault.escrow != destination_key
                || vault.state != VaultState::Active
            {
                continue;
            }
            // Shape gate — the vault must have NO escrow → arbitrary-wallet
            // exit. `mint_to_treasury` and `open_custody_vault` share one
            // privilege level (an `Admin` record), so without this the very
            // signer this binding constrains could open a `DeliveryEscrow`
            // vault naming any wallet as `beneficiary`, mint into its escrow,
            // and `return_custody_vault` the fresh units out — a leg the
            // vault's OWN `EscrowMarker` (a source marker, alive during the
            // CPI) exempts from the hook's receiver-KYC checks. Net effect:
            // brand-new KycGated units in a wallet with no `KycEntry` — the
            // exact end state the typed binding above exists to prevent.
            //
            // Two conditions, both about the EXIT rather than the label:
            //   * `vault_type != DeliveryEscrow` — `return_custody_vault` is
            //     the only escrow→wallet path in the program and it is
            //     `DeliveryEscrow`-only (delivery escrows are funded by a
            //     holder's own hook-checked deposit, never by fresh emission);
            //   * `realize_action == BurnAndAttest` — the only realize action
            //     `realize_custody_vault` implements. `TransferToBeneficiary`
            //     would pay an arbitrary `beneficiary` the moment it lands, so
            //     funding such a vault must be re-authorised when that action
            //     ships (today it is a strict improvement: realize would fail
            //     with `UnsupportedRealizeAction` and strand the units).
            //
            // What remains reachable — `Vesting` / `ConversionPending` /
            // `RedemptionQueue` + `BurnAndAttest` — is exactly the documented
            // funding flow: every exit of such a vault burns.
            require!(
                vault.vault_type != VaultType::DeliveryEscrow
                    && vault.realize_action == RealizeAction::BurnAndAttest,
                RegistryError::MintDestinationVaultNotBurnOnly
            );
            bound_to_escrow_parent = true;
            break;
        }
        // Rights-Token escrow: the issuance's underlying IS this mint and the
        // destination is the issuance's own escrow. The milestone-claim exit is
        // a hook-checked transfer to the CLAIMER'S OWN account (bound in
        // `claim_milestone`), so receiver KYC still applies there.
        if let Ok(issuance) = RightsIssuance::try_deserialize(&mut data.as_ref()) {
            if issuance.underlying_mint == mint_key && issuance.escrow == destination_key {
                bound_to_escrow_parent = true;
                break;
            }
        }
    }
    require!(
        bound_to_authority || bound_to_escrow_parent,
        RegistryError::MintDestinationNotBound
    );
    // A treasury mint hands out freely transferable new units with no sale
    // approval (and so outside the off-chain raise cap): mint, then sell OTC.
    // Only a platform Admin issuer key may do it. `ISSUER_PERMISSION_MINT`
    // alone covers only the admin-created escrow parents bound above
    // (burn-only custody vaults, rights issuances), whose exits burn or are
    // KYC-checked claims. External issuers issue to the public through an
    // approved sale (`approve_sale` → `open_sale` → `buy`).
    if bound_to_authority {
        require!(
            crate::util::is_active_admin(
                &ctx.accounts.admin_record.to_account_info(),
                &ctx.accounts.authority.key(),
            ),
            RegistryError::TreasuryMintRequiresAdmin
        );
    }

    // The ShareClass PDA is the mint authority — sign the CPI with its seeds.
    let asset_key = ctx.accounts.asset.key();
    let class_index_seed = [class_index];
    let bump_seed = [sc_bump];
    let signer_seeds: &[&[&[u8]]] = &[&[
        SHARE_CLASS_SEED,
        asset_key.as_ref(),
        &class_index_seed,
        &bump_seed,
    ]];

    token_interface::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.share_class.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    ctx.accounts.share_class.circulating_supply = new_supply;
    ctx.accounts.share_class.lifetime_minted = new_lifetime;

    emit!(TreasuryMinted {
        share_class: ctx.accounts.share_class.key(),
        mint: ctx.accounts.mint.key(),
        destination: ctx.accounts.destination.key(),
        destination_owner: dest_owner,
        amount,
    });
    msg!("Minted {} units of share class {}", amount, class_index);
    Ok(())
}
