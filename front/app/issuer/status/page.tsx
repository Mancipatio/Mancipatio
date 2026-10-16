"use client";

import { IssuerReviewDetails } from "../issuer-workflow";
import { useIssuerWorkflow } from "../use-issuer-workflow";
import styles from "../issuer-workflow.module.css";

export default function IssuerStatusPage() {
  const workflow = useIssuerWorkflow();
  return <main className="min-w-0 flex-1">
    <p className={styles.eyebrow}>2. Review status</p><h1 className={styles.title}>Your verification, step by step.</h1>
    <p className={styles.intro}>Check approval, see whether more documents are needed, and continue the same submission.</p>
    <IssuerReviewDetails workflow={workflow} />
  </main>;
}
