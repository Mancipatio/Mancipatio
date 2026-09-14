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
export const metadata = {
  title: "Pilot operator guide · Mancipatio",
  description:
    "Check a test release, prepare approved actions and recover pending records without repeating payments.",
};
export default function PilotGuide() {
  return (
    <AppShell section="documentation">
      <DocumentationFrame>
        <PageHeader
          eyebrow="Operator guide"
          title="Run a controlled pilot"
          lede="Check the release and permissions first. Keep test assets and review each recorded result before proceeding."
        />
        <Section>
          <H2>Before testing</H2>
          <Body className="mt-4">
            Confirm the selected Solana network and that the deployed programs,
            app and database belong to the same reviewed release. Local test
            results alone do not confirm a deployment. Use test assets;
            availability depends on the configured release and services.
          </Body>
          <Grid cols={2} className="mt-5">
            <Card title="Use the required authority">
              <Body>
                Bootstrap requires the program’s upgrade authority. An
                operational replacement requires the proposed wallet to accept.{" "}
                <TextLink href="/issuer/authority">
                  Authority setup and acceptance →
                </TextLink>
              </Body>
            </Card>
            <Card title="Check current issuer permissions">
              <Body>
                KYB status and operating permissions are separate. Grant only
                the issuer actions needed for the pilot, and recheck revoked
                roles.{" "}
                <TextLink href="/issuer/share-classes">
                  Issuer operations →
                </TextLink>
              </Body>
            </Card>
          </Grid>
        </Section>
        <Section>
          <H2>Prepare before funds move</H2>
          <Grid cols={2} className="mt-5">
            <Card title="Vesting">
              <Body>
                Approve the exact terms, finish and finalize the Draft before
                its first unlock, and record it before funding. Check the
                remaining allocation and actual escrow balance.{" "}
                <TextLink href="/solutions/rights-vesting">
                  Vesting workflow →
                </TextLink>
              </Body>
            </Card>
            <Card title="Distributions">
              <Body>
                Review and save the original recipients, amounts and funding
                total. Execute only that saved plan and check its batch
                receipts.{" "}
                <TextLink href="/how-it-works#distributions">
                  Distribution workflow →
                </TextLink>
              </Body>
            </Card>
          </Grid>
        </Section>
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
            remaining escrow and recorded status. Before testing a refund or
            surplus withdrawal, review the recipient reserve, deadline and
            current eligibility. Use the{" "}
            <TextLink href="/solutions/custody">custody guide</TextLink> for
            those routes and the{" "}
            <TextLink href="/security">security reference</TextLink> for
            authority scope.
          </Body>
        </Section>
      </DocumentationFrame>
    </AppShell>
  );
}
