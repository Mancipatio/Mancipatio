// The /apply panel for an applicant whose company is incorporated outside
// Serbia, not yet incorporated, or who applies as an individual
// (lib/apply-spv.ts spvPathApplies): company ownership, debt and revenue
// share are issued through a Serbian SPV that Manci incorporates and
// administers, what the applicant will need to provide, the costs, and the
// explicit choice the form stores as company_formation_requested. An
// individual has no choice to make (the server forces the request), so the
// box is shown ticked and disabled.
//
// No hooks: the apply page owns the state; tests render it statically
// (tests/apply-spv.test.ts).
import { Bullets, Card, FootNote, TextLink } from "@/components/mx";
import {
  SERBIAN_SPV_GUIDE,
  SPV_CHOICE_LABEL,
  SPV_COSTS,
  SPV_REQUIREMENTS,
} from "@/lib/apply-spv";

export function SerbianSpvPanel({
  isIndividual,
  incorporation,
  chosen,
  onChosenChange,
  className,
}: {
  isIndividual: boolean;
  incorporation: string;
  chosen: boolean;
  onChosenChange: (chosen: boolean) => void;
  className?: string;
}) {
  const why = isIndividual
    ? "You are applying as an individual, so there is no company to issue through yet."
    : incorporation === "Not yet"
      ? "Your company is not incorporated yet."
      : `Your company is incorporated in ${incorporation === "Other" ? "a country other than Serbia" : incorporation}, not in Serbia.`;
  return (
    <Card className={className} title="Issuing through a Serbian SPV">
      <p>
        {why} Company ownership, debt and revenue share are issued through a
        Serbian company: Manci incorporates a Serbian special-purpose vehicle
        (SPV) and administers it for the issuance.
      </p>
      <p className="mt-3 mx-strong">What you will need to provide</p>
      <Bullets className="mt-2" items={[...SPV_REQUIREMENTS]} />
      <p className="mt-3">{SPV_COSTS}</p>
      <label className="mt-4 flex items-start gap-2.5">
        <input
          type="checkbox"
          name="companyFormationRequested"
          className="mt-1"
          checked={isIndividual || chosen}
          disabled={isIndividual}
          onChange={(e) => onChosenChange(e.target.checked)}
          style={{ accentColor: "var(--mx-ink)" }}
        />
        <span>
          <span className="mx-strong">{SPV_CHOICE_LABEL}</span>
          <span className="mt-0.5 block text-[13px] text-mx-ink-soft">
            {isIndividual
              ? "As an individual applicant you always issue through an SPV that Manci incorporates."
              : chosen
                ? "Your application will ask Manci to incorporate the SPV; the review confirms the structure and the quote."
                : "Leave it unticked if you would rather discuss the structure with the team first."}
          </span>
        </span>
      </label>
      <FootNote className="mt-3">
        <TextLink href={SERBIAN_SPV_GUIDE}>How issuing through a Serbian SPV works →</TextLink>
      </FootNote>
    </Card>
  );
}
