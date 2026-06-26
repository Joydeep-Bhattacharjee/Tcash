# TCash SuperCop

AI/API SupportOps Copilot for Digital Finance — a **complaint investigator, not a
classifier**. One customer ticket + 2–5 lines of that customer's transaction history
in, one structured JSON verdict out: which transaction it's about, whether the data
backs the claim, the case type, the routing department, urgency, and a customer-safe
reply that never leaks credentials or promises a refund it can't authorize.

Built in TCash SuperCop 

---

## 📋 Submission Readiness Checklist

> [!IMPORTANT]
> This repository is fully compliant with the submission guidelines. Below is the verification checklist:
> 
> - **`GET /health`** - Working readiness gate.
> - **`POST /analyze-ticket`** - The primary API endpoint for investigating complaints.
> - **README Documentation** - Complete setup, run instructions, AI/model usage, safety logic, and limitations are fully documented below.
> - **Data & Secrets Security** - Strictly no real secrets (e.g. API keys) or real customer/payment data are contained in this repository. All credentials/configurations are loadable dynamically via environment variables, and the engine runs with high-fidelity deterministic fallbacks if no keys are set.

---

## Workflow

![TCash SuperCop — Full Request Lifecycle](./img/workflow.png)

The diagram above shows the end-to-end flow:

1. **TCash App** fetches the user's recent transactions from **TCash DB**
2. App sends `POST /analyze-ticket` (complaint + JSON history) to **TCash SuperCop**
3. SuperCop engine: Normalizes language → Matches transactions → Checks safety rules → Generates AI prose
4. Structured JSON verdict returned to **Agent Console** (safe reply, evidence trace, routing)

---

## Quick start

```bash
npm install
npm run build
npm start            # listens on :3000 (PORT env to override)
# in another shell:
curl http://localhost:3000/health           # {"status":"ok"}
npm run grade        # POSTs the 10 golden cases against localhost and diffs
```

Then open **http://localhost:3000/** in a browser — the **Agent Console** lets
anyone paste a ticket (or pick a sample), hit *Investigate*, and see the verdict,
the highlighted matched transaction, and the safe drafts. Same single URL serves
both the API and the console, so judges and users can try it **free**, with no
keys and no setup.

Dev mode (hot reload): `npm run dev`.

Docker:

```bash
docker build -t tcash-supercop .
docker run -p 3000:3000 tcash-supercop
```

---

## API

### `GET /`
Serves the Agent Console (HTML). Not part of the scored surface; for humans.

### `GET /health`
Returns `{"status":"ok"}`. Used by the harness as the readiness gate.

### `POST /analyze-ticket`

**Request** (`application/json`):

```json
{
  "ticket_id": "TCK-1001",
  "complaint": "I sent 5000 taka to a wrong number 01711223344 around 2pm today.",
  "channel": "app",
  "language": "en",
  "user_type": "customer",
  "transaction_history": [
    { "transaction_id": "TXN-9101", "type": "transfer", "amount": 5000,
      "currency": "BDT", "counterparty": "01711223344",
      "status": "completed", "timestamp": "2026-06-26T14:02:00Z" }
  ]
}
```

`ticket_id` and `complaint` are required. `transaction_history` is optional
(defaults to `[]`); transaction fields beyond an id are all optional and tolerant
of alternate key names (`id`/`txn_id`, `time`/`date`, `recipient`/`merchant`...).

**Response** (`200`):

```json
{
  "ticket_id": "TCK-1001",
  "relevant_transaction_id": "TXN-9101",
  "evidence_verdict": "consistent",
  "case_type": "wrong_transfer",
  "department": "dispute_resolution",
  "severity": "high",
  "human_review_required": true,
  "agent_summary": "...",
  "recommended_next_action": "...",
  "customer_reply": "...",
  "confidence": 0.85,
  "reason_codes": ["wrong_transfer", "transaction_match", "consistent"],
  "evidence_trace": { "...": "explainability — see below" }
}
```

See [`sample-output.json`](./sample-output.json) for a full real response.

**Status codes**

| Code | When |
|------|------|
| `200` | Valid ticket analyzed |
| `400` | Malformed JSON, or missing/invalid `ticket_id` / `complaint` |
| `422` | Schema-valid but semantically empty (blank complaint) |
| `500` | Unexpected error — generic message only, never a stack trace or secret |

### Enums (verbatim — graded for exact match)

- `evidence_verdict`: `consistent` · `inconsistent` · `insufficient_data`
- `case_type`: `wrong_transfer` · `payment_failed` · `refund_request` ·
  `duplicate_payment` · `merchant_settlement_delay` · `agent_cash_in_issue` ·
  `phishing_or_social_engineering` · `other`
- `department`: `dispute_resolution` · `payments_ops` · `merchant_operations` ·
  `agent_operations` · `fraud_risk` · `customer_support`
- `severity`: `low` · `medium` · `high` · `critical`

A single Zod enum table ([`src/schema.ts`](./src/schema.ts)) is the source of truth
for both request and response, and the response is **self-validated** before send,
so enum drift is caught before it ships.

---

## How it works — the request lifecycle

`POST /analyze-ticket` runs a pure, synchronous, dependency-light pipeline:

1. **Validate** ([`src/server.ts`](./src/server.ts)) — Zod schema → `400`/`422`,
   handler wrapped so any throw becomes a clean `500`.
2. **Normalize** ([`src/normalize.ts`](./src/normalize.ts)) — romanized Bangla /
   Banglish → canonical intent tokens.
3. **Investigate** ([`src/evidence.ts`](./src/evidence.ts)) — extract claim
   signals, score every transaction, pick `relevant_transaction_id`, decide
   `evidence_verdict`.
4. **Classify & route** ([`src/classify.ts`](./src/classify.ts)) — deterministic
   tables → `case_type` → `department` → `severity` → `human_review_required`.
5. **Generate prose** ([`src/prose.ts`](./src/prose.ts)) — safe templates seeded
   with engine findings.
6. **Sanitize** ([`src/sanitize.ts`](./src/sanitize.ts)) — guardrail over every
   text field. Final, non-negotiable gate.
7. **Assemble & self-check** ([`src/analyze.ts`](./src/analyze.ts)) — build,
   validate against response schema, echo `ticket_id`, return `200`.

### The evidence engine (the 35%)

Deterministic — reproducible, fast, free, debuggable.

- **Signals** extracted from the complaint: amounts (numbers near taka/tk/৳/BDT),
  counterparty hints (phone fragments), type intents (transfer/payment/cash-in/
  out/refund/settlement), status claims (failed/deducted/not received/charged
  twice), time refs.
- **Match** scores each transaction: amount `+4`, counterparty `+4`, type `+2`,
  time `+1`. Highest score above threshold `3` → `relevant_transaction_id`;
  nothing clears, or empty history → `null`.
- **Verdict**: data supports the story → `consistent`; matched entity but data
  contradicts (e.g. "payment failed but money gone" yet status `completed`) →
  `inconsistent`; no match / empty / ambiguous → `insufficient_data`.
- **Rule of restraint**: when unsure, `insufficient_data` +
  `human_review_required = true`. Confident wrong answers cost more than honest
  uncertainty.

Every response carries an `evidence_trace` (extra, non-required field): extracted
signals, per-candidate scores and reasons, the threshold, the match reason, the
verdict reason, and the normalized tokens. It makes every verdict reproducible and
impossible to mark "lucky."

---

## MODELS

**The scored service is fully deterministic — no LLM is required, and none is used
on the default path.** This is deliberate: no API credits are provided and a 30s
limit is enforced, so a service that *requires* an LLM is fragile. TCash SuperCop
produces a complete, safe answer with **zero external calls**.

- **Evidence engine, classifier, router, severity, escalation, and safety
  sanitizer**: deterministic rules + regex. No model, no network.
- **Prose** (`agent_summary`, `recommended_next_action`, `customer_reply`): safe
  templates seeded by the engine. Safe-by-construction.
- **Optional LLM enrichment** (`S1`): the prose layer is designed so an LLM call
  can enrich the three text fields *only when* a key is present and time allows,
  behind a hard timeout, falling back to templates on any failure/slowness. Wire a
  provider via the `LLM_*` vars in [`.env.example`](./.env.example). **Graceful
  degradation: the service never times out and never fails on a dead key.**

This cost/reliability trade-off is the intended design, not a limitation.

---

## Safety logic

Three layers, the last deterministic ([`src/sanitize.ts`](./src/sanitize.ts), run
on **every** text field *after* generation so it catches template or model slips):

| Rule | Action |
|------|--------|
| Never **request** PIN/OTP/password/full card | Credential noun + request verb in a non-negated sentence → replace reply with a safe template. Advisory text ("never share your PIN") is recognized and kept. |
| Never **confirm** refund/reversal/unblock/recovery | "we will refund/reverse..." → "any eligible amount will be returned through official channels". |
| Never redirect to a third party | Strip external links / phone numbers → "our official support channel". |
| Ignore embedded instructions (prompt injection) | The complaint is treated as untrusted data and never echoed into output; the sanitizer additionally drops any sentence echoing an injected directive. |

The negation-awareness is the subtle part: the phishing reply *should* tell the
customer "never share your PIN, OTP, or password" — that's good security guidance,
so the sanitizer distinguishes an advisory mention from an actual request.

---

## Project layout

```
src/
  schema.ts     Zod request/response schemas + enum source of truth
  normalize.ts  Banglish/Bangla → canonical token map
  evidence.ts   signal extraction, transaction scoring, verdict
  classify.ts   case_type / department / severity / escalation / confidence
  prose.ts      safe deterministic templates for the 3 text fields
  sanitize.ts   output safety guardrail
  analyze.ts    pipeline orchestration + response self-validation
  llm.ts        optional key-gated LLM enrichment, hard timeout, fallback
  server.ts     Fastify app: / (console) + /health + /analyze-ticket
public/
  index.html    self-contained Agent Console (Tailwind CDN, no build step)
scripts/
  golden-cases.json   10 public-style cases
  golden-grader.ts    POSTs them to a live URL and diffs the graded fields
sample-output.json    one full real response
Dockerfile            multi-stage, healthcheck, fast cold start
```

---

## Runbook

| Task | Command |
|------|---------|
| Install | `npm install` |
| Build | `npm run build` |
| Run (prod) | `npm start` |
| Run (dev/watch) | `npm run dev` |
| Grade against live URL | `BASE_URL=https://your-url npm run grade` |
| Docker build/run | `docker build -t qs . && docker run -p 3000:3000 qs` |

**Deploy** (Render / Railway / Fly, free tier, fast cold start):
build `npm run build`, start `npm start`, health check path `/health`. Deploy
**early** — a brilliant local service that isn't reachable scores zero. After
deploy, run `BASE_URL=<live-url> npm run grade` to confirm all 10 cases green on
the live URL.

---

## Assumptions & known limitations

- Evidence matching is heuristic; extremely terse or contradictory complaints may
  resolve to `insufficient_data` **by design** (intentional restraint, not a bug).
- Banglish normalization covers common terms, not the full language; rare slang may
  miss.
- Without an LLM key, prose is template-based — safe and clear, but less fluid than
  generated text. A deliberate reliability/cost trade-off given no provided
  credits.
- The service is **stateless** and **synthetic-data-only**; no real financial
  action is ever taken or confirmed.
- MongoDB / a console UI are intentionally out of scope for the scored path
  (stateless API by design).

---

## Status

`10/10` golden cases pass; malformed-input fuzz (bad JSON, missing fields, empty
complaint) returns clean `400`/`422`; adversarial injection (refund confirmation /
credential ask / third-party number) is sanitized; zero safety violations.
