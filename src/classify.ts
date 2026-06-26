import {
  CASE_TYPES,
  DEPARTMENTS,
  SEVERITIES,
} from "./schema.js";
import { Normalized } from "./normalize.js";
import { ClaimSignals, EvidenceResult } from "./evidence.js";

export type CaseType = (typeof CASE_TYPES)[number];
export type Department = (typeof DEPARTMENTS)[number];
export type Severity = (typeof SEVERITIES)[number];

export interface Classification {
  case_type: CaseType;
  department: Department;
  severity: Severity;
  human_review_required: boolean;
  confidence: number;
  reason_codes: string[];
}

const HIGH_VALUE = 25000; // BDT threshold for large-amount escalation

/** §6.4 — case_type detection. Order = priority (most specific/dangerous first). */
export function detectCaseType(
  norm: Normalized,
  s: ClaimSignals,
): { case_type: CaseType; codes: string[] } {
  const text = norm.text;
  const has = (...k: string[]) => k.some((x) => text.includes(x));
  const codes: string[] = [];

  // phishing — highest priority, safety critical
  if (
    has("credential", "credential_request", "phishing", "suspicious") ||
    (has("pin", "otp", "password") && has("suspicious", "call", "sms", "asking"))
  ) {
    codes.push("phishing_signal");
    return { case_type: "phishing_or_social_engineering", codes };
  }

  // duplicate / charged twice
  if (s.statusClaims.includes("charged_twice") || has("duplicate")) {
    codes.push("duplicate_charge");
    return { case_type: "duplicate_payment", codes };
  }

  // payment failed but balance deducted
  if (
    s.statusClaims.includes("failed") &&
    (s.statusClaims.includes("deducted") || has("deducted"))
  ) {
    codes.push("failed_but_deducted");
    return { case_type: "payment_failed", codes };
  }

  // wrong / unknown recipient
  if (norm.tokens.includes("wrong_recipient") || has("wrong_recipient")) {
    codes.push("wrong_transfer");
    return { case_type: "wrong_transfer", codes };
  }

  // merchant settlement delay
  if (
    s.typeIntents.includes("settlement") ||
    (has("merchant") && (has("settlement") || has("not_received")))
  ) {
    codes.push("settlement_delay");
    return { case_type: "merchant_settlement_delay", codes };
  }

  // agent cash-in not reflected
  if (
    s.typeIntents.includes("cash_in") ||
    (has("agent") && (has("not_received") || has("balance")))
  ) {
    codes.push("agent_cash_in");
    return { case_type: "agent_cash_in_issue", codes };
  }

  // generic refund / money back
  if (s.typeIntents.includes("refund") || has("refund")) {
    codes.push("refund_request");
    return { case_type: "refund_request", codes };
  }

  // payment failed (no explicit deduction) still maps here
  if (s.statusClaims.includes("failed")) {
    codes.push("payment_failed");
    return { case_type: "payment_failed", codes };
  }

  codes.push("no_clear_signal");
  return { case_type: "other", codes };
}

/** §6.5 — department routing. */
export function routeDepartment(
  caseType: CaseType,
  verdict: EvidenceResult["evidence_verdict"],
): Department {
  switch (caseType) {
    case "wrong_transfer":
      return "dispute_resolution";
    case "payment_failed":
    case "duplicate_payment":
      return "payments_ops";
    case "merchant_settlement_delay":
      return "merchant_operations";
    case "agent_cash_in_issue":
      return "agent_operations";
    case "phishing_or_social_engineering":
      return "fraud_risk";
    case "refund_request":
      // contested refund -> dispute_resolution; plain/low -> customer_support
      return verdict === "inconsistent" ? "dispute_resolution" : "customer_support";
    case "other":
    default:
      return "customer_support";
  }
}

/** §6.6 — severity + escalation. */
export function assessSeverity(
  caseType: CaseType,
  verdict: EvidenceResult["evidence_verdict"],
  s: ClaimSignals,
): { severity: Severity; human_review_required: boolean; codes: string[] } {
  const codes: string[] = [];
  const largeAmount = s.amounts.some((a) => a >= HIGH_VALUE);
  if (largeAmount) codes.push("high_value");

  // critical: phishing/fraud, account-takeover, large amounts
  if (caseType === "phishing_or_social_engineering") {
    codes.push("fraud_escalation");
    return { severity: "critical", human_review_required: true, codes };
  }
  if (largeAmount) {
    return { severity: "critical", human_review_required: true, codes };
  }

  // high: wrong_transfer, disputes, deducted-but-failed
  if (
    caseType === "wrong_transfer" ||
    caseType === "payment_failed" ||
    verdict === "inconsistent"
  ) {
    codes.push("dispute_or_failure");
    return { severity: "high", human_review_required: true, codes };
  }

  // any insufficient_data verdict -> escalate (rule of restraint)
  if (verdict === "insufficient_data") {
    codes.push("insufficient_data_escalation");
    return { severity: "medium", human_review_required: true, codes };
  }

  // medium: refund, settlement delay, duplicate (usually true)
  if (
    caseType === "refund_request" ||
    caseType === "merchant_settlement_delay" ||
    caseType === "duplicate_payment" ||
    caseType === "agent_cash_in_issue"
  ) {
    return { severity: "medium", human_review_required: true, codes };
  }

  // low: vague / other / informational
  return { severity: "low", human_review_required: false, codes };
}

/** Confidence calibrated to evidence strength (§10.5). */
export function calcConfidence(
  verdict: EvidenceResult["evidence_verdict"],
  topScore: number,
): number {
  if (verdict === "insufficient_data") return 0.4;
  // strong unique match -> high; weaker -> mid
  if (topScore >= 6) return 0.92;
  if (topScore >= 4) return 0.85;
  return 0.7;
}

/** Full classification pipeline. */
export function classify(
  norm: Normalized,
  evidence: EvidenceResult,
): Classification {
  const { case_type, codes: caseCodes } = detectCaseType(norm, evidence.signals);
  const department = routeDepartment(case_type, evidence.evidence_verdict);
  const { severity, human_review_required, codes: sevCodes } = assessSeverity(
    case_type,
    evidence.evidence_verdict,
    evidence.signals,
  );

  const topScore = evidence.candidates.reduce(
    (mx, c) => Math.max(mx, c.score),
    0,
  );
  const confidence = calcConfidence(evidence.evidence_verdict, topScore);

  const reason_codes = [
    ...caseCodes,
    ...sevCodes,
    evidence.relevant_transaction_id ? "transaction_match" : "no_transaction_match",
    evidence.evidence_verdict,
  ];

  return {
    case_type,
    department,
    severity,
    human_review_required,
    confidence,
    reason_codes: [...new Set(reason_codes)],
  };
}
