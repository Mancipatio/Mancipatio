"use client";

// The reads behind the issuer journey (lib/issuer-journey.ts), for both
// places it renders: the issuer workspace (audience "issuer": the signer's own
// application and its classes' public-sale requests) and the admin issuer
// detail (audience "admin": the application queue matched to the issuer, the
// public-sale requests of its classes and the conversion queue).
//
// What it reads beyond the on-chain snapshot the page already holds:
//   - the addresses of the issuer's assets and share classes (derived, no RPC);
//   - each initialized class's treasury balance and the issuer's live sale
//     approvals (two kinds of read-only RPC calls; one approvals call per issuer);
//   - the SPV linked to the issuer (the public SPV registry read);
//   - the signed rows, through an EXISTING wallet session only
//     (`interactive: false`): the tracker is background information and never
//     opens a wallet prompt. Without a session those rows are "not loaded",
//     and the step says so.
// Every read fails on its own: a failure leaves that piece unknown, never
// "none" (lib/issuer-journey.ts keeps the conservative state), and is named
// in `unavailable` for the panel's retry line.

import { useEffect, useMemo, useState } from "react";
import type { Address } from "@solana/kit";
import type { WalletSession } from "@solana/client";
import { useSolanaClient } from "@solana/react-hooks";
import { findAssetPda, findIssuerPda, type Issuer } from "@/lib/generated/asset_registry";
import type { NetworkData } from "@/lib/enumerate";
import { findShareClassPda } from "@/lib/pdas";
import { readTreasuryBalance } from "@/lib/tokenize-shares-chain";
import { isApprovalLive, listIssuerSaleApprovals } from "@/lib/sale-approvals";
import { listSaleRequests } from "@/lib/sale-requests";
import { listApplications, listMyApplications } from "@/lib/launchpad";
import { WalletSessionRequiredError } from "@/lib/siws-client";
import { adminListConversionRequests, type ConversionRequest } from "@/lib/conversion";
import { listIssuerSpvs } from "@/lib/spvs";
import {
  journeyAssets,
  latestApplication,
  pickIssuerSpv,
  saleRequestOf,
  type AddressedAsset,
  type AddressedClass,
} from "@/lib/issuer-journey-input";
import {
  issuerJourney,
  type IssuerJourney,
  type JourneyApplication,
  type JourneyAsset,
  type JourneyAudience,
  type JourneyInput,
  type JourneySaleRequest,
  type JourneySpv,
} from "@/lib/issuer-journey";

type Extras = {
  application: JourneyApplication | null | undefined;
  spv: JourneySpv | null | undefined;
  assets: JourneyAsset[];
  unavailable: string[];
};

export type IssuerJourneyRead = {
  journey: IssuerJourney;
  /** The first read for the current inputs has not finished. */
  loading: boolean;
  /** Reads that failed (the steps behind them say "not loaded"). */
  unavailable: string[];
};

export function useIssuerJourney(opts: {
  audience: JourneyAudience;
  /** The on-chain snapshot the page loaded (null while loading or after a failure). */
  data: NetworkData | null;
  /** The company's on-chain Issuer; null when none is registered for this wallet. */
  issuer: Issuer | null;
  /** The account's own verification (issuer audience; see JourneyInput.verification). */
  verification?: JourneyInput["verification"];
  /** The wallet session for the signed reads (existing session only). */
  session: WalletSession | null | undefined;
  /** Bump to read again. */
  refreshKey?: number;
}): IssuerJourneyRead {
  const { audience, data, issuer, verification, session, refreshKey = 0 } = opts;
  const client = useSolanaClient();
  // A fresh token per set of inputs: a result counts only for the token it was read for.
  const token = useMemo(() => ({ audience, data, issuer, session, refreshKey }), [audience, data, issuer, session, refreshKey]);
  const [read, setRead] = useState<{ token: object; extras: Extras } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadExtras({ audience, data, issuer, session, rpc: client.runtime.rpc }).then((extras) => {
      if (!cancelled) setRead({ token, extras });
    });
    return () => {
      cancelled = true;
    };
  }, [token, audience, data, issuer, session, client]);

  const current = read?.token === token ? read.extras : null;
  const journey = useMemo(
    () =>
      issuerJourney({
        audience,
        verification,
        issuer: issuer ? { kybStatus: issuer.kybStatus, jurisdiction: issuer.jurisdiction, authority: issuer.authority.toString() } : null,
        application: current ? current.application : undefined,
        spv: current ? current.spv : issuer ? undefined : null,
        assets: current?.assets ?? [],
      }),
    [audience, verification, issuer, current],
  );
  return { journey, loading: current === null, unavailable: current?.unavailable ?? [] };
}

async function loadExtras(input: {
  audience: JourneyAudience;
  data: NetworkData | null;
  issuer: Issuer | null;
  session: WalletSession | null | undefined;
  rpc: ReturnType<typeof useSolanaClient>["runtime"]["rpc"];
}): Promise<Extras> {
  const { audience, data, issuer, session, rpc } = input;
  const unavailable: string[] = [];
  let issuerPda: Address | null = null;
  let assets: AddressedAsset[] = [];
  let classes: AddressedClass[] = [];
  if (issuer && data) {
    [issuerPda] = await findIssuerPda({ legalEntityId: issuer.legalEntityId });
    const pda = issuerPda;
    assets = await Promise.all(
      data.assets
        .filter((asset) => asset.issuer.toString() === pda.toString())
        .map(async (asset) => ({ address: (await findAssetPda({ issuer: pda, assetId: asset.assetId }))[0].toString(), asset })),
    );
    const mine = new Set(assets.map((a) => a.address));
    classes = await Promise.all(
      data.shareClasses
        .filter((sc) => mine.has(sc.asset.toString()))
        .map(async (shareClass) => ({ address: (await findShareClassPda(shareClass.asset, shareClass.classIndex)).toString(), shareClass })),
    );
  }

  const [applications, spvs, approvals, treasury, requests, conversions] = await Promise.allSettled([
    audience === "issuer" ? listMyApplications(session, { interactive: false }) : listApplications(session, undefined, { interactive: false }),
    issuerPda ? listIssuerSpvs(issuerPda.toString()) : Promise.resolve([]),
    issuerPda ? listIssuerSaleApprovals(rpc, issuerPda) : Promise.resolve([]),
    // readTreasuryBalance answers null on failure; the journey reads null as unknown.
    Promise.all(classes.map(async (c) => [c.address, c.shareClass.mintInitialized && issuer
      ? await readTreasuryBalance(rpc, issuer.authority, c.shareClass.mint)
      : BigInt(0)] as const)),
    Promise.all(classes.map(async (c): Promise<readonly [string, JourneySaleRequest | null | undefined, boolean]> => {
      try {
        return [c.address, saleRequestOf(await listSaleRequests(session, { share_class: c.address }, { interactive: false })), false];
      } catch (err) {
        return [c.address, undefined, !(err instanceof WalletSessionRequiredError)];
      }
    })),
    audience === "admin" ? adminListConversionRequests(session, undefined, { interactive: false }) : Promise.resolve(undefined),
  ]);

  // No wallet session is not a failure: the signed rows are simply not
  // loaded (the step says to sign in), and there is nothing to retry.
  const failed = (r: PromiseSettledResult<unknown>) =>
    r.status === "rejected" && !(r.reason instanceof WalletSessionRequiredError);

  let application: JourneyApplication | null | undefined;
  if (applications.status === "fulfilled") {
    application = latestApplication(
      applications.value,
      audience === "admin" && issuerPda && issuer ? { issuerPda: issuerPda.toString(), authority: issuer.authority.toString() } : undefined,
    );
  } else if (failed(applications)) {
    unavailable.push("the application");
  }

  let spv: JourneySpv | null | undefined = null;
  if (issuerPda) {
    if (spvs.status === "fulfilled") spv = pickIssuerSpv(spvs.value);
    else {
      spv = undefined;
      unavailable.push("the SPV registry");
    }
  }

  let liveApprovals: Map<string, number> | null = null;
  if (approvals.status === "fulfilled") {
    liveApprovals = new Map();
    for (const a of approvals.value) {
      if (!isApprovalLive(a)) continue;
      const key = a.shareClass.toString();
      liveApprovals.set(key, (liveApprovals.get(key) ?? 0) + 1);
    }
  } else if (issuerPda) {
    unavailable.push("the sale approvals");
  }

  const treasuryMap = new Map<string, bigint | null>(treasury.status === "fulfilled" ? treasury.value : []);
  if (treasury.status !== "fulfilled" || [...treasuryMap.values()].some((v) => v === null)) unavailable.push("the treasury balances");

  const requestRows = requests.status === "fulfilled" ? requests.value : [];
  const requestMap = new Map<string, JourneySaleRequest | null | undefined>(requestRows.map(([address, request]) => [address, request]));
  if (requestRows.some(([, , readFailed]) => readFailed)) unavailable.push("the public-sale requests");

  let conversionRows: ConversionRequest[] | undefined;
  if (audience === "admin") {
    if (conversions.status === "fulfilled" && conversions.value) conversionRows = conversions.value;
    else if (failed(conversions)) unavailable.push("the conversion requests");
  }

  return {
    application,
    spv,
    assets: journeyAssets({
      assets,
      classes,
      sales: data?.sales ?? [],
      treasury: treasuryMap,
      liveApprovals,
      saleRequests: requestMap,
      conversions: conversionRows,
    }),
    unavailable,
  };
}
