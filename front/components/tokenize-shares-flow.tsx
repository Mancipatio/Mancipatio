"use client";

// "Tokenize company shares": one screen, as few inputs as possible (owner
// request 2026-10-03). The issuer types the share of the company and attaches
// the legal document; the price is optional. Name, symbol, asset ID, class
// terms and the asset page text are derived (lib/tokenize-shares.ts) and shown
// in a preview; "Advanced" overrides name and symbol and adds a description
// and a website (nothing private is copied to the public asset page).
//
// Owner decision 2026-10-03: the tokens are bearer instruments — anyone may
// buy, hold and transfer them (the hook's Open mode), and KYC is asked only
// when a token is converted into the company share. No KYC-only step.
//
// Two wallet prompts: one transaction (create_asset + add_share_class +
// initialize_share_class_mint when the key may create the mint; measured and
// simulated before the wallet opens), then one message signature for the
// details. The details are posted once the asset is finalized, which is what
// the profile route checks ownership at. A flow that stops half-way is
// continued from /issuer/assets/tokenize?asset=<pda> (or the "Continue" list)
// instead of creating a second asset.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { isAddress, type Address } from "@solana/kit";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import {
  AssetRegistryInstruction,
  AssetType,
  findAssetPda,
  findIssuerPda,
  type Issuer,
} from "@/lib/generated/asset_registry";
import { loadNetwork } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { ASSET_STATUS_LABEL, fromBytes32 } from "@/lib/format";
import { countryName } from "@/lib/countries";
import { detectNetwork } from "@/lib/network";
import { getIssuerProfile } from "@/lib/issuer-profiles";
import { getMyClient } from "@/lib/clients";
import {
  getPrivateAssetProfile,
  getPrivateAssetProfiles,
  type AssetProfile,
  type NewAssetProfile,
} from "@/lib/asset-profiles";
import { loadIssuerPermission, ISSUER_CAPABILITIES } from "@/lib/issuer-permissions";
import { usePauseFlags } from "@/lib/use-pause-flags";
import { pausedFlowFor, readPauseFlags } from "@/lib/pause-gate";
import { checkApplyEligibility } from "@/lib/launchpad";
import { createSignedRequest, postSignedRequest, type SiwsRequestBody } from "@/lib/siws-client";
import { walletSigner } from "@/lib/wallet-signer";
import { explainSendError } from "@/lib/tx-error";
import { useToast } from "@/lib/toast";
import { WalletRequired } from "@/components/wallet-required";
import { SkeletonCard } from "@/components/skeleton";
import { TokenizeChecklist } from "@/components/tokenize-checklist";
import {
  CLASS_DEFAULTS,
  DEFAULT_GRANULARITY,
  GRANULARITIES,
  MAX_TOKEN_NAME_BYTES,
  OPEN_TOKEN_NOTE,
  baseAssetId,
  buildProfileRow,
  candidateAssetIds,
  canonicalProfileHashInput,
  companyShortName,
  deriveSymbolPrefix,
  deriveTokenCompany,
  displayNameFor,
  draftKey,
  duplicateConfirmationKey,
  formatCents,
  formatE6,
  formatPercent,
  formatTokens,
  granularityById,
  granularityLabel,
  hasTokenizeFields,
  isResumable,
  legalDocProblem,
  legalDocRequired,
  looksLikeTokenizeAsset,
  mintNamePreview,
  mintSymbolPreview,
  namedPercentE4,
  needsDuplicateConfirmation,
  nextTokenizeStep,
  parseDraft,
  parsePrice,
  perTokenPriceE6,
  resolveCompany,
  resolveJurisdiction,
  resumePrefill,
  shareFigures,
  summaryText,
  tokenNameFor,
  tokenizeCreateBlocker,
  tokenizeFields,
  utf8Bytes,
  validateCompanyOverride,
  validateSymbolOverride,
  validateWebsite,
  type CompanySource,
  type GranularityId,
  type LegalDocSource,
  type ShareFigures,
  type TokenizeDraft,
  type TokenizeFigures,
  type TokenizeIntent,
  type TokenizeStep,
} from "@/lib/tokenize-shares";
import {
  assertTokenizeFits,
  assetSnapshot,
  buildTokenizeIxs,
  classSnapshot,
  issuerKybVerified,
  pickTokenizeAssetId,
  readTokenizeState,
  simulateTokenize,
  waitForFinalizedAsset,
  type ExistingTokenizeAsset,
  type TokenizeChainState,
} from "@/lib/tokenize-shares-chain";

const inputClass =
  "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none";
const labelClass = "text-xs font-medium uppercase tracking-wide text-slate-500";
const PROFILE_ROUTE = "/api/profiles/upsert";

type IssuerContext = {
  issuer: Issuer;
  issuerPda: Address;
  legalId: string;
  company: { name: string; source: CompanySource };
  jurisdiction: string | null;
  canInitMint: boolean;
  /** Unfinished tokens of this issuer (for "Continue"). */
  unfinished: { assetPda: Address; name: string; step: TokenizeStep }[];
};

/** Shown when the issuer already has a token under the base asset ID (nothing is signed until confirmed). */
type DuplicatePrompt = {
  /** duplicateConfirmationKey: the confirmation holds only for this ID, name, symbol and cap. */
  key: string;
  assetId: string;
  intent: TokenizeIntent;
  skipped: ExistingTokenizeAsset[];
};

type ResumeState = {
  assetPda: Address;
  chain: TokenizeChainState;
  profile: AssetProfile | null;
  draft: TokenizeDraft | null;
  /** What the form starts with (until the person edits a field). */
  prefill: ReturnType<typeof resumePrefill>;
};

// ── Browser draft (best effort: private windows may refuse storage) ────────

function readDraft(assetPda: string): TokenizeDraft | null {
  try {
    return parseDraft(window.localStorage.getItem(draftKey(detectNetwork(), assetPda)));
  } catch {
    return null;
  }
}

function writeDraft(assetPda: string, draft: TokenizeDraft) {
  try {
    window.localStorage.setItem(draftKey(detectNetwork(), assetPda), JSON.stringify(draft));
  } catch {
    /* storage blocked: the chain still decides what is next */
  }
}

function removeDraft(assetPda: string) {
  try {
    window.localStorage.removeItem(draftKey(detectNetwork(), assetPda));
  } catch {
    /* ignore */
  }
}

async function sha256(bytes: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const buf =
    bytes instanceof Uint8Array
      ? (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
      : bytes;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

function toHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function TokenizeSharesFlow({ resumeAssetPda }: { resumeAssetPda: string | null }) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const router = useRouter();
  const flags = usePauseFlags();
  const wallet = conn.wallet?.account.address;
  const network = detectNetwork();

  const [ctx, setCtx] = useState<IssuerContext | null>(null);
  const [notIssuer, setNotIssuer] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resume, setResume] = useState<ResumeState | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Form. null = untouched: a resumed token shows its prefill instead.
  const [percentEdit, setPercentInput] = useState<string | null>(null);
  const [granularityEdit, setGranularityId] = useState<GranularityId | null>(null);
  const [showGranularity, setShowGranularity] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [priceEdit, setPriceInput] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Advanced edits only the company part of the name; the "<pct>%" after it
  // is always generated from the share, so the name and the cap agree.
  const [companyOverride, setCompanyOverride] = useState<string | null>(null);
  const [symbolOverride, setSymbolOverride] = useState<string | null>(null);
  const [descriptionEdit, setDescription] = useState<string | null>(null);
  const [websiteEdit, setWebsite] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicatePrompt | null>(null);
  const prefill = resume?.prefill;
  const resumeSc0 = resume?.chain.sc0 ?? null;
  const fixedTokens =
    resumeSc0 && resumeSc0.maxSupply.__option === "Some" ? resumeSc0.maxSupply.value : null;
  const percentInput = percentEdit ?? prefill?.percent ?? "";
  // A resumed class whose token size nothing recorded gets no default: the
  // issuer picks it, so a guess never reaches the asset page.
  const granularityId: GranularityId | null =
    granularityEdit ?? prefill?.granularity ?? (resumeAssetPda && fixedTokens !== null ? null : DEFAULT_GRANULARITY);
  const priceInput = priceEdit ?? prefill?.price ?? "";
  const description = descriptionEdit ?? prefill?.description ?? "";
  // Only what the issuer types here reaches the public asset page: the
  // issuer profile's website is private and never copied.
  const website = websiteEdit ?? prefill?.website ?? "";

  // ── Load the issuer, its company data, permission and unfinished tokens ──
  const loadContext = useCallback(async () => {
    if (!wallet || !conn.wallet) return;
    const session = conn.wallet;
    const rpc = client.runtime.rpc;
    try {
      const net = await loadNetworkPreferIndexer(() => loadNetwork(rpc));
      const issuer = net.issuers.find((i) => i.authority.toString() === wallet.toString());
      if (!issuer) {
        setNotIssuer(true);
        return;
      }
      const [issuerPda] = await findIssuerPda({ legalEntityId: issuer.legalEntityId });
      const legalId = fromBytes32(issuer.legalEntityId);
      // The company name compliance reviewed (the client record of an
      // approved KYB) comes first; the issuer-editable profile name after it.
      let profileName: string | null = null;
      try {
        const p = await getIssuerProfile(session, issuerPda);
        profileName = p?.company_name ?? null;
      } catch {
        /* fall back to the client record or the legal ID */
      }
      let clientName: string | null = null;
      let clientJurisdiction: string | null = null;
      try {
        const c = await getMyClient(session);
        clientName = c?.company_name ?? null;
        clientJurisdiction = c?.jurisdiction ?? null;
      } catch {
        /* optional */
      }
      let clientKybVerified = false;
      if (clientName?.trim()) {
        const eligibility = await checkApplyEligibility(wallet.toString());
        clientKybVerified = eligibility?.kybStatus === "verified";
      }
      let canInitMint = false;
      try {
        const permission = await loadIssuerPermission(rpc, issuerPda, wallet);
        canInitMint = (permission.capabilities & ISSUER_CAPABILITIES.Mint) !== 0;
      } catch {
        canInitMint = false;
      }

      // Unfinished tokens: Equity assets this flow made (its name pattern or
      // a draft in this browser) with a resumable next step.
      const unfinished: IssuerContext["unfinished"] = [];
      const mine = net.assets.filter(
        (a) => a.issuer.toString() === issuerPda.toString() && a.assetType === AssetType.Equity,
      );
      const rows = await Promise.all(
        mine.map(async (a) => ({ asset: a, pda: (await findAssetPda({ issuer: a.issuer, assetId: a.assetId }))[0] })),
      );
      const candidates = rows.filter((r) => looksLikeTokenizeAsset(r.asset) || readDraft(r.pda) !== null);
      if (candidates.length > 0) {
        // Unreadable profiles: offer only the chain steps, never a "save details" guess.
        let profiles: Map<string, AssetProfile> | null = null;
        try {
          profiles = await getPrivateAssetProfiles(session, candidates.map((r) => r.pda));
        } catch {
          profiles = null;
        }
        for (const r of candidates) {
          const sc0 = net.shareClasses.find((sc) => sc.asset.toString() === r.pda.toString() && sc.classIndex === 0);
          const step = nextTokenizeStep({
            asset: assetSnapshot(r.asset),
            sc0: sc0 ? classSnapshot(sc0) : null,
            profileSaved: profiles === null || hasTokenizeFields(profiles.get(r.pda.toString())),
            canInitMint,
            intent: null,
          });
          if (isResumable(step)) unfinished.push({ assetPda: r.pda, name: r.asset.name, step });
        }
      }

      setCtx({
        issuer,
        issuerPda,
        legalId,
        company: resolveCompany({ profileName, clientName, clientKybVerified, legalId }),
        jurisdiction: resolveJurisdiction(issuer.jurisdiction, clientJurisdiction),
        canInitMint,
        unfinished,
      });
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, [wallet, conn.wallet, client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadContext();
  }, [loadContext]);

  // ── Resume: one asset, read from chain ──
  const loadResume = useCallback(async () => {
    if (!resumeAssetPda || !conn.wallet) return;
    if (!isAddress(resumeAssetPda)) {
      setResumeError("This link does not name an asset.");
      return;
    }
    try {
      const assetPda = resumeAssetPda as Address;
      const chain = await readTokenizeState(client.runtime.rpc, assetPda);
      const profile = await getPrivateAssetProfile(conn.wallet, assetPda);
      const draft = readDraft(assetPda);
      const prefill = resumePrefill({
        assetName: chain.asset?.name ?? null,
        cap: chain.sc0?.maxSupply.__option === "Some" ? chain.sc0.maxSupply.value : null,
        tokenize: profile && hasTokenizeFields(profile) ? (profile.fields.tokenize as Record<string, unknown>) : null,
        draft,
      });
      setResume({ assetPda, chain, profile, draft, prefill });
      setResumeError(null);
    } catch (err) {
      setResumeError(errorText(err));
    }
  }, [resumeAssetPda, conn.wallet, client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadResume();
  }, [loadResume]);

  // ── Derived values ──
  const granularity = granularityId ? (granularityById(granularityId) ?? null) : null;
  const resumeAsset = resume?.chain.asset ?? null;

  // The share a resumed token's on-chain name states ("Mancipatio 5%" is 5 %).
  const namedP4 = useMemo(() => (resumeAsset ? namedPercentE4(resumeAsset.name) : null), [resumeAsset]);

  const figures = useMemo(
    (): ShareFigures => shareFigures({ cap: fixedTokens, namedP4, granularity, percentInput }),
    [fixedTokens, granularity, percentInput, namedP4],
  );

  const price = useMemo(() => parsePrice(priceInput), [priceInput]);
  const shortName = ctx ? companyShortName(ctx.company.name) : "";
  const autoCompany = ctx && figures.ok ? deriveTokenCompany(shortName, figures.p4) : "";
  const companyPart = companyOverride ?? autoCompany;
  const tokenName = resumeAsset ? resumeAsset.name : figures.ok ? tokenNameFor(companyPart, figures.p4) : "";
  const autoSymbol = ctx ? deriveSymbolPrefix(shortName, ctx.legalId) : "";
  const symbolPrefix = resumeAsset ? resumeAsset.symbolPrefix : (symbolOverride ?? autoSymbol);
  const nameError =
    !resumeAsset && companyOverride !== null && figures.ok ? validateCompanyOverride(companyOverride, figures.p4) : null;
  const symbolError = !resumeAsset && symbolOverride !== null ? validateSymbolOverride(symbolOverride) : null;
  const websiteError = validateWebsite(website);
  const docProblem = legalDocProblem(file ? { name: file.name, type: file.type, size: file.size } : null, network);
  const onboardingPaused = pausedFlowFor(flags, AssetRegistryInstruction.CreateAsset);
  const verified = ctx?.issuer.kybStatus === 1;
  const country = ctx?.jurisdiction ? countryName(ctx.jurisdiction) : null;
  const pctLabel = figures.ok ? formatPercent(figures.p4) : fixedTokens !== null ? "…" : percentInput.trim() || "…";
  const assetIdPreview = figures.ok && !symbolError ? baseAssetId(symbolPrefix, figures.p4) : "—";

  function figuresFor(p4: bigint, tokens: bigint, g: GranularityId): TokenizeFigures {
    return { p4, granularity: g, tokens, priceCents: price.ok ? price.value : null };
  }

  /** Signs the details (one prompt), waits for finality, then posts them. */
  async function saveDetails(assetPda: Address, row: NewAssetProfile, prompt: string): Promise<boolean> {
    if (!conn.wallet) return false;
    setWorking(`Confirm in your wallet (${prompt}): save the token's details`);
    let envelope: SiwsRequestBody;
    try {
      envelope = await createSignedRequest(conn.wallet, "profiles.upsert", { profile: row });
    } catch (err) {
      toast.showError(
        "Details not saved",
        `${errorText(err)} The token exists; save its details from this page (1 signature).`,
      );
      return false;
    }
    setWorking("Waiting for the network to finalize the token (usually under a minute)…");
    const finalized = await waitForFinalizedAsset(client.runtime.rpc, assetPda);
    if (!finalized) {
      toast.showError(
        "Details not saved yet",
        "The token is not final on the network yet. Save the details again in a minute (1 signature).",
      );
      return false;
    }
    setWorking("Saving the details…");
    try {
      await postSignedRequest(PROFILE_ROUTE, envelope);
      removeDraft(assetPda);
      toast.show({ kind: "success", title: "Details saved" });
      return true;
    } catch (err) {
      toast.showError("Details not saved", `${errorText(err)} Save them again from this page (1 signature).`);
      return false;
    }
  }

  // ── New token ──
  /** `confirmedKey`: the issuer confirmed another token next to an existing one (DuplicatePrompt). */
  async function create(confirmedKey?: string) {
    if (!ctx || !conn.wallet || !wallet || !figures.ok || !price.ok || !granularity) return;
    const rpc = client.runtime.rpc;
    const session = conn.wallet;
    setWorking("Checking the chain…");
    try {
      // Re-checked here, not only through the disabled button: the KYB, the
      // onboarding pause (0x01) and the mainnet legal document, read fresh.
      const [kybVerified, flagsNow] = await Promise.all([
        issuerKybVerified(rpc, ctx.issuerPda),
        readPauseFlags(rpc),
      ]);
      const blocker = tokenizeCreateBlocker({
        network,
        file: file ? { name: file.name, type: file.type, size: file.size } : null,
        kybVerified,
        onboardingPaused: pausedFlowFor(flagsNow, AssetRegistryInstruction.CreateAsset),
      });
      if (blocker) throw new Error(blocker);
      if (websiteError) throw new Error(`Website: ${websiteError}`);
      const signer = walletSigner(session);
      const permission = await loadIssuerPermission(rpc, ctx.issuerPda, wallet);
      const canInitMint = (permission.capabilities & ISSUER_CAPABILITIES.Mint) !== 0;
      const intent: TokenizeIntent = { name: tokenName.trim(), symbolPrefix, tokens: figures.tokens };
      // The name becomes the mint name and cannot change once the asset is
      // active: it must state the share the cap is computed from.
      if (namedPercentE4(intent.name) !== figures.p4) {
        throw new Error(`The token name must end with ${formatPercent(figures.p4)}%, the share you entered.`);
      }
      const picked = await pickTokenizeAssetId(rpc, {
        issuer: ctx.issuerPda,
        candidates: candidateAssetIds(baseAssetId(symbolPrefix, figures.p4)),
        intent,
        canInitMint,
        profileSaved: async (pda) => hasTokenizeFields(await getPrivateAssetProfile(session, pda)),
      });
      if (!picked) {
        throw new Error("Every asset ID for this share is already taken. Change the symbol under Advanced.");
      }
      // Another token for the same share: asset accounts cannot be closed, so
      // stop before the wallet opens and show what exists (DuplicatePrompt).
      const key = duplicateConfirmationKey(picked.assetId, intent);
      if (needsDuplicateConfirmation(picked) && confirmedKey !== key) {
        setDuplicate({ key, assetId: picked.assetId, intent, skipped: picked.skipped });
        return;
      }
      setDuplicate(null);
      if (picked.step.kind !== "create") {
        toast.show({
          kind: "info",
          title: "You already started this token",
          description: "Continuing where it stopped instead of creating a second one.",
        });
        router.replace(`/issuer/assets/tokenize?asset=${picked.assetPda}`);
        return;
      }

      const figs = figuresFor(figures.p4, figures.tokens, granularity.id);
      let legalDocHash: Uint8Array;
      let legalDocSource: LegalDocSource;
      if (file) {
        legalDocHash = await sha256(await file.arrayBuffer());
        legalDocSource = "file";
      } else {
        // Off mainnet only (legalDocProblem refuses a missing file on mainnet).
        legalDocSource = "canonical";
        legalDocHash = await sha256(
          new TextEncoder().encode(
            canonicalProfileHashInput({
              assetId: picked.assetId,
              name: intent.name,
              symbolPrefix,
              displayName: displayNameFor(ctx.company.name, figs.p4),
              summary: summaryText({ companyName: ctx.company.name, jurisdiction: ctx.jurisdiction, p4: figs.p4, tokens: figs.tokens }),
              description: description.trim(),
              website: website.trim(),
              jurisdiction: ctx.jurisdiction,
              fields: tokenizeFields({ figures: figs, companyName: ctx.company.name, companySource: ctx.company.source, legalDocSource }),
            }),
          ),
        );
      }
      const row = buildProfileRow({
        assetPda: picked.assetPda,
        issuerPda: ctx.issuerPda,
        companyName: ctx.company.name,
        companySource: ctx.company.source,
        jurisdiction: ctx.jurisdiction,
        website: website.trim() || null,
        description: description.trim() || null,
        figures: figs,
        legalDocHex: toHex(legalDocHash),
        legalDocSource,
        existing: null,
      });
      const ixs = await buildTokenizeIxs({
        kind: "create",
        initMint: canInitMint,
        signer,
        issuer: ctx.issuerPda,
        assetId: picked.assetId,
        name: intent.name,
        symbolPrefix,
        legalDocHash,
        tokens: figures.tokens,
        adminRecord: canInitMint ? permission.proof : null,
      });
      assertTokenizeFits(signer.address, ixs);
      setWorking("Dry run on the network…");
      await simulateTokenize(rpc, signer.address, ixs);

      writeDraft(picked.assetPda, {
        v: 1,
        percent: formatPercent(figures.p4),
        granularity: granularity.id,
        price: priceInput.trim(),
        description: description.trim(),
        website: website.trim(),
        legalDocSource,
        savedAt: new Date().toISOString(),
      });
      setWorking("Confirm in your wallet (1 of 2): create the token");
      const sig = await tx.send({ instructions: ixs, feePayer: signer });
      toast.showTx(sig, { title: "Token created" });
      await saveDetails(picked.assetPda, row, "2 of 2");
      router.replace(`/issuer/assets/tokenize?asset=${picked.assetPda}`);
    } catch (err) {
      toast.showError("Token not created", explainSendError(err));
      console.error("[tokenize]", err);
    } finally {
      setWorking(null);
    }
  }

  // ── Continue an unfinished token ──
  const resumeStep: TokenizeStep | null = useMemo(() => {
    if (!resume || !ctx) return null;
    if (!resume.chain.asset) return { kind: "conflict", reason: "No asset exists at this address on this network." };
    return nextTokenizeStep({
      asset: assetSnapshot(resume.chain.asset),
      sc0: resume.chain.sc0 ? classSnapshot(resume.chain.sc0) : null,
      profileSaved: hasTokenizeFields(resume.profile),
      canInitMint: ctx.canInitMint,
      intent: null,
    });
  }, [resume, ctx]);

  async function continueResume() {
    if (!ctx || !resume || !resume.chain.asset || !resumeStep || !conn.wallet || !wallet) return;
    const profileMissing = !hasTokenizeFields(resume.profile);
    // The price is asked (and needed) only while the figures are missing.
    if (!figures.ok || !granularity || (profileMissing && !price.ok)) return;
    const rpc = client.runtime.rpc;
    const asset = resume.chain.asset;
    const chainStep = resumeStep.kind === "add_class" || resumeStep.kind === "init_mint";
    const total = (chainStep ? 1 : 0) + (profileMissing ? 1 : 0);
    setWorking("Checking the chain…");
    try {
      const figs = figuresFor(figures.p4, figures.tokens, granularity.id);
      const legalDocSource: LegalDocSource = resume.draft?.legalDocSource ?? "chain";
      // An existing profile is completed, never overwritten (buildProfileRow);
      // the equity columns follow class 0 as it is on chain.
      const row = buildProfileRow({
        assetPda: resume.assetPda,
        issuerPda: ctx.issuerPda,
        companyName: ctx.company.name,
        companySource: ctx.company.source,
        jurisdiction: ctx.jurisdiction,
        // From this browser's draft (Advanced → Website, checked before the token was created).
        website: websiteError ? null : website.trim() || null,
        description: description.trim() || null,
        figures: figs,
        legalDocHex: toHex(asset.legalDocHash),
        legalDocSource,
        classTerms: resume.chain.sc0 ?? CLASS_DEFAULTS,
        existing: resume.profile,
      });
      if (chainStep) {
        const signer = walletSigner(conn.wallet);
        const permission = await loadIssuerPermission(rpc, ctx.issuerPda, wallet);
        const canInitMint = (permission.capabilities & ISSUER_CAPABILITIES.Mint) !== 0;
        if (resumeStep.kind === "init_mint" && !canInitMint) {
          throw new Error("This issuer key has no Mint permission yet; the Super Admin grants it.");
        }
        const ixs = await buildTokenizeIxs({
          kind: resumeStep.kind,
          initMint: canInitMint,
          signer,
          issuer: ctx.issuerPda,
          assetId: asset.assetId,
          name: asset.name,
          symbolPrefix: asset.symbolPrefix,
          legalDocHash: Uint8Array.from(asset.legalDocHash),
          tokens: figures.tokens,
          adminRecord: canInitMint ? permission.proof : null,
        });
        assertTokenizeFits(signer.address, ixs);
        setWorking("Dry run on the network…");
        await simulateTokenize(rpc, signer.address, ixs);
        writeDraft(resume.assetPda, {
          v: 1,
          percent: formatPercent(figures.p4),
          granularity: granularity.id,
          price: priceInput.trim(),
          description: description.trim(),
          website: website.trim(),
          legalDocSource,
          savedAt: new Date().toISOString(),
        });
        setWorking(`Confirm in your wallet (1 of ${total}): ${resumeStep.kind === "add_class" ? "add the share class" : "create the token mint"}`);
        const sig = await tx.send({ instructions: ixs, feePayer: signer });
        toast.showTx(sig, { title: resumeStep.kind === "add_class" ? "Share class added" : "Token mint created" });
      }
      if (profileMissing) await saveDetails(resume.assetPda, row, `${total} of ${total}`);
      setRefreshKey((k) => k + 1);
      await loadResume();
      await loadContext();
    } catch (err) {
      toast.showError("Not finished", explainSendError(err));
      console.error("[tokenize:resume]", err);
    } finally {
      setWorking(null);
    }
  }

  // ── Render ──
  if (!wallet) return <WalletRequired context="Connect your issuer wallet to tokenize your company's shares." />;
  if (notIssuer) {
    return (
      <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-6">
        <p className="text-sm font-semibold text-amber-900">This wallet is not an issuer yet</p>
        <Link
          href="/issuer/onboarding"
          className="mt-3 inline-block rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-950"
        >
          Start onboarding →
        </Link>
      </div>
    );
  }
  if (loadError) {
    return (
      <div role="alert" className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
        <p>{loadError}</p>
        <button type="button" onClick={() => void loadContext()} className="mt-2 font-medium underline">
          Try again
        </button>
      </div>
    );
  }
  if (!ctx || (resumeAssetPda && !resume && !resumeError)) return <SkeletonCard className="mt-6" rows={6} />;

  const header = (
    <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Issuer</p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">Tokenize company shares</h1>
      </div>
      <div className="text-right">
        <p className="text-sm font-medium text-slate-900">
          {ctx.company.name}{" "}
          {verified ? (
            <span className="ml-1 inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
              ✓ KYB
            </span>
          ) : (
            <span className="ml-1 inline-flex rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
              KYB pending
            </span>
          )}
        </p>
        {ctx.company.source === "legal_id" && (
          <p className="mt-0.5 text-[11px] text-slate-500">
            Using your legal ID — add the company name on{" "}
            <Link href="/issuer" className="underline">Issuer → Company profile</Link>.
          </p>
        )}
      </div>
    </div>
  );

  if (resumeAssetPda) {
    return (
      <>
        {header}
        {resumeError ? (
          <div role="alert" className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
            <p>{resumeError}</p>
            <button type="button" onClick={() => void loadResume()} className="mt-2 font-medium underline">
              Try again
            </button>
          </div>
        ) : resume && resume.chain.asset && resume.chain.asset.issuer.toString() !== ctx.issuerPda.toString() ? (
          <p className="mt-6 text-sm text-slate-600">This asset belongs to another issuer.</p>
        ) : resume && resumeStep ? (
          <ResumeView
            resume={resume}
            step={resumeStep}
            working={working}
            busy={working !== null || tx.isSending}
            figuresError={figures.ok ? null : figures.error}
            figuresWarning={figures.warning}
            priceError={price.ok ? null : price.error}
            tokens={figures.ok ? figures.tokens : null}
            pctLabel={pctLabel}
            fixedTokens={fixedTokens}
            percentInput={percentInput}
            setPercentInput={setPercentInput}
            granularityId={granularityId}
            setGranularityId={setGranularityId}
            priceInput={priceInput}
            setPriceInput={setPriceInput}
            onContinue={() => void continueResume()}
            refreshKey={refreshKey}
            issuerAuthority={ctx.issuer.authority.toString()}
          />
        ) : null}
      </>
    );
  }

  const problems = [
    !verified ? "Your company's KYB must be verified first." : null,
    onboardingPaused,
    figures.ok ? null : percentInput.trim() ? figures.error : "Enter the share of the company.",
    docProblem,
    price.ok ? null : price.error,
    nameError ? `Name: ${nameError}` : null,
    symbolError ? `Symbol: ${symbolError}` : null,
    websiteError ? `Website: ${websiteError}` : null,
  ].filter((p): p is string => !!p);
  const canSubmit = problems.length === 0 && working === null && !tx.isSending;
  // The duplicate prompt holds only while the name, symbol and cap it was raised for are unchanged.
  const duplicateShown =
    duplicate !== null &&
    figures.ok &&
    duplicate.intent.name === tokenName.trim() &&
    duplicate.intent.symbolPrefix === symbolPrefix &&
    duplicate.intent.tokens === figures.tokens
      ? duplicate
      : null;
  const perToken = figures.ok && price.ok && price.value !== null ? formatE6(perTokenPriceE6(price.value, figures.tokens)) : null;

  return (
    <>
      {header}

      {ctx.unfinished.length > 0 && (
        <div className="mt-6 rounded-xl border border-brand-200 bg-brand-50 p-4 text-sm text-brand-900">
          <p className="font-medium">You have an unfinished token</p>
          <ul className="mt-2 space-y-1">
            {ctx.unfinished.map((u) => (
              <li key={u.assetPda.toString()} className="flex flex-wrap items-center gap-2">
                <span>{u.name}</span>
                <Link
                  href={`/issuer/assets/tokenize?asset=${u.assetPda}`}
                  className="rounded-md bg-brand-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-800"
                >
                  Continue →
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12px] text-brand-800">Or start a new one below.</p>
        </div>
      )}

      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
        <div className="space-y-5">
          {/* Share of the company */}
          <div className="grid items-center gap-2 sm:grid-cols-[12rem_1fr]">
            <label htmlFor="tokenize-percent" className={labelClass}>
              Share of the company
            </label>
            <div className="flex items-center gap-2">
              <input
                id="tokenize-percent"
                value={percentInput}
                inputMode="decimal"
                autoFocus
                placeholder="5"
                onChange={(e) => setPercentInput(e.target.value)}
                className={`${inputClass} max-w-[8rem] text-right font-mono`}
              />
              <span className="text-sm text-slate-600">%</span>
            </div>
          </div>

          {/* Tokens */}
          <div className="grid items-start gap-2 sm:grid-cols-[12rem_1fr]">
            <span className={labelClass}>Tokens</span>
            <div>
              <p className="text-sm text-slate-900">
                <span className="font-mono font-semibold">{figures.ok ? formatTokens(figures.tokens) : "—"}</span>{" "}
                <span className="text-slate-500">({granularityLabel(granularityId ?? DEFAULT_GRANULARITY)})</span>{" "}
                <button
                  type="button"
                  onClick={() => setShowGranularity((v) => !v)}
                  className="text-xs font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900"
                >
                  change
                </button>
              </p>
              {showGranularity && (
                <GranularityPicker value={granularityId} onChange={setGranularityId} />
              )}
              {!figures.ok && percentInput.trim() && (
                <p className="mt-1 text-[12px] text-red-700">{figures.error}</p>
              )}
            </div>
          </div>

          {/* Legal document */}
          <div className="grid items-start gap-2 sm:grid-cols-[12rem_1fr]">
            <span className={labelClass}>Legal document</span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="cursor-pointer rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-slate-400">
                  {file ? "Change PDF" : "Choose PDF"}
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    className="sr-only"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                </label>
                <span className="text-xs text-slate-500">
                  {file ? file.name : legalDocRequired(network) ? "required" : "optional on this network"}
                </span>
              </div>
              {file && docProblem && <p className="mt-1 text-[12px] text-red-700">{docProblem}</p>}
              <p className="mt-1 text-[11px] text-slate-400">
                Its SHA-256 fingerprint is written on chain; the file itself stays with you.
              </p>
            </div>
          </div>

          {/* Price */}
          <div className="grid items-center gap-2 sm:grid-cols-[12rem_1fr]">
            <label htmlFor="tokenize-price" className={labelClass}>
              Price for {pctLabel} % <span className="normal-case tracking-normal text-slate-400">(optional, USD)</span>
            </label>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-500">$</span>
                <input
                  id="tokenize-price"
                  value={priceInput}
                  inputMode="decimal"
                  placeholder="—"
                  onChange={(e) => setPriceInput(e.target.value)}
                  className={`${inputClass} max-w-[12rem] text-right font-mono`}
                />
              </div>
              {!price.ok && <p className="mt-1 text-[12px] text-red-700">{price.error}</p>}
              <p className="mt-1 text-[11px] text-slate-400">
                Kept private with the token&apos;s figures; the public price is set by the sale.
              </p>
            </div>
          </div>

          {/* Preview */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Preview</p>
            {figures.ok ? (
              <>
                <p className="mt-2 text-base font-semibold text-slate-900">
                  {tokenName || "—"} <span className="font-normal text-slate-400">·</span>{" "}
                  <span className="font-mono">{mintSymbolPreview(symbolPrefix)}</span>
                </p>
                <ul className="mt-1 space-y-0.5 text-sm text-slate-700">
                  <li>
                    {formatTokens(figures.tokens)} tokens = {formatPercent(figures.p4)} % of {ctx.company.name}
                    {country && country !== "—" ? ` (${country})` : ""}
                  </li>
                  <li>{OPEN_TOKEN_NOTE}</li>
                  <li>Supply capped at {formatTokens(figures.tokens)} — locked for good after minting</li>
                  {price.ok && price.value !== null && (
                    <li>
                      Price ${formatCents(price.value)} for the {formatPercent(figures.p4)} % · ${perToken} per token
                      (private)
                    </li>
                  )}
                </ul>
                <p className="mt-2 text-[11px] text-slate-500">
                  On chain: “{mintNamePreview(tokenName)}” · asset ID{" "}
                  <span className="font-mono">{assetIdPreview}</span> (if you already have a token under it, you are
                  asked before anything is signed)
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm text-slate-500">Enter the share of the company to see the token.</p>
            )}
          </div>

          {/* Advanced */}
          <div>
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              {advancedOpen ? "▾" : "▸"} Advanced (name, symbol, description, website)
            </button>
            {advancedOpen && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className={labelClass}>Name</span>
                  <span className="mt-1 flex items-center gap-2">
                    <input
                      value={companyPart}
                      onChange={(e) => setCompanyOverride(e.target.value)}
                      className={inputClass}
                    />
                    {/* The share is never typed here: it always matches the cap. */}
                    <span className="shrink-0 font-mono text-sm text-slate-600">{figures.ok ? `${formatPercent(figures.p4)}%` : "…%"}</span>
                  </span>
                  <span className={`mt-1 block text-[11px] ${nameError ? "text-red-700" : "text-slate-400"}`}>
                    {nameError ??
                      (figures.ok
                        ? `${utf8Bytes(tokenName)} / ${MAX_TOKEN_NAME_BYTES} bytes (š, ć, đ… count as 2) · the share is added for you`
                        : "The share is added after the name.")}
                  </span>
                </label>
                <label className="block">
                  <span className={labelClass}>Symbol</span>
                  <input
                    value={symbolOverride ?? autoSymbol}
                    onChange={(e) => setSymbolOverride(e.target.value.toUpperCase().replace(/\s/g, ""))}
                    className={`${inputClass} mt-1 font-mono`}
                  />
                  <span className={`mt-1 block text-[11px] ${symbolError ? "text-red-700" : "text-slate-400"}`}>
                    {symbolError ?? `Token symbol ${mintSymbolPreview(symbolOverride ?? autoSymbol)} · A–Z and 0–9, up to 9`}
                  </span>
                </label>
                <label className="block sm:col-span-2">
                  <span className={labelClass}>Description</span>
                  <textarea
                    value={description}
                    rows={3}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Shown on the asset page (optional)"
                    className={`${inputClass} mt-1`}
                  />
                </label>
                <label className="block sm:col-span-2">
                  <span className={labelClass}>Website</span>
                  <input
                    value={website}
                    type="url"
                    inputMode="url"
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="https://… (optional, shown on the asset page)"
                    className={`${inputClass} mt-1`}
                  />
                  {websiteError && <span className="mt-1 block text-[11px] text-red-700">{websiteError}</span>}
                </label>
                {(companyOverride !== null || symbolOverride !== null) && (
                  <button
                    type="button"
                    onClick={() => {
                      setCompanyOverride(null);
                      setSymbolOverride(null);
                    }}
                    className="justify-self-start text-xs text-slate-500 underline hover:text-slate-800"
                  >
                    Use the automatic name and symbol
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Submit */}
          <div className="border-t border-slate-100 pt-4">
            {duplicateShown && figures.ok && (
              <DuplicateTokenPrompt
                prompt={duplicateShown}
                pct={formatPercent(figures.p4)}
                symbol={mintSymbolPreview(symbolPrefix)}
                disabled={!canSubmit}
                onConfirm={() => void create(duplicateShown.key)}
                onCancel={() => setDuplicate(null)}
              />
            )}
            <div className="flex flex-wrap items-center justify-end gap-3">
              {working && <p className="text-sm text-slate-600" aria-live="polite">{working}</p>}
              <button
                type="button"
                disabled={!canSubmit}
                onClick={() => void create()}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                Create token — 2 wallet signatures
              </button>
            </div>
            {problems.length > 0 && (percentInput.trim() || !verified || onboardingPaused) && (
              <p className="mt-2 text-right text-[12px] text-amber-700">{problems[0]}</p>
            )}
            <p className="mt-2 text-right text-[12px] text-slate-500">
              Next: the operator activates the asset → then the tokens are minted.
            </p>
            {!ctx.canInitMint && (
              <p className="mt-1 text-right text-[11px] text-slate-400">
                Your issuer key has no Mint permission yet, so the token mint is created after the Super Admin
                grants it (one more signature).
              </p>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

function GranularityPicker({
  value,
  onChange,
}: {
  /** null: not chosen yet (a resumed token whose size nothing recorded). */
  value: GranularityId | null;
  onChange: (id: GranularityId) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Token size">
      {GRANULARITIES.map((g) => (
        <label
          key={g.id}
          className={`cursor-pointer rounded-md border px-2.5 py-1 text-xs ${
            value === g.id ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 text-slate-700 hover:border-slate-400"
          }`}
        >
          <input
            type="radio"
            name="tokenize-granularity"
            className="sr-only"
            checked={value === g.id}
            onChange={() => onChange(g.id)}
          />
          {granularityLabel(g.id)}
        </label>
      ))}
    </div>
  );
}

/** What already exists under an earlier asset ID, in words. */
function existingNote(step: TokenizeStep): string {
  if (step.kind === "done") return "already created";
  if (step.kind === "conflict" || step.kind === "blocked") return step.reason;
  return "unfinished";
}

/**
 * The issuer already has a token under the base asset ID (finished, other
 * terms or blocked). Nothing opens in the wallet until they confirm another
 * one under the ID shown — asset accounts cannot be closed.
 */
function DuplicateTokenPrompt(props: {
  prompt: DuplicatePrompt;
  pct: string;
  symbol: string;
  disabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { prompt } = props;
  const sameNameAndSymbol = prompt.skipped.some(
    (s) => s.name === prompt.intent.name && s.symbolPrefix === prompt.intent.symbolPrefix,
  );
  return (
    <div role="alert" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-medium">You already have a token for this share</p>
      <ul className="mt-2 space-y-1">
        {prompt.skipped.map((s) => (
          <li key={s.assetId} className="flex flex-wrap items-baseline gap-x-2">
            <span>
              {s.name} · <span className="font-mono">{s.assetId}</span> · {ASSET_STATUS_LABEL[s.status] ?? "—"}
            </span>
            <span className="text-[12px] text-amber-800">{existingNote(s.step)}</span>
            <Link href={`/issuer/assets/${s.assetPda}`} className="text-[12px] font-medium underline">
              Asset page →
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12px] text-amber-800">
        A new token gets the asset ID <span className="font-mono">{prompt.assetId}</span>
        {sameNameAndSymbol
          ? ` and the same name and symbol (${props.symbol}); to tell them apart, change the symbol under Advanced.`
          : "."}{" "}
        Tokens cannot be deleted.
      </p>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={props.onCancel}
          className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-amber-900 hover:border-amber-400"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={props.disabled}
          onClick={props.onConfirm}
          className="rounded-lg bg-amber-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-950 disabled:opacity-50"
        >
          Create another {props.pct} % token ({prompt.assetId})
        </button>
      </div>
    </div>
  );
}

function ResumeView(props: {
  resume: ResumeState;
  step: TokenizeStep;
  working: string | null;
  busy: boolean;
  figuresError: string | null;
  figuresWarning: string | null;
  priceError: string | null;
  tokens: bigint | null;
  pctLabel: string;
  fixedTokens: bigint | null;
  percentInput: string;
  setPercentInput: (v: string) => void;
  granularityId: GranularityId | null;
  setGranularityId: (v: GranularityId) => void;
  priceInput: string;
  setPriceInput: (v: string) => void;
  onContinue: () => void;
  refreshKey: number;
  issuerAuthority: string;
}) {
  const { resume, step } = props;
  const asset = resume.chain.asset;
  const profileMissing = !hasTokenizeFields(resume.profile);
  const chainStep = step.kind === "add_class" || step.kind === "init_mint";
  const actionable = chainStep || step.kind === "save_profile";
  const total = (chainStep ? 1 : 0) + (profileMissing ? 1 : 0);
  const label =
    step.kind === "add_class"
      ? "Add the share class"
      : step.kind === "init_mint"
        ? "Create the token mint"
        : "Save details";
  // An asset page profile written elsewhere (Product profile form): saving
  // only completes it. The price is private (fields.tokenize), so it is asked
  // whenever the figures are missing.
  const existingProfile = profileMissing && resume.profile !== null;
  const askPrice = profileMissing;
  const blocked = props.figuresError ?? (askPrice ? props.priceError : null);

  if (!asset) {
    return (
      <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        {step.kind === "conflict" || step.kind === "blocked" ? step.reason : "No asset exists at this address."}{" "}
        <Link href="/issuer/assets/tokenize" className="font-medium underline">
          Start a new token
        </Link>
      </p>
    );
  }

  return (
    <>
      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Token</p>
        <p className="mt-1 text-base font-semibold text-slate-900">
          {asset.name} <span className="font-normal text-slate-400">·</span>{" "}
          <span className="font-mono">{mintSymbolPreview(asset.symbolPrefix)}</span>
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          Asset ID <span className="font-mono">{asset.assetId}</span> ·{" "}
          <Link href={`/issuer/assets/${resume.assetPda}`} className="underline">
            Asset page →
          </Link>
        </p>

        {(step.kind === "conflict" || step.kind === "blocked") && (
          <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {step.reason}
          </p>
        )}
        {step.kind === "wait_mint_permission" && (
          <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            The share class is ready. The token mint is created once the Super Admin gives this issuer the
            Mint permission — then come back here (1 wallet signature).
          </p>
        )}

        {actionable && (
          <div className="mt-4 space-y-4">
            {props.fixedTokens === null ? (
              <div className="grid items-center gap-2 sm:grid-cols-[12rem_1fr]">
                <label htmlFor="tokenize-resume-percent" className={labelClass}>
                  Share of the company
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="tokenize-resume-percent"
                    value={props.percentInput}
                    inputMode="decimal"
                    onChange={(e) => props.setPercentInput(e.target.value)}
                    className={`${inputClass} max-w-[8rem] text-right font-mono`}
                  />
                  <span className="text-sm text-slate-600">%</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-700">
                {formatTokens(props.fixedTokens)} tokens = {props.pctLabel} % of the company
              </p>
            )}
            <div>
              <span className={labelClass}>Token size</span>
              <GranularityPicker value={props.granularityId} onChange={props.setGranularityId} />
              {props.tokens !== null && props.fixedTokens === null && (
                <p className="mt-1 text-sm text-slate-700">{formatTokens(props.tokens)} tokens</p>
              )}
            </div>
            {props.figuresWarning && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
                {props.figuresWarning}
              </p>
            )}
            {existingProfile && (
              <p className="text-[12px] text-slate-600">
                This token already has an asset page profile. Saving keeps its text, website and status and only
                fills in what is empty.
              </p>
            )}
            {askPrice && (
              <div className="grid items-center gap-2 sm:grid-cols-[12rem_1fr]">
                <label htmlFor="tokenize-resume-price" className={labelClass}>
                  Price for {props.pctLabel} %{" "}
                  <span className="normal-case tracking-normal text-slate-400">(optional, USD)</span>
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-500">$</span>
                  <input
                    id="tokenize-resume-price"
                    value={props.priceInput}
                    inputMode="decimal"
                    onChange={(e) => props.setPriceInput(e.target.value)}
                    className={`${inputClass} max-w-[12rem] text-right font-mono`}
                  />
                </div>
              </div>
            )}
            {blocked && <p className="text-[12px] text-red-700">{blocked}</p>}
            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-100 pt-4">
              {props.working && <p className="text-sm text-slate-600" aria-live="polite">{props.working}</p>}
              <button
                type="button"
                disabled={props.busy || !!blocked}
                onClick={props.onContinue}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {label} — {total} wallet signature{total === 1 ? "" : "s"}
              </button>
            </div>
          </div>
        )}
      </section>

      {resume.chain.sc0 && (
        <TokenizeChecklist
          assetPda={resume.assetPda}
          issuerAuthority={props.issuerAuthority}
          profile={resume.profile}
          refreshKey={props.refreshKey}
        />
      )}
    </>
  );
}
