import { ControllerSection } from "@/components/legal/controller-section";
import {
  LegalDocumentMissing,
  LegalDocumentView,
} from "@/components/legal/legal-document";
import { MAINNET_PRIVACY } from "@/lib/legal/mainnet-copy";
import { operatorFor } from "@/lib/legal/operator";

/**
 * Privacy Policy on MAINNET: the controller block generated from the operator
 * record (lib/legal/operator.ts), then counsel's clauses
 * (lib/legal/mainnet-copy.ts).
 */
export function MainnetPrivacy() {
  if (!MAINNET_PRIVACY) return <LegalDocumentMissing title="Privacy Policy" />;
  return (
    <LegalDocumentView
      title="Privacy Policy"
      document={MAINNET_PRIVACY}
      before={<ControllerSection operator={operatorFor("mainnet")} />}
    />
  );
}
