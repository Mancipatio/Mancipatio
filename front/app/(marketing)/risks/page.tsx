import type { Metadata } from "next";
import {
  Body,
  Disclaimer,
  MX_ROUTES,
  PageHeader,
  Section,
  SectionHead,
  TextLink,
} from "@/components/mx";
import { detectNetwork, isTestNetwork } from "@/lib/network";

/**
 * "What can go wrong" — prototype `#page-risks`.
 *
 * The prototype ships the header only; the brief for the body is: name each
 * risk plainly, say what it means for a holder, and don't soften it. Every
 * statement below is one the site already makes elsewhere (the investor page's
 * "Before you join", the issuance flow, the fungible-asset redemption rule,
 * the devnet stage) — nothing here is a new product claim, and no risk is
 * hedged with a reassurance.
 */
export const metadata: Metadata = {
  title: "Risk disclosure — Manci",
  description:
    "Illiquidity, issuer default, conversion friction, regulatory change and the current development stage — including the possibility of total loss.",
};

export default function RisksPage() {
  const network = detectNetwork();
  return (
    <>
      <PageHeader
        eyebrow="Risk disclosure"
        title="What can go wrong"
        lede="Illiquidity, issuer default, conversion friction and the off-chain dependency, regulatory change, and the current development stage — including the possibility of total loss."
      />

      <Section>
        <SectionHead title="These instruments are illiquid" />
        <Body className="mt-4">
          There is no exchange listing and no guaranteed buyer. You may not be
          able to sell when you want to, or at all, and there is no reference
          price to sell against.
        </Body>
        <Body className="mt-3.5">
          Holders can post what they hold on the resell board, but a posting is
          not a bid. A sale happens only if a buyer turns up and agrees terms.
        </Body>
      </Section>

      <Section>
        <SectionHead title="Distributions depend on the issuer paying" />
        <Body className="mt-4">
          Where an instrument pays income, nothing moves until the issuer
          deposits the funds. The contract distributes what arrives; it cannot
          create money that was never sent.
        </Body>
        <Body className="mt-3.5">
          If the issuer doesn&apos;t pay, holders have legal recourse against
          the issuer. Recourse is a claim, not a payment: pursuing it takes
          time, costs money, and can end without recovery.
        </Body>
      </Section>

      <Section>
        <SectionHead title="Conversion runs through an off-chain legal process" />
        <Body className="mt-4">
          Conversion into shares is not automatic and does not happen on-chain.
          It goes through the standard legal share-transfer procedure, which
          depends on the issuer and its founders doing their part.
        </Body>
        <Body className="mt-3.5">
          If they won&apos;t facilitate the transfer, the holder&apos;s route is
          legal recourse against them. Where a share pledge is registered in
          holders&apos; favour, that is what gives the recourse teeth. Where one
          isn&apos;t registered, there is no collateral standing behind the
          claim.
        </Body>
        <p className="mt-5">
          <TextLink href={MX_ROUTES.legalStructure}>
            How the rights bind the issuer →
          </TextLink>
        </p>
      </Section>

      <Section>
        <SectionHead title="Conversion and delivery require verification" />
        <Body className="mt-4">
          Tokens are bearer instruments and, unless the class is KYC-gated,
          can be bought and traded without identity verification, but
          converting them into company shares or redeeming a physical asset
          requires it. A token can therefore reach
          a wallet that cannot convert or redeem it until its holder passes
          verification, and a buyer who expects to convert or redeem should
          check that they can before buying.
        </Body>
        <Body className="mt-3.5">
          Manci does not move the goods. Delivery is arranged with the
          issuer, and a cancelled delivery returns the tokens rather than the
          asset.
        </Body>
      </Section>

      <Section>
        <SectionHead title="The regulatory position can change" />
        <Body className="mt-4">
          Company ownership, debt and revenue share are issued through a
          Serbian SPV, capped at EUR 3 million per SPV per year. Some issues
          require whitepaper approval from the Serbian Securities Commission,
          and approval is not guaranteed.
        </Body>
        <Body className="mt-3.5">
          The rules that apply to tokenized instruments are still developing. A
          change in law or in regulator practice can affect what may be issued,
          who may hold it, and what an issuer has to do.
        </Body>
      </Section>

      <Section>
        <SectionHead title="The platform is at an early stage" />
        <Body className="mt-4">
          {isTestNetwork(network)
            ? `The platform runs on Solana ${network} at v0.1. Nothing is issued live, tokens minted today carry no economic value, and the product can change.`
            : `The platform runs on Solana ${network} at v0.1, and the product can change.`}
        </Body>
        <Body className="mt-3.5">
          Software can contain defects. Both on-chain programs went through a
          systematic security review before they were deployed — that reduces
          the risk of a contract-level failure, it does not remove it.
        </Body>
      </Section>

      <Section>
        <SectionHead title="You can lose everything" />
        <Body className="mt-4">
          Tokenized instruments carry risk, including total loss of the amount
          committed. Do not commit money you cannot afford to lose entirely.
        </Body>
        <p className="mt-5">
          <TextLink href={MX_ROUTES.instruments}>
            What each instrument actually carries →
          </TextLink>
        </p>
        <Disclaimer className="mt-7">
          Nothing on this page is investment, legal or tax advice, and nothing
          here is an offer to sell securities.
        </Disclaimer>
      </Section>
    </>
  );
}
