import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Error codes are part of the on-chain ABI: clients, logs and support
// runbooks decode `Custom(n)` by position. Variants may only be APPENDED;
// removing, renaming or reordering one silently remaps every later code.
// check:idl keeps these committed IDLs identical to the Rust source.
type IdlError = { code: number; name: string };
const errors = (file: string) =>
  (JSON.parse(readFileSync(join(process.cwd(), "idl", file), "utf8")) as { errors: IdlError[] }).errors.map(
    (e) => `${e.code}:${e.name}`,
  );

// RegistryError 6000-6142 (143 variants), frozen for the mainnet candidate.
const REGISTRY_ERRORS = [
  "6000:PlatformPaused", "6001:Unauthorized", "6002:IssuerNotVerified", "6003:AssetNotDraft", "6004:InvalidAssetId",
  "6005:InvalidText", "6006:TooManyShareClasses", "6007:InvalidShareClassIndex", "6008:InvalidFeeBps",
  "6009:InvalidRightsBitfield", "6010:InvalidLiqPref", "6011:KycExpiryInPast", "6012:MintAlreadyInitialized",
  "6013:MintNotInitialized", "6014:MaxSupplyExceeded", "6015:InvalidVaultState", "6016:UnsupportedRealizeAction",
  "6017:VaultNotExpired", "6018:SaleNotOpen", "6019:SaleNotStarted", "6020:SaleWindowClosed", "6021:SaleSoldOut",
  "6022:InvalidSaleParams", "6023:OfferNotOpen", "6024:InvalidOfferParams", "6025:OfferNotFunded",
  "6026:InvalidProposalParams", "6027:ProposalNotActive", "6028:VotingNotStarted", "6029:VotingClosed",
  "6030:InvalidMerkleProof", "6031:ProposalNotEnded", "6032:MilestoneLocked", "6033:MilestonePoolExceeded",
  "6034:SupplyLocked", "6035:Overflow", "6036:VaultNotActive", "6037:TrancheNotDue", "6038:UpdateRequired",
  "6039:NothingToRelease", "6040:VaultNotFrozen", "6041:VoteInProgress", "6042:VoteNotEnded", "6043:NotFounder",
  "6044:AlreadyClaimed", "6045:NotCancelled", "6046:InvalidRaiseParams", "6047:NothingToClaim", "6048:InvalidExpiry",
  "6049:OfferExpired", "6050:OfferNotExpired", "6051:BeneficiaryRequired", "6052:ReturnNotAllowed",
  "6053:DeliveryVaultUseReturn", "6054:DealNotOpen", "6055:DealExpired", "6056:DealNotExpired",
  "6057:InvalidDealParams", "6058:WrongDealParty", "6059:DealAlreadyDeposited", "6060:DistributionNotActive",
  "6061:InvalidDistributionParams", "6062:DistributionOverdraw", "6063:InvalidDistributionRecipient",
  "6064:AssetNotActive", "6065:InvalidMetadataField", "6066:MintMetadataMissing", "6067:InvalidDeadline",
  "6068:RefundNotFunderOwned", "6069:ReceiverNotApproved", "6070:ReceiverKycExpired",
  "6071:ReceiverJurisdictionBlocked", "6072:InvalidKycRegistry", "6073:PhysicalGoodRequiresUnitSupply",
  "6074:ConvertibleTargetInvalid", "6075:PhysicalGoodSingleClass", "6076:PhysicalGoodPostLaunchMint",
  "6077:KycProofRequired", "6078:MintDestinationNotBound", "6079:ClawbackHolderStillEligible",
  "6080:ClawbackNotKycGated", "6081:ClawbackDestinationInvalid", "6082:MintDestinationVaultNotBurnOnly",
  "6083:RevertNotAllowed", "6084:DepositorNotBeneficiary", "6085:InvalidDepositAmount",
  "6086:VaultNotAcceptingDeposits", "6087:ClawbackTargetIsEscrow", "6088:InvalidVestingSchedule",
  "6089:InvalidApprovalWindow", "6090:InvalidPreCliffBps", "6091:VestingNotActive", "6092:VestingNotCancelled",
  "6093:VestingNotCancellable", "6094:VestingRecoveryDisabled", "6095:VestingWrongDeliveryMode",
  "6096:VestingNotApprovalMode", "6097:InvalidTrancheIndex", "6098:VestingAlreadyStarted",
  "6099:InvalidVestingAllocation", "6100:VestingNothingToClaim", "6101:VestingNothingToWithdraw",
  "6102:VestingAllocationMismatch", "6103:ImmutableOwnerRequired", "6104:AccountMigrationRequired",
  "6105:VestingNotDraft", "6106:VestingStartReached", "6107:VaultVoteAlreadyOpen", "6108:InvalidVaultVoteRound",
  "6109:AssetHasNoShareClasses", "6110:IssuerRegistrationNotRecoverable", "6111:InvalidIssuerPermissions",
  "6112:InvalidProposedAuthority", "6113:InvalidAuthorityTransfer", "6114:CannotRevokePlatformAdmin",
  "6115:UnsupportedMintExtension", "6116:InvalidDistributionPlan", "6117:VestingFundingExceedsSchedule",
  "6118:InvalidPauseFlags", "6119:PauseClearNotAllowed", "6120:InvalidProtocolTreasury", "6121:InvalidSalePrice",
  "6122:SaleApprovalExpired", "6123:SaleApprovalMismatch", "6124:SalePriceOutsideApproval",
  "6125:SaleExceedsApprovedRaise", "6126:InvalidSaleApproval", "6127:SaleIdAlreadyUsed",
  "6128:TreasuryMintRequiresAdmin", "6129:SaleVestingOutsideApproval", "6130:SaleStartsAfterApprovalExpiry",
  "6131:IssuerRecoveryTimelockActive", "6132:IssuerRecoveryExpired", "6133:InvalidIssuerRecovery",
  "6134:CustodyKycRegistryRequired", "6135:CustodyKycRegistryNotAllowed", "6136:CustodyKycRegistryMismatch",
  "6137:ClawbackHolderNotBlocked", "6138:HookConfigInvalid", "6139:EscrowNotEmpty", "6140:AccountNotClosable",
  "6141:BeneficiaryNotAllowed", "6142:VaultTypeRetired",
];

// transfer_hook HookError 6000-6016 (17 variants).
const HOOK_ERRORS = [
  "6000:KycRegistryRequired", "6001:InvalidInstruction", "6002:MissingExtraAccount", "6003:SenderBlocked",
  "6004:Unauthorized", "6005:ReceiverNotApproved", "6006:HolderKycExpired", "6007:JurisdictionBlocked",
  "6008:InvalidKycEntry", "6009:InvalidKycRegistry", "6010:MetaListNotInitialized", "6011:ImmutableOwnerRequired",
  "6012:InvalidTokenAccount", "6013:InvalidBlockEntry", "6014:InvalidProposedAuthority",
  "6015:InvalidAuthorityTransfer", "6016:KycRegistryNotAllowed",
];

describe("program error tables (golden)", () => {
  it.each([
    ["asset_registry.json", REGISTRY_ERRORS, 143],
    ["transfer_hook.json", HOOK_ERRORS, 17],
  ] as const)("%s keeps its pinned code:name prefix; new variants may only be appended", (file, pinned, count) => {
    expect(pinned).toHaveLength(count);
    const actual = errors(file);
    expect(actual.slice(0, pinned.length)).toEqual(pinned);
    actual.forEach((entry, i) => expect(entry.startsWith(`${6000 + i}:`)).toBe(true));
  });
});
