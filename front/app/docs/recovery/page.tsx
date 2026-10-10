import { AppShell } from "@/components/app-shell";
import { DocumentationFrame } from "@/components/documentation-frame";
import {
  PageHeader,
  Section,
  H2,
  Body,
  Card,
  Grid,
  TextLink,
} from "@/components/mx";

// The transaction recovery guide. It replaced the "Pilot operator guide"
// (/docs/pilot, which now redirects here): the recovery advice applies to
// everyone, on every network, so the page carries no pilot or test-release
// framing. The sentence "A pending or unavailable status is not proof of
// failure." is the one the deployment smoke test looks for
// (scripts/ops/deployment-smoke.test.ts); keep it word for word.
export const metadata = {
  title: "Transaction recovery guide · Manci",
  description:
    "What to do when a transaction is pending or was interrupted: check the result on-chain, restore the saved record and never repeat a payment.",
};
export default function RecoveryGuide() {
  return (
    <AppShell section="documentation">
      <DocumentationFrame>
        <PageHeader
          eyebrow="Guide"
          title="When a transaction is pending"
          lede="A submitted transaction can confirm while the app or its RPC provider is unavailable. Check the result on-chain first, and never repeat a payment to fix a missing record."
        />
        <Section>
          <H2>When an action is interrupted</H2>
          <Body className="mt-4">
            Keep the transaction signature and the saved request or account
            address. A submitted transaction can finish while the app or RPC is
            unavailable. Restore the existing plan or receipt and use its
            retry-record action. Do not create another sale, repeat a deposit or
            rebuild recipients to resolve a missing database record.
          </Body>
          <Body className="mt-4">
            A pending or unavailable status is not proof of failure. Verify the
            chain result before retrying a transaction. Vesting and distribution
            setup resume their saved addresses and steps; confirmed returns are
            recorded separately from the refund transaction.
          </Body>
        </Section>
        <Section>
          <H2>Review the result</H2>
          <Body className="mt-4">
            Check the accepted document version, intended wallet, amount,
            remaining escrow and recorded status. Before a refund or surplus
            withdrawal, review the recipient reserve, deadline and current
            eligibility. Use the{" "}
            <TextLink href="/solutions/custody">custody guide</TextLink> for
            those routes and the{" "}
            <TextLink href="/security">security reference</TextLink> for
            authority scope.
          </Body>
        </Section>
        <Section>
          <H2>For issuers and operators</H2>
          <Grid cols={2} className="mt-5">
            <Card title="Use the required authority">
              <Body>
                A privileged action needs the wallet that currently holds the
                role. A role replacement takes effect only once the proposed
                wallet accepts it.{" "}
                <TextLink href="/issuer/authority">
                  Authority setup and acceptance →
                </TextLink>
              </Body>
            </Card>
            <Card title="Check current issuer permissions">
              <Body>
                KYB status and operating permissions are separate. Grant only
                the issuer actions the issuance needs, and recheck revoked
                roles.{" "}
                <TextLink href="/issuer/share-classes">
                  Issuer operations →
                </TextLink>
              </Body>
            </Card>
            <Card title="Execute only a saved plan">
              <Body>
                Where a workflow saves its terms or recipients before funding,
                as a vesting series or a distribution does, fund and execute
                only that saved plan, then check its receipts and the remaining
                escrow balance.{" "}
                <TextLink href="/how-it-works#distributions">
                  Distribution workflow →
                </TextLink>
              </Body>
            </Card>
          </Grid>
        </Section>
      </DocumentationFrame>
    </AppShell>
  );
}
