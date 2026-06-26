import { TicketRequest, TicketResponse, ResponseSchema } from "./schema.js";
import { normalize } from "./normalize.js";
import { investigate } from "./evidence.js";
import { classify } from "./classify.js";
import { generateProse } from "./prose.js";
import { enrichProse } from "./llm.js";
import { sanitize } from "./sanitize.js";

/**
 * Core request pipeline (§5.2 steps 2–7). Pure + synchronous + deterministic.
 * No LLM dependency on this path; prose comes from safe templates.
 */
export async function analyzeTicket(req: TicketRequest): Promise<TicketResponse> {
  // Step 2 — normalize (bn/banglish -> canonical tokens)
  const norm = normalize(req.complaint);

  // Step 3 — investigate
  const evidence = investigate(req.transaction_history ?? [], norm);

  // Step 4 — classify + route + severity + escalation
  const cls = classify(norm, evidence);

  // Step 5 — generate prose (deterministic templates), optionally enriched by
  // an LLM when a key is present and time allows; falls back to templates on
  // no-key / timeout / error / bad shape.
  const prose = generateProse(evidence, cls);
  const enriched = await enrichProse(req, evidence, cls, prose);

  // Step 6 — sanitize (final safety gate; runs AFTER enrichment to catch slips)
  const safe = sanitize(enriched);
  const reasonCodes = [...cls.reason_codes];
  if (safe.violations.length)
    reasonCodes.push(...safe.violations.map((x) => `sanitized:${x}`));

  // Step 7 — assemble + self-validate against response schema
  const response: TicketResponse = {
    ticket_id: req.ticket_id,
    relevant_transaction_id: evidence.relevant_transaction_id,
    evidence_verdict: evidence.evidence_verdict,
    case_type: cls.case_type,
    department: cls.department,
    severity: cls.severity,
    human_review_required: cls.human_review_required,
    agent_summary: safe.prose.agent_summary,
    recommended_next_action: safe.prose.recommended_next_action,
    customer_reply: safe.prose.customer_reply,
    confidence: cls.confidence,
    reason_codes: [...new Set(reasonCodes)],
    evidence_trace: {
      extracted_signals: {
        amounts: evidence.signals.amounts,
        counterparty_hints: evidence.signals.counterpartyHints,
        type_intents: evidence.signals.typeIntents,
        status_claims: evidence.signals.statusClaims,
        time_refs: evidence.signals.timeRefs,
      },
      candidate_scores: evidence.candidates,
      threshold: evidence.threshold,
      match_reason: evidence.matchReason,
      verdict_reason: evidence.verdictReason,
      normalized_tokens: norm.tokens,
    },
  };

  // Self-check: throws if enum drift / shape error slipped in. Caller turns a
  // throw into a clean 500 — never ships a malformed body.
  return ResponseSchema.parse(response);
}
