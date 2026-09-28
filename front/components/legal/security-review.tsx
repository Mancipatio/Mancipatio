import { SECURITY_AUDIT, securityAuditReport, type SecurityAudit } from "@/lib/legal/audit";

/**
 * The link to the external audit report (lib/legal/audit.ts SECURITY_AUDIT),
 * shown on /risks and /about next to the security-review wording. Renders
 * nothing until an audit is recorded. Server-safe (no hooks).
 */
export function SecurityAuditReportLink({
  audit = SECURITY_AUDIT,
  className,
}: {
  audit?: SecurityAudit | null;
  className?: string;
}) {
  const report = securityAuditReport(audit);
  if (!report) return null;
  return (
    <p className={className}>
      <a className="mx-link" href={report.href} target="_blank" rel="noopener noreferrer">
        {report.label} ↗
      </a>
    </p>
  );
}
