import { RequireRole } from "@/components/require-role";
import { KnowledgeEditor } from "./knowledge-editor";

export default function AssistantKnowledgePage() {
  return (
    <section className="min-w-0 flex-1">
      <p className="page-eyebrow">System</p>
      <h1 className="page-title">Assistant knowledge</h1>
      <p className="page-sub">
        Manage the answers, policies, and procedures that inform Ask Manci.
        Drafts stay private. Publish only material approved for public use.
      </p>
      <RequireRole role="admin">
        <div className="mt-7"><KnowledgeEditor /></div>
      </RequireRole>
    </section>
  );
}
