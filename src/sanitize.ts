import { Prose } from "./prose.js";

/**
 * Safety guardrail / output sanitizer (§7, M6). Deterministic regex + rule
 * logic, independent of any LLM, run on every text field AFTER generation.
 * Catches model slips and template mistakes. Last, non-negotiable gate.
 *
 * Two or more critical violations across hidden cases = disqualification, so
 * the philosophy here is: when in doubt, replace the offending field with a
 * known-safe template rather than try to surgically edit it.
 */

export interface SanitizeResult {
  prose: Prose;
  violations: string[];
}

// --- detection patterns -----------------------------------------------------

// credential request detection. A credential noun + a request verb in the same
// sentence is a violation UNLESS the sentence is negated/advisory
// ("never share your PIN", "we will never ask for your OTP") — that is good
// security guidance and must pass.
const CREDENTIAL_NOUN =
  /\b(pin|otp|password|passcode|one[-\s]?time\s?code|cvv|card\s?number|full\s?card)\b/i;
const REQUEST_VERB =
  /\b(send|share|provide|enter|confirm|tell|give|type|verify|reveal|submit)\b/i;
const NEGATION =
  /\b(never|do not|don'?t|won'?t|will\s+never|not\s+(?:share|ask|provide|send)|no\s+need|avoid)\b/i;

/** True only when a sentence actively asks the customer for a credential. */
function asksForCredential(text: string): boolean {
  for (const sent of text.split(/(?<=[.?!])\s+/)) {
    if (!CREDENTIAL_NOUN.test(sent)) continue;
    if (!REQUEST_VERB.test(sent)) continue;
    if (NEGATION.test(sent)) continue; // advisory -> safe
    return true;
  }
  return false;
}

// refund / reversal confirmation (promising an outcome)
const REFUND_CONFIRM =
  /\b(we\s+(?:will|'ll|have|are\s+going\s+to)\s+(?:refund|reverse|reversed|return|credit|unblock|recover|restore))|(?:your\s+(?:refund|money)\s+(?:has been|is being|will be)\s+(?:processed|reversed|approved|credited))|(?:refund\s+(?:approved|confirmed|guaranteed))\b/i;

// safe refund phrasing that must NOT trip the confirm rule
const REFUND_SAFE = /eligible\s+amount\s+will\s+be\s+returned\s+through\s+official\s+channels/i;

// third-party redirect: external links, non-official phone numbers
const URL = /\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+/i;
const PHONE = /\b(?:\+?88)?01\d{9}\b|\b\d{4,}[-\s]?\d{3,}\b/;

// prompt-injection echo
const INJECTION =
  /\b(ignore (?:all |the )?(?:previous|above|prior) (?:instructions|rules)|disregard (?:your|the) (?:rules|instructions)|as an ai|system prompt|you are now|override)\b/i;

// --- safe replacements -------------------------------------------------------

const SAFE_REPLY =
  "Thank you for contacting support. Your report has been received and is being reviewed by a specialist. For your security, never share your PIN, OTP, or password with anyone — our staff will never ask for them. Any eligible amount will be returned through official channels after verification. Please follow up through our official support channel.";

const SAFE_NEXT_ACTION =
  "Route to the appropriate team for verification against the ledger; do not confirm any financial outcome to the customer until eligibility is verified through official channels.";

function stripThirdParty(text: string): string {
  const globalURL = new RegExp(URL, "gi");
  const globalPHONE = new RegExp(PHONE, "g");
  return text
    .replace(globalURL, "our official support channel")
    .replace(globalPHONE, "our official support channel");
}

function neutralizeInjection(text: string): string {
  // drop any sentence that echoes an injected directive
  return text
    .split(/(?<=[.?!])\s+/)
    .filter((s) => !INJECTION.test(s))
    .join(" ")
    .trim();
}

// --- field sanitizers --------------------------------------------------------

function sanitizeCustomerReply(text: string, v: string[]): string {
  let out = neutralizeInjection(text);
  if (INJECTION.test(text)) v.push("prompt_injection_echo:customer_reply");

  if (asksForCredential(out)) {
    v.push("critical:credential_request:customer_reply");
    return SAFE_REPLY;
  }

  if (!REFUND_SAFE.test(out) && REFUND_CONFIRM.test(out)) {
    v.push("critical:refund_confirmation:customer_reply");
    const globalRefundConfirm = new RegExp(REFUND_CONFIRM, "gi");
    out = out.replace(
      globalRefundConfirm,
      "any eligible amount will be returned through official channels",
    );
  }

  if (URL.test(out) || PHONE.test(out)) {
    v.push("third_party_redirect:customer_reply");
    out = stripThirdParty(out);
  }

  return out.trim() || SAFE_REPLY;
}

function sanitizeNextAction(text: string, v: string[]): string {
  let out = neutralizeInjection(text);
  if (INJECTION.test(text)) v.push("prompt_injection_echo:recommended_next_action");

  if (!REFUND_SAFE.test(out) && REFUND_CONFIRM.test(out)) {
    v.push("critical:refund_confirmation:recommended_next_action");
    return SAFE_NEXT_ACTION;
  }
  if (asksForCredential(out)) {
    v.push("critical:credential_request:recommended_next_action");
    return SAFE_NEXT_ACTION;
  }
  return out.trim() || SAFE_NEXT_ACTION;
}

function sanitizeSummary(text: string, v: string[]): string {
  let out = neutralizeInjection(text);
  if (INJECTION.test(text)) v.push("prompt_injection_echo:agent_summary");
  // summary is internal; only strip injection + any leaked credential ask
  if (asksForCredential(out)) {
    const globalCredentialNoun = new RegExp(CREDENTIAL_NOUN, "gi");
    out = out.replace(globalCredentialNoun, "[redacted]");
    v.push("credential_request:agent_summary");
  }
  return out.trim() || "Case reviewed; see structured fields for routing and verdict.";
}

/** Run all three fields through the guardrail. */
export function sanitize(prose: Prose): SanitizeResult {
  const violations: string[] = [];
  return {
    prose: {
      agent_summary: sanitizeSummary(prose.agent_summary, violations),
      recommended_next_action: sanitizeNextAction(
        prose.recommended_next_action,
        violations,
      ),
      customer_reply: sanitizeCustomerReply(prose.customer_reply, violations),
    },
    violations,
  };
}
