"use client";

import Link from "next/link";
import { IconArrowUpRight, IconCheck, IconClipboard, IconCoins, IconRepeat, IconShield } from "@/components/icons";
import { features, moduleEnabled } from "@/lib/features";
import { issuerWorkflowState, ISSUER_VERIFICATION_LABEL } from "@/lib/issuer-workflow";
import type { useIssuerWorkflow } from "./use-issuer-workflow";
import styles from "./issuer-workflow.module.css";

export type WorkflowData = ReturnType<typeof useIssuerWorkflow>;

export function IssuerWorkflow({ workflow }: { workflow: WorkflowData }) {
  const state = issuerWorkflowState(workflow.verification, workflow.me?.kybStatus ?? null);
  const hasIssuedAssets = state.canManageIssuer && (workflow.me?.assetsCount ?? BigInt(0)) > BigInt(0);
  const steps = [
    { title: "KYC / KYB", description: "Verify your identity as a founder or your existing company. Upload the requested documents.", href: "/issuer/verification", action: "Verification", icon: IconShield,
      status: state.approved ? "Approved" : state.submitted ? "Submitted" : "Start here", done: state.approved, current: !state.submitted },
    { title: "Review & approval", description: "Follow the review here. If we request changes or more documents, update your submission.", href: "/issuer/status", action: "View status", icon: IconClipboard,
      status: state.needsDocuments ? "Action needed" : state.approved ? "Approved" : state.pending ? "Under review" : "After verification", done: state.approved, current: state.submitted && !state.approved },
    { title: "Token issuance request", description: "Submit your company, equity and raise details. Manci reviews the request and agrees the issuance terms.", href: "/issuer/request", action: "Token request", icon: IconCoins,
      status: hasIssuedAssets ? "Assets registered" : state.approved ? "Next step" : "After approval", done: hasIssuedAssets, current: state.approved && !hasIssuedAssets },
    { title: "Primary sale", description: "Once issuance and sale terms are approved, publish the token offer on the Manci marketplace.", href: "/issuer/launchpad", action: "Manage sales", icon: IconArrowUpRight,
      status: hasIssuedAssets ? "Manage offers" : "After issuance", done: false, current: hasIssuedAssets },
  ];
  return <section className={styles.workflow} aria-labelledby="issuer-process-heading">
    <p className={styles.eyebrow}>Issuer workspace</p>
    <h1 id="issuer-process-heading" className={styles.title}>From verification to your token offer.</h1>
    <p className={styles.intro}>One place to follow the process, respond to review and manage your company&apos;s equity tokens. Start with email, Google or your wallet.</p>
    <ol className={styles.steps} aria-label="Issuer process">
      {steps.map((step, index) => <li key={step.title} className={styles.step} data-state={step.done ? "done" : step.current ? "current" : "upcoming"}>
        <div className={styles.stepTop}><span className={styles.number} aria-label={`Step ${index + 1}`}>{step.done ? <IconCheck size={15} /> : index + 1}</span><span className={styles.status} data-tone={step.done ? "positive" : step.current ? "attention" : undefined}>{step.status}</span></div>
        <h3>{step.title}</h3><p>{step.description}</p>
        <Link href={step.href} className={styles.stepLink}>{step.action}<step.icon size={14} /></Link>
      </li>)}
    </ol>
    <IssuerVerificationSummary workflow={workflow} />
    {moduleEnabled("secondaryTrading") && <aside className={styles.holder}>
      <IconCoins size={21} /><div><strong>After the primary sale · Token trading</strong>
        <p>Token holders can use the Manci market to list and trade eligible tokens after acquiring them.</p>
        <div className={styles.actions}><Link href="/marketplace/otc" className={styles.stepLink}>OTC market<IconArrowUpRight size={14} /></Link><Link href="/markets/resell" className={styles.stepLink}>Resale listings<IconArrowUpRight size={14} /></Link></div>
      </div>
    </aside>}
    {moduleEnabled("custodyConversion") && <aside className={styles.holder}>
      <IconRepeat size={21} /><div><strong>For token holders · Optional conversion into company shares</strong>
        <p>After acquiring eligible tokens, a holder can request conversion into company shares from their portfolio. The request checks their token balance, verification and the token&apos;s conversion terms.</p>
        <Link href="/portfolio/conversion" className={styles.stepLink}>Holder conversion<IconArrowUpRight size={14} /></Link>
      </div>
    </aside>}
  </section>;
}

export function IssuerVerificationSummary({ workflow }: { workflow: WorkflowData }) {
  const state = issuerWorkflowState(workflow.verification, workflow.me?.kybStatus ?? null);
  let title = "Start your verification";
  let body = "Sign in with email, Google or a wallet to submit KYC / KYB and follow your review. You can complete verification before connecting a wallet.";
  let action = "Start KYC / KYB";
  let href = "/issuer/verification";
  if (workflow.authLoading || workflow.verificationLoading) {
    title = "Checking your verification status…"; body = "Your process is shown above while we load your account.";
  } else if (workflow.needsSignature) {
    title = "Open your private verification status"; body = "Confirm ownership of your wallet to view your KYC / KYB review. Connecting a wallet does not approve verification.";
  } else if (workflow.verificationError) {
    title = "Verification status unavailable"; body = workflow.verificationError;
  } else if (state.blocked) {
    title = "Verification suspended"; body = "Contact the compliance team before continuing. Your current KYC / KYB decisions are available in review status."; action = "View review status"; href = "/issuer/status";
  } else if (state.needsDocuments) {
    title = "Documents or corrections needed";
    const count = workflow.verification?.documents_requested ?? 0;
    body = count > 0 ? `${count} requested document${count === 1 ? "" : "s"} still need to be supplied. Open verification to review the requirements and continue your submission.` : "Open verification to review the requested information and continue your submission.";
    action = "Continue verification";
  } else if (state.approved) {
    title = "Verification approved"; body = "You can continue to the token issuance request. Issuance and the primary sale have their own review and approval."; action = "Token issuance request"; href = "/issuer/request";
  } else if (state.pending) {
    title = "Your verification is under review"; body = "We are reviewing your submission. Return here to see the decision or any request for additional documents."; action = "View review status"; href = "/issuer/status";
  } else if (workflow.verification?.kyb === "rejected" || workflow.verification?.kyc === "rejected") {
    title = "Verification not approved"; body = "Open verification to review the current decision and contact the compliance team about the next step."; action = "View verification";
  } else if (workflow.signedIn) {
    body = "Complete KYC as an individual founder or KYB for an existing company. Your account is connected; verification is a separate review.";
  }
  return <div className={styles.statusPanel}>
    <div><strong>{title}</strong><p>{body}</p></div>
    {workflow.needsSignature || workflow.verificationError
      ? <button type="button" className={styles.button} onClick={workflow.refreshVerification}>{workflow.needsSignature ? "View my status" : "Try again"}</button>
      : !workflow.authLoading && !workflow.verificationLoading && <Link href={href} className={styles.button}>{action}<IconArrowUpRight size={14} /></Link>}
  </div>;
}

export function IssuerReviewDetails({ workflow }: { workflow: WorkflowData }) {
  const verification = workflow.verification;
  const state = issuerWorkflowState(verification, workflow.me?.kybStatus ?? null);
  return <>
    <IssuerVerificationSummary workflow={workflow} />
    {verification && <div className={styles.details}>
      {(["kyc", "kyb"] as const).map((kind) => <section key={kind} className={styles.detail}>
        <h2>{kind === "kyc" ? "Identity verification (KYC)" : "Company verification (KYB)"}</h2>
        <span className={styles.status} data-tone={verification[kind] === "verified" ? "positive" : "attention"}>{ISSUER_VERIFICATION_LABEL[verification[kind]]}</span>
        <p>{kind === "kyc" ? "For individual founders. Approval lets you request an equity raise with company formation." : "For an existing company. Its company documents are reviewed separately from your individual identity."}</p>
        <Link href={`/issuer/verification?type=${kind}&next=/apply`} className={styles.stepLink}>{verification[kind] === "more_info" ? "Supply documents / corrections" : "Open verification"}<IconArrowUpRight size={14} /></Link>
      </section>)}
    </div>}
    {workflow.signedIn && <section className={styles.detail} style={{ marginTop: 14 }}>
      <h2>Issuer registration</h2>
      <p>{workflow.accountMode && !workflow.walletMatchesAccount
        ? "To manage a registered issuer, connect a wallet linked to this account. Your account verification is shown above."
        : workflow.failed ? "Issuer registration could not be loaded. Please retry."
        : workflow.me ? `The connected issuer wallet is registered. Company approval: ${["Pending", "Verified", "Rejected", "Suspended"][workflow.me.kybStatus] ?? "Unknown"}.`
        : "Issuer registration is separate from your account verification. An approved application leads to issuer and token setup; connecting a wallet does not create or approve an issuer."}</p>
      <div className={styles.actions}>
        {state.approved && <Link href="/apply" className={`${styles.button} ${styles.secondary}`}>Application status</Link>}
        {workflow.failed && <button type="button" onClick={() => void workflow.refresh()} className={`${styles.button} ${styles.secondary}`}>Retry issuer status</button>}
        <button type="button" onClick={() => { workflow.refreshVerification(); void workflow.refresh(); }} className={`${styles.button} ${styles.secondary}`}>Refresh status</button>
      </div>
    </section>}
  </>;
}

export function IssuerCompanyTools() {
  return <details className={styles.tools}><summary>Company tools</summary><nav aria-label="Company tools">
    <Link href="/issuer/assets">My assets</Link><Link href="/issuer/share-classes">Share classes</Link>
    <Link href="/issuer/assets/tokenize">Token setup</Link>
    {features().issuerRotation && <Link href="/issuer/rotation">Authority key</Link>}
    <Link href="/issuer/recovery">Issuer recovery</Link>
  </nav></details>;
}
