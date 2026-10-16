"use client";

import { useIssuerWorkflow } from "../use-issuer-workflow";
import { IssuerRequestContent } from "./request-content";

export default function IssuerRequestPage() {
  const workflow = useIssuerWorkflow();
  return <IssuerRequestContent workflow={workflow} />;
}
