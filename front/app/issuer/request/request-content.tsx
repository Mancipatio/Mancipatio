"use client";

import Link from "next/link";
import { scopeEnabled } from "@/lib/features";
import { issuerWorkflowState } from "@/lib/issuer-workflow";
import { IssuerVerificationSummary, type WorkflowData } from "../issuer-workflow";
import styles from "../issuer-workflow.module.css";

export function IssuerRequestContent({ workflow }: { workflow: WorkflowData }) {
  const issuanceOn = scopeEnabled("issuance");
  const state = issuerWorkflowState(workflow.verification, workflow.me?.kybStatus ?? null);
  return <main className="min-w-0 flex-1">
    <p className={styles.eyebrow}>3. Token issuance request</p><h1 className={styles.title}>Prepare your equity token offer.</h1>
    <p className={styles.intro}>After KYC / KYB approval, submit the company and raise details for review. We can request changes before approving the issuance and sale terms.</p>
    {!state.approved && <IssuerVerificationSummary workflow={workflow} />}
    <section className={styles.detail} style={{ marginTop: 24 }}>
      <h2>Submit or follow your request</h2>
      <p>The application contains your company information, equity offered, raise amount and supporting documents. If you already applied, it shows your current decision, feedback and the option to resubmit corrections.</p>
      <p>Use your linked wallet for the application. Individual founders can apply after KYC approval; existing companies use approved KYB.</p>
      <div className={styles.actions}>
        {state.approved && issuanceOn ? <Link href="/apply" className={styles.button}>Open issuance application →</Link>
          : <span className="text-sm text-slate-500">{issuanceOn ? "Available after KYC / KYB approval." : "Token issuance is paused for now."}</span>}
        <Link href="/issuer/status" className={`${styles.button} ${styles.secondary}`}>Verification status</Link>
      </div>
    </section>
    {state.canManageIssuer && issuanceOn && <section className={styles.detail} style={{ marginTop: 14 }}>
      <h2>Your registered issuer</h2><p>Your connected issuer has company approval. Continue token setup for approved terms, or manage existing assets and primary sales.</p>
      <div className={styles.actions}><Link href="/issuer/assets/tokenize" className={`${styles.button} ${styles.secondary}`}>Token setup</Link><Link href="/issuer/assets" className={`${styles.button} ${styles.secondary}`}>My assets</Link><Link href="/issuer/launchpad" className={`${styles.button} ${styles.secondary}`}>Primary sales</Link></div>
    </section>}
  </main>;
}
