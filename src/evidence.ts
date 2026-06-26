import {
  Transaction,
  txnId,
  txnAmount,
  EVIDENCE_VERDICTS,
} from "./schema.js";
import { Normalized } from "./normalize.js";

export type EvidenceVerdict = (typeof EVIDENCE_VERDICTS)[number];

export interface ClaimSignals {
  amounts: number[];
  counterpartyHints: string[]; // phone fragments / merchant-agent mentions
  typeIntents: string[]; // send/transfer, pay, cash_in/out, refund, settlement
  statusClaims: string[]; // failed, deducted, not_received, charged_twice
  timeRefs: string[];
}

export interface CandidateScore {
  transaction_id: string | null;
  score: number;
  reasons: string[];
}

export interface EvidenceResult {
  relevant_transaction_id: string | null;
  evidence_verdict: EvidenceVerdict;
  matched: Transaction | null;
  signals: ClaimSignals;
  candidates: CandidateScore[];
  threshold: number;
  matchReason: string;
  verdictReason: string;
}

// Score weights (§6.2)
const W_AMOUNT = 4; // strong
const W_COUNTERPARTY = 4; // strong
const W_TYPE = 2; // medium
const W_TIME = 1; // weak
const MATCH_THRESHOLD = 3; // must clear to be picked

/** §6.1 — extract claim signals from normalized complaint text. */
export function extractSignals(norm: Normalized): ClaimSignals {
  const text = norm.text;

  // amounts: numbers near money words, or any standalone number >= 10
  const amounts: number[] = [];
  const amountRe = /(\d[\d,]*(?:\.\d+)?)\s*(?:tk|tka|taka|৳|bdt|money)?/gi;
  let m: RegExpExecArray | null;
  while ((m = amountRe.exec(text)) !== null) {
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n >= 10) amounts.push(n);
  }

  // counterparty hints: phone fragments (4+ consecutive digits inside a longer
  // number) and explicit number-like tokens. bKash numbers are 11 digits.
  const counterpartyHints: string[] = [];
  const phoneRe = /\b(\d{4,})\b/g;
  while ((m = phoneRe.exec(text)) !== null) {
    if (m[1].length >= 6) counterpartyHints.push(m[1]);
  }

  // type intents from canonical tokens + raw english
  const typeIntents: string[] = [];
  const has = (...keys: string[]) => keys.some((k) => text.includes(k));
  if (has("transfer", "send money", "sent")) typeIntents.push("transfer");
  if (has("pay", "payment", "merchant")) typeIntents.push("payment");
  if (has("cash in", "cashin", "cash_in", "agent")) typeIntents.push("cash_in");
  if (has("cash out", "cashout", "cash_out")) typeIntents.push("cash_out");
  if (has("refund")) typeIntents.push("refund");
  if (has("settlement", "settle", "payout")) typeIntents.push("settlement");

  // status claims
  const statusClaims: string[] = [];
  if (has("failed", "fail")) statusClaims.push("failed");
  if (has("deducted", "deduct", "cut")) statusClaims.push("deducted");
  if (has("not_received", "not received", "didn't receive", "did not receive"))
    statusClaims.push("not_received");
  if (has("duplicate", "twice", "double")) statusClaims.push("charged_twice");

  // time refs
  const timeRefs: string[] = [];
  const timeRe = /\b(\d{1,2}\s?(?:am|pm))\b|\b(today|yesterday|kalke|aaj|time_ref)\b/gi;
  while ((m = timeRe.exec(text)) !== null) timeRefs.push(m[0].trim());

  return {
    amounts: [...new Set(amounts)],
    counterpartyHints: [...new Set(counterpartyHints)],
    typeIntents: [...new Set(typeIntents)],
    statusClaims: [...new Set(statusClaims)],
    timeRefs: [...new Set(timeRefs)],
  };
}

function txnText(t: Transaction): string {
  return JSON.stringify(t).toLowerCase();
}

function txnTypeMatches(t: Transaction, intents: string[]): boolean {
  const type = (t.type ?? "").toLowerCase();
  const map: Record<string, string[]> = {
    transfer: ["transfer", "send", "send_money", "sendmoney", "p2p"],
    payment: ["payment", "pay", "merchant", "purchase"],
    cash_in: ["cash_in", "cashin", "cash in", "deposit"],
    cash_out: ["cash_out", "cashout", "cash out", "withdraw"],
    refund: ["refund", "reversal"],
    settlement: ["settlement", "settle", "payout", "disbursement"],
  };
  return intents.some((i) => (map[i] ?? [i]).some((k) => type.includes(k)));
}

/** §6.2 — score each transaction against the signals. */
export function scoreTransactions(
  txns: Transaction[],
  s: ClaimSignals,
): CandidateScore[] {
  return txns.map((t) => {
    const reasons: string[] = [];
    let score = 0;
    const tAmount = txnAmount(t);
    const tText = txnText(t);

    if (tAmount !== undefined && s.amounts.length) {
      const exact = s.amounts.some((a) => a === tAmount);
      const close = s.amounts.some(
        (a) => Math.abs(a - tAmount) / Math.max(a, tAmount) <= 0.01,
      );
      if (exact || close) {
        score += W_AMOUNT;
        reasons.push(`amount match ${tAmount}`);
      }
    }

    if (s.counterpartyHints.length) {
      const hit = s.counterpartyHints.find((h) => tText.includes(h));
      if (hit) {
        score += W_COUNTERPARTY;
        reasons.push(`counterparty fragment ${hit}`);
      }
    }

    if (s.typeIntents.length && txnTypeMatches(t, s.typeIntents)) {
      score += W_TYPE;
      reasons.push(`type intent ${t.type ?? "?"}`);
    }

    if (s.timeRefs.length) {
      const stamp = (t.timestamp ?? t.time ?? t.date ?? "").toLowerCase();
      if (stamp && s.timeRefs.some((tr) => stamp.includes(tr.replace(/\s/g, ""))))
        {
        score += W_TIME;
        reasons.push("time proximity");
      }
    }

    return { transaction_id: txnId(t), score, reasons };
  });
}

/**
 * Does the matched transaction's data contradict the customer's story?
 * Drives consistent vs inconsistent (§6.3).
 */
function contradicts(t: Transaction, s: ClaimSignals): string | null {
  const status = (t.status ?? "").toLowerCase();
  const completed = /complete|success|successful|done|settled|paid/.test(status);
  const failed = /fail|declined|reversed|cancel/.test(status);

  // "failed but money deducted" yet txn completed
  if (s.statusClaims.includes("failed") && completed)
    return "complaint says failed but transaction status is completed";

  // "I never sent this / not received" yet a clear completed transfer matches
  if (s.statusClaims.includes("not_received") && completed)
    return "complaint says not received but transaction status is completed";

  // claim of deduction with a failed txn is actually consistent, not a contradiction
  // claim says completed-success but txn failed -> contradiction
  if (
    s.statusClaims.includes("failed") &&
    failed &&
    s.statusClaims.includes("deducted")
  )
    return null; // failed + deducted is a genuine payment_failed, supports story

  return null;
}

/** Does the data support the story? Drives consistent (§6.3). */
function supports(t: Transaction, s: ClaimSignals): boolean {
  const status = (t.status ?? "").toLowerCase();
  const completed = /complete|success|successful|done|settled|paid/.test(status);
  const failed = /fail|declined|reversed|cancel/.test(status);

  // wrong transfer: a completed transfer to the (wrong) number supports it
  if (s.typeIntents.includes("transfer") && completed) return true;
  // payment_failed claim + failed status supports
  if (s.statusClaims.includes("failed") && failed) return true;
  // generic: a matched completed txn the customer is asking about
  if (completed && !s.statusClaims.includes("failed")) return true;
  return false;
}

/** §6.3 — decide the verdict from the best candidate. */
export function decideVerdict(
  best: { txn: Transaction; score: CandidateScore } | null,
  s: ClaimSignals,
): { verdict: EvidenceVerdict; reason: string } {
  if (!best || best.score.score < MATCH_THRESHOLD) {
    return {
      verdict: "insufficient_data",
      reason:
        "no transaction cleared the match threshold (empty/ambiguous history)",
    };
  }
  const contra = contradicts(best.txn, s);
  if (contra) return { verdict: "inconsistent", reason: contra };
  if (supports(best.txn, s))
    return {
      verdict: "consistent",
      reason: "matched transaction status/details support the claim",
    };
  // matched entity but neither clearly supports nor contradicts -> restraint
  return {
    verdict: "insufficient_data",
    reason: "matched transaction but evidence neither supports nor contradicts",
  };
}

/** Full evidence pipeline (§6). */
export function investigate(
  txns: Transaction[],
  norm: Normalized,
): EvidenceResult {
  const signals = extractSignals(norm);

  if (!txns.length) {
    return {
      relevant_transaction_id: null,
      evidence_verdict: "insufficient_data",
      matched: null,
      signals,
      candidates: [],
      threshold: MATCH_THRESHOLD,
      matchReason: "transaction history empty or absent",
      verdictReason: "no history to investigate against",
    };
  }

  const candidates = scoreTransactions(txns, signals);
  let bestIdx = -1;
  let bestScore = -1;
  candidates.forEach((c, i) => {
    if (c.score > bestScore) {
      bestScore = c.score;
      bestIdx = i;
    }
  });

  const cleared = bestScore >= MATCH_THRESHOLD;
  const best = cleared
    ? { txn: txns[bestIdx], score: candidates[bestIdx] }
    : null;

  const { verdict, reason } = decideVerdict(best, signals);

  return {
    relevant_transaction_id: best ? best.score.transaction_id : null,
    evidence_verdict: verdict,
    matched: best ? best.txn : null,
    signals,
    candidates,
    threshold: MATCH_THRESHOLD,
    matchReason: best
      ? `picked ${best.score.transaction_id} (score ${best.score.score}): ${best.score.reasons.join(", ")}`
      : `top score ${bestScore} below threshold ${MATCH_THRESHOLD}`,
    verdictReason: reason,
  };
}
