import { EvidenceResult } from "./evidence.js";
import { Classification, CaseType } from "./classify.js";

export interface Prose {
  agent_summary: string;
  recommended_next_action: string;
  customer_reply: string;
}

const VERDICT_PHRASE: Record<EvidenceResult["evidence_verdict"], string> = {
  consistent: "the transaction data supports the customer's account",
  inconsistent: "the transaction data contradicts the customer's account",
  insufficient_data: "the available data is insufficient to confirm the claim",
};

const CASE_LABEL: Record<CaseType, string> = {
  wrong_transfer: "transfer to a wrong/unknown recipient",
  payment_failed: "a failed payment with a possible balance deduction",
  refund_request: "a refund request",
  duplicate_payment: "a duplicate charge",
  merchant_settlement_delay: "a merchant settlement delay",
  agent_cash_in_issue: "an agent cash-in not reflected in balance",
  phishing_or_social_engineering: "a suspected phishing / social-engineering attempt",
  other: "a general support query",
};

/** Safe agent-facing summary seeded from engine findings. */
function buildSummary(e: EvidenceResult, c: Classification): string {
  const txn = e.relevant_transaction_id
    ? `matched transaction ${e.relevant_transaction_id}`
    : "no matching transaction in the provided history";
  return (
    `Case classified as ${CASE_LABEL[c.case_type]} (${c.case_type}). ` +
    `Evidence verdict: ${e.evidence_verdict} — ${VERDICT_PHRASE[e.evidence_verdict]} (${txn}). ` +
    `Routed to ${c.department} at ${c.severity} severity. ` +
    `${c.human_review_required ? "Human review required." : "No human review required."}`
  );
}

/**
 * Recommended next action. Safe-by-construction: never confirms a refund/
 * reversal, never asks for credentials. Phrased as agent guidance.
 */
function buildNextAction(e: EvidenceResult, c: Classification): string {
  switch (c.case_type) {
    case "phishing_or_social_engineering":
      return "Escalate to fraud_risk immediately, advise the customer to share no credentials with anyone, and flag the account for monitoring.";
    case "wrong_transfer":
      return "Verify the recipient details against the ledger and open a dispute_resolution case; do not promise reversal until eligibility is confirmed.";
    case "payment_failed":
      return "Confirm the transaction status and any deduction in the ledger via payments_ops; if a deduction without completion is verified, queue it for the standard reversal review process.";
    case "duplicate_payment":
      return "Compare the two charges in payments_ops to confirm duplication before any adjustment.";
    case "merchant_settlement_delay":
      return "Check the settlement window and payout batch in merchant_operations and update the merchant on expected timing.";
    case "agent_cash_in_issue":
      return "Verify the agent cash-in record in agent_operations and reconcile against the customer balance.";
    case "refund_request":
      return e.evidence_verdict === "inconsistent"
        ? "Route to dispute_resolution for evidence review before any refund decision."
        : "Review eligibility under the standard refund policy; do not confirm an outcome to the customer yet.";
    case "other":
    default:
      return "Gather any missing transaction details from the customer and route to customer_support for a first review.";
  }
}

/**
 * Customer-facing reply. Written safe-by-construction: professional, no
 * assumptions, no credential asks, no refund confirmation, official channels
 * only. The sanitizer is still the final gate.
 */
function buildCustomerReply(e: EvidenceResult, c: Classification): string {
  const opener =
    "Thank you for reaching out. We have received your report and a support specialist is reviewing it.";

  let body: string;
  switch (c.case_type) {
    case "phishing_or_social_engineering":
      body =
        "For your security, please never share your PIN, OTP, or password with anyone — our staff will never ask for them. We have flagged this for our fraud team to review.";
      break;
    case "wrong_transfer":
      body =
        "We are reviewing the transfer you reported against our records. Any eligible amount will be handled through official channels once verification is complete.";
      break;
    case "payment_failed":
      body =
        "We are checking the status of the transaction and any amount that may have been deducted. Any eligible amount will be returned through official channels after verification.";
      break;
    case "duplicate_payment":
      body =
        "We are reviewing the charges you mentioned to check for duplication. Any eligible amount will be returned through official channels after verification.";
      break;
    case "merchant_settlement_delay":
      body =
        "We are checking the settlement status for this payment and will update you on the expected timing.";
      break;
    case "agent_cash_in_issue":
      body =
        "We are verifying the agent cash-in against your account records and will update you shortly.";
      break;
    case "refund_request":
      body =
        "We are reviewing your request. Any eligible amount will be returned through official channels after the review is complete.";
      break;
    case "other":
    default:
      body =
        "We are reviewing the details you provided and may contact you for any additional information needed.";
      break;
  }

  const closer =
    e.evidence_verdict === "insufficient_data"
      ? " To help us investigate faster, please share any transaction ID or timing related to this issue through our official support channel."
      : " You can follow up anytime through our official support channel.";

  return `${opener} ${body}${closer}`;
}

/** Build all three text fields deterministically (template path, S1 fallback). */
export function generateProse(
  e: EvidenceResult,
  c: Classification,
): Prose {
  return {
    agent_summary: buildSummary(e, c),
    recommended_next_action: buildNextAction(e, c),
    customer_reply: buildCustomerReply(e, c),
  };
}
