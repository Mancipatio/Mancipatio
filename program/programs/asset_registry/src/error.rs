use anchor_lang::prelude::*;

#[error_code]
pub enum RegistryError {
    #[msg("Platform is paused")]
    PlatformPaused,
    #[msg("Signer is not authorized for this action")]
    Unauthorized,
    #[msg("Issuer KYB is not verified")]
    IssuerNotVerified,
    #[msg("Asset must be in Draft status for this action")]
    AssetNotDraft,
    #[msg("Asset id must be 1..=32 bytes")]
    InvalidAssetId,
    #[msg("Text field is empty or exceeds its maximum length")]
    InvalidText,
    #[msg("Share class limit reached for this asset")]
    TooManyShareClasses,
    #[msg("Share class index must equal the asset's current share_classes_count")]
    InvalidShareClassIndex,
    #[msg("Protocol fee exceeds the 10% ceiling")]
    InvalidFeeBps,
    #[msg("Rights bitfield contains undefined bits")]
    InvalidRightsBitfield,
    #[msg("Liquidation preference multiplier must be >= 1.0x (10000 bps)")]
    InvalidLiqPref,
    #[msg("KYC entry expiry is in the past")]
    KycExpiryInPast,
    #[msg("Share class mint is already initialized")]
    MintAlreadyInitialized,
    #[msg("Share class mint is not initialized yet")]
    MintNotInitialized,
    #[msg("Mint would exceed the share class max supply")]
    MaxSupplyExceeded,
    #[msg("Custody vault is not in the required state for this action")]
    InvalidVaultState,
    #[msg("This realize action is not supported yet")]
    UnsupportedRealizeAction,
    #[msg("Custody vault deadline has not passed yet")]
    VaultNotExpired,
    #[msg("Sale is not open")]
    SaleNotOpen,
    #[msg("Sale has not started yet")]
    SaleNotStarted,
    #[msg("Sale window has closed")]
    SaleWindowClosed,
    #[msg("Sale does not have enough units left")]
    SaleSoldOut,
    #[msg("Invalid sale parameters")]
    InvalidSaleParams,
    #[msg("OTC offer is not open")]
    OfferNotOpen,
    #[msg("Invalid OTC offer parameters")]
    InvalidOfferParams,
    #[msg("OTC offer escrow is not funded with enough units")]
    OfferNotFunded,
    #[msg("Invalid governance proposal parameters")]
    InvalidProposalParams,
    #[msg("Proposal is not active")]
    ProposalNotActive,
    #[msg("Voting has not started yet")]
    VotingNotStarted,
    #[msg("Voting window has closed")]
    VotingClosed,
    #[msg("Merkle proof does not match the snapshot root")]
    InvalidMerkleProof,
    #[msg("Proposal voting window has not ended yet")]
    ProposalNotEnded,
    #[msg("Vesting milestone is still locked")]
    MilestoneLocked,
    #[msg("Claim would exceed the milestone pool")]
    MilestonePoolExceeded,
    #[msg("Share class supply is locked — minting is closed")]
    SupplyLocked,
    #[msg("Numeric overflow")]
    Overflow,
    #[msg("Payout vault is not Active")]
    VaultNotActive,
    #[msg("Next tranche is not due yet")]
    TrancheNotDue,
    #[msg("A monthly update must be posted before releasing this tranche")]
    UpdateRequired,
    #[msg("Nothing available to release")]
    NothingToRelease,
    #[msg("Payout vault is not Frozen")]
    VaultNotFrozen,
    #[msg("Vault vote is still in progress")]
    VoteInProgress,
    #[msg("Vault vote has already ended")]
    VoteNotEnded,
    #[msg("Signer is not the vault founder")]
    NotFounder,
    #[msg("This claim has already been fully drawn")]
    AlreadyClaimed,
    #[msg("Payout vault is not Cancelled")]
    NotCancelled,
    #[msg("Invalid raise parameters")]
    InvalidRaiseParams,
    #[msg("Nothing available to claim")]
    NothingToClaim,
    #[msg("Offer expiry must be 0 or in the future")]
    InvalidExpiry,
    #[msg("OTC offer has expired")]
    OfferExpired,
    #[msg("OTC offer has not expired yet")]
    OfferNotExpired,
    #[msg("A DeliveryEscrow vault requires a beneficiary")]
    BeneficiaryRequired,
    #[msg("Return not allowed — only the vault authority may return before the deadline")]
    ReturnNotAllowed,
    #[msg("DeliveryEscrow vaults cannot be reverted — use return_custody_vault")]
    DeliveryVaultUseReturn,
    #[msg("OTC deal is not open")]
    DealNotOpen,
    #[msg("OTC deal has expired")]
    DealExpired,
    #[msg("OTC deal has not expired yet")]
    DealNotExpired,
    #[msg("Invalid OTC deal parameters")]
    InvalidDealParams,
    #[msg("Signer is not the required deal party")]
    WrongDealParty,
    #[msg("This side of the OTC deal is already deposited")]
    DealAlreadyDeposited,
    #[msg("Distribution is not active for this action")]
    DistributionNotActive,
    #[msg("Invalid distribution parameters")]
    InvalidDistributionParams,
    #[msg("Batch would exceed the distribution's total amount")]
    DistributionOverdraw,
    #[msg("Distribution recipient must be a payment-mint token account")]
    InvalidDistributionRecipient,
    #[msg("Asset must be Active for this action")]
    AssetNotActive,
    #[msg("Only the metadata uri field may be updated")]
    InvalidMetadataField,
    #[msg("Share-class mint has no on-chain metadata")]
    MintMetadataMissing,
    #[msg("Custody vault deadline must be 0 (no deadline) or a future-capable positive timestamp")]
    InvalidDeadline,
    #[msg("Refund account must be owned by the distribution funder")]
    RefundNotFunderOwned,
    #[msg("Receiver has no approved KYC entry for this KycGated mint")]
    ReceiverNotApproved,
    #[msg("Receiver's KYC entry has expired")]
    ReceiverKycExpired,
    #[msg("Receiver's jurisdiction is not allowed by the registry")]
    ReceiverJurisdictionBlocked,
    #[msg("KYC registry account is malformed, truncated, or unexpected")]
    InvalidKycRegistry,
    #[msg("A PhysicalGood asset's share class must have max_supply = 1")]
    PhysicalGoodRequiresUnitSupply,
    #[msg("Convertible target must be an existing share class of the same asset and not the class itself")]
    ConvertibleTargetInvalid,
    #[msg("A PhysicalGood asset can hold exactly one share class (class_index 0)")]
    PhysicalGoodSingleClass,
    #[msg("A PhysicalGood share class must not be mintable post-launch")]
    PhysicalGoodPostLaunchMint,
    #[msg(
        "Buy requires the mint's hook accounts (config or meta list) to prove its restriction mode"
    )]
    KycProofRequired,
    #[msg("Destination must be the issuer treasury or the escrow of a CustodyVault / RightsIssuance of this mint (pass that PDA in remaining accounts)")]
    MintDestinationNotBound,
    #[msg("Clawback requires the holder's KYC entry to be Revoked or expired")]
    ClawbackHolderStillEligible,
    #[msg("Clawback is only available on KycGated mints")]
    ClawbackNotKycGated,
    #[msg("Clawback destination must be the escrow of an Active RedemptionQueue + BurnAndAttest custody vault of this share class")]
    ClawbackDestinationInvalid,
    #[msg("Mint destination vault must be burn-only — not a DeliveryEscrow, and realize_action must be BurnAndAttest")]
    MintDestinationVaultNotBurnOnly,
    #[msg("Revert not allowed — without a positive deadline only the vault authority may revert")]
    RevertNotAllowed,
    #[msg("A DeliveryEscrow vault may only be funded by its own beneficiary")]
    DepositorNotBeneficiary,
    #[msg("Deposit amount must be greater than zero")]
    InvalidDepositAmount,
    #[msg("Custody vault must be Active to accept a deposit")]
    VaultNotAcceptingDeposits,
    #[msg("Clawback target is a program escrow, not a holder wallet")]
    ClawbackTargetIsEscrow,
    #[msg("Invalid vesting schedule: 1-64 tranches, strictly ascending unlock times, every amount > 0")]
    InvalidVestingSchedule,
    #[msg("Approval window out of range (1 hour to 90 days), or set for a non-Approval series")]
    InvalidApprovalWindow,
    #[msg("Pre-cliff percentage exceeds 100%")]
    InvalidPreCliffBps,
    #[msg("Vesting series is not Active for this action")]
    VestingNotActive,
    #[msg("Vesting series is not Cancelled")]
    VestingNotCancelled,
    #[msg("Cancellation is not enabled on this series")]
    VestingNotCancellable,
    #[msg("Recovery is not enabled on this series")]
    VestingRecoveryDisabled,
    #[msg("This action does not match the series delivery mode")]
    VestingWrongDeliveryMode,
    #[msg("Series is not in Approval timing mode")]
    VestingNotApprovalMode,
    #[msg("Tranche index out of range")]
    InvalidTrancheIndex,
    #[msg("Positions can only be added before the first release")]
    VestingAlreadyStarted,
    #[msg("Allocation must be greater than zero")]
    InvalidVestingAllocation,
    #[msg("Nothing vested and deliverable yet (check funding, schedule, approval)")]
    VestingNothingToClaim,
    #[msg("Nothing withdrawable — all remaining funds are reserved for recipients")]
    VestingNothingToWithdraw,
    #[msg("Schedule total must equal the sum of position allocations before release")]
    VestingAllocationMismatch,
    #[msg("Share-token recipients must have the Token-2022 ImmutableOwner extension")]
    ImmutableOwnerRequired,
    #[msg("This account requires a reviewed migration before this operation")]
    AccountMigrationRequired,
    #[msg("Vesting positions can only be changed while the series is Draft")]
    VestingNotDraft,
    #[msg("Vesting must be finalized before its first scheduled unlock")]
    VestingStartReached,
    #[msg("A payout vote is already open for this vault")]
    VaultVoteAlreadyOpen,
    #[msg("Vote does not belong to the currently pending vault round")]
    InvalidVaultVoteRound,
    #[msg("An asset must have at least one share class before activation")]
    AssetHasNoShareClasses,
    #[msg("Only an unverified issuer registration with no assets can be recovered")]
    IssuerRegistrationNotRecoverable,
    #[msg("Unknown issuer permission capability")]
    InvalidIssuerPermissions,
    #[msg("Proposed authority must be a different nonzero key")]
    InvalidProposedAuthority,
    #[msg("Authority proposal does not match the current authority and accepting signer")]
    InvalidAuthorityTransfer,
    #[msg("Rotate the platform admin before revoking its global admin role")]
    CannotRevokePlatformAdmin,
    #[msg("This mint extension is not supported for new funding in this release")]
    UnsupportedMintExtension,
    #[msg("Distribution batch plan or receipt does not match the committed payload")]
    InvalidDistributionPlan,
    #[msg("Cumulative vesting funding cannot exceed the immutable schedule total")]
    VestingFundingExceedsSchedule,
    #[msg("Pause flags contain undefined bits, or a bit is both set and cleared")]
    InvalidPauseFlags,
    #[msg("Only the super admin may clear pause flags")]
    PauseClearNotAllowed,
    #[msg("Protocol treasury must be a nonzero key")]
    InvalidProtocolTreasury,
    #[msg("Sale price per unit must be greater than zero")]
    InvalidSalePrice,
    #[msg("Sale approval has expired")]
    SaleApprovalExpired,
    #[msg("Sale does not match its approval (issuer, share class, payment mint, raise type or rent recipient)")]
    SaleApprovalMismatch,
    #[msg("Sale price per unit is outside the approved range")]
    SalePriceOutsideApproval,
    #[msg("price_per_unit x total_for_sale exceeds the approved maximum gross raise")]
    SaleExceedsApprovedRaise,
    #[msg("Approval terms invalid: expiry must be in the future and at most 90 days away, 0 < min price <= max price, max gross raise > 0, application hash non-zero, and cliff/vesting 0/0 for Mature or vesting > cliff for Startup")]
    InvalidSaleApproval,
    #[msg("A sale with this id already exists for the share class")]
    SaleIdAlreadyUsed,
    #[msg("Minting into the issuer treasury requires a platform Admin issuer key; the MINT permission only funds custody or rights escrows")]
    TreasuryMintRequiresAdmin,
    #[msg("Sale cliff / vesting months differ from the approved schedule")]
    SaleVestingOutsideApproval,
    #[msg("Sale start is after the approval's expiry")]
    SaleStartsAfterApprovalExpiry,
    // ── 2C-2 (appended: every earlier code keeps its position) ──
    #[msg("Issuer recovery is still inside its 7-day timelock")]
    IssuerRecoveryTimelockActive,
    #[msg("Issuer recovery execution window has passed; the super admin must re-propose")]
    IssuerRecoveryExpired,
    #[msg("Issuer recovery does not match the issuer's current authority, the current super admin, or the executing signer")]
    InvalidIssuerRecovery,
    // ── 2C-3 (appended: every earlier code keeps its position) ──
    #[msg("A DeliveryEscrow custody vault must pin a KYC registry at open; realize must pass it with the beneficiary's KYC entry")]
    CustodyKycRegistryRequired,
    #[msg("Only a DeliveryEscrow custody vault may pin a KYC registry")]
    CustodyKycRegistryNotAllowed,
    #[msg("KYC registry does not match the registry pinned on this custody vault")]
    CustodyKycRegistryMismatch,
    // ── 2C-4 (appended: every earlier code keeps its position) ──
    #[msg("Holder is not on the transfer-hook blocklist (no live BlockEntry for this wallet)")]
    ClawbackHolderNotBlocked,
    #[msg("Transfer-hook config is missing or does not belong to this mint and share class")]
    HookConfigInvalid,
}
