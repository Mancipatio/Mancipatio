import { Body, H2, Section, Small } from "@/components/mx";

/** Product data-flow notice, separate from the published legal clauses. */
export function AssistantPrivacyNotice() {
  return (
    <Section>
      <div id="ask-manci" className="scroll-mt-24">
        <H2>Ask Manci: how questions are handled</H2>
        <Small className="mt-3">Updated: 2026-11-07</Small>
        <Body className="mt-4">Ask Manci is a public assistant. When generated answers are available, your current question, up to two earlier questions and relevant Manci reference material are sent to Anthropic through the Claude API. Anthropic processes those inputs to generate the response. Avoid personal information, identity documents, wallet secrets and confidential business information.</Body>
        <Body className="mt-4">The conversation is held in this page’s memory and is cleared when you clear the chat or reload the page. Manci does not store or log assistant questions or answers. Hosting and AI providers may process request data under the terms and retention settings applicable to those services.</Body>
        <Body className="mt-4">To limit abuse and costs, the server stores a keyed, hashed IP identifier and request counters. It does not store the raw IP address in the assistant quota table. Expired minute and daily counters are removed on subsequent quota checks. The assistant cannot access your account, verification documents or wallet, or submit transactions.</Body>
      </div>
    </Section>
  );
}
