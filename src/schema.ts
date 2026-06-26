import { z } from "zod";

/**
 * Enum single-source-of-truth. Every string here is graded verbatim (M7).
 * Do not pluralize, recase, or reword.
 */
export const EVIDENCE_VERDICTS = [
  "consistent",
  "inconsistent",
  "insufficient_data",
] as const;

export const CASE_TYPES = [
  "wrong_transfer",
  "payment_failed",
  "refund_request",
  "duplicate_payment",
  "merchant_settlement_delay",
  "agent_cash_in_issue",
  "phishing_or_social_engineering",
  "other",
] as const;

export const DEPARTMENTS = [
  "dispute_resolution",
  "payments_ops",
  "merchant_operations",
  "agent_operations",
  "fraud_risk",
  "customer_support",
] as const;

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;

/**
 * Transaction line. All fields beyond an identifier are optional so the engine
 * tolerates sparse / messy synthetic history without crashing.
 */
export const TransactionSchema = z
  .object({
    transaction_id: z.string().optional(),
    id: z.string().optional(),
    txn_id: z.string().optional(),
    type: z.string().optional(),
    amount: z.union([z.number(), z.string()]).optional(),
    currency: z.string().optional(),
    counterparty: z.string().optional(),
    counterparty_number: z.string().optional(),
    recipient: z.string().optional(),
    merchant: z.string().optional(),
    status: z.string().optional(),
    timestamp: z.string().optional(),
    time: z.string().optional(),
    date: z.string().optional(),
  })
  .passthrough();

export type Transaction = z.infer<typeof TransactionSchema>;

/**
 * Request contract. Mirrors §5.2 step 1.
 * Missing ticket_id / complaint -> 400 (enforced by this schema).
 */
export const RequestSchema = z
  .object({
    ticket_id: z.string({ required_error: "ticket_id is required" }),
    complaint: z.string({ required_error: "complaint is required" }),
    transaction_history: z.array(TransactionSchema).optional().default([]),
    channel: z.string().optional(),
    language: z.string().optional(),
    user_type: z.string().optional(),
    customer_id: z.string().optional(),
  })
  .passthrough();

export type TicketRequest = z.infer<typeof RequestSchema>;

/**
 * Evidence trace — extra, non-required explainability field (N3 / §10).
 * Harmless to harness, centerpiece for manual review + video.
 */
export const EvidenceTraceSchema = z.object({
  extracted_signals: z.object({
    amounts: z.array(z.number()),
    counterparty_hints: z.array(z.string()),
    type_intents: z.array(z.string()),
    status_claims: z.array(z.string()),
    time_refs: z.array(z.string()),
  }),
  candidate_scores: z.array(
    z.object({
      transaction_id: z.string().nullable(),
      score: z.number(),
      reasons: z.array(z.string()),
    }),
  ),
  threshold: z.number(),
  match_reason: z.string(),
  verdict_reason: z.string(),
  normalized_tokens: z.array(z.string()),
});

/**
 * Response contract. Self-validated before send (§5.2 step 7) so enum drift
 * is caught before it ships.
 */
export const ResponseSchema = z.object({
  ticket_id: z.string(),
  relevant_transaction_id: z.string().nullable(),
  evidence_verdict: z.enum(EVIDENCE_VERDICTS),
  case_type: z.enum(CASE_TYPES),
  department: z.enum(DEPARTMENTS),
  severity: z.enum(SEVERITIES),
  human_review_required: z.boolean(),
  agent_summary: z.string(),
  recommended_next_action: z.string(),
  customer_reply: z.string(),
  confidence: z.number(),
  reason_codes: z.array(z.string()),
  evidence_trace: EvidenceTraceSchema,
});

export type TicketResponse = z.infer<typeof ResponseSchema>;

/** Pull a stable id off a transaction regardless of which key the source used. */
export function txnId(t: Transaction): string | null {
  return t.transaction_id ?? t.id ?? t.txn_id ?? null;
}

/** Coerce amount to number; undefined if unparseable. */
export function txnAmount(t: Transaction): number | undefined {
  if (typeof t.amount === "number") return t.amount;
  if (typeof t.amount === "string") {
    const n = Number(t.amount.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
