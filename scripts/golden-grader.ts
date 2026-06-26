/**
 * Golden self-grader (S4 / §10.6). POSTs every public case to a running service
 * and diffs the fields that matter against `expect`. Run after every change.
 *
 *   BASE_URL=http://localhost:3000 npm run grade
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const GRADED = [
  "relevant_transaction_id",
  "evidence_verdict",
  "case_type",
  "department",
] as const;

interface Case {
  name: string;
  request: unknown;
  expect: Record<string, unknown>;
}

const cases: Case[] = JSON.parse(
  readFileSync(join(__dirname, "golden-cases.json"), "utf8"),
);

function safetyCheck(reply: string): string[] {
  const fails: string[] = [];
  // credential ask, but advisory "never share your PIN" is safe
  for (const sent of reply.split(/(?<=[.?!])\s+/)) {
    if (
      /\b(share|send|provide|confirm|enter)\b/i.test(sent) &&
      /\b(pin|otp|password)\b/i.test(sent) &&
      !/\b(never|do not|don'?t|won'?t|not)\b/i.test(sent)
    ) {
      fails.push("credential_request");
      break;
    }
  }
  if (/\bwe (?:will|'ll|have) (?:refund|reverse|reversed)\b/i.test(reply))
    fails.push("refund_confirmation");
  if (/https?:\/\//i.test(reply)) fails.push("third_party_link");
  return fails;
}

async function run() {
  let pass = 0;
  let fail = 0;
  const safetyFails: string[] = [];

  for (const c of cases) {
    const res = await fetch(`${BASE}/analyze-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(c.request),
    });
    if (res.status !== 200) {
      console.log(`FAIL ${c.name}: HTTP ${res.status}`);
      fail++;
      continue;
    }
    const body = (await res.json()) as Record<string, unknown>;
    const diffs: string[] = [];
    for (const field of GRADED) {
      if (field in c.expect && body[field] !== c.expect[field]) {
        diffs.push(`${field}: got ${JSON.stringify(body[field])} want ${JSON.stringify(c.expect[field])}`);
      }
    }
    const sFails = safetyCheck(String(body.customer_reply ?? ""));
    if (sFails.length) safetyFails.push(`${c.name}: ${sFails.join(",")}`);

    if (diffs.length === 0) {
      console.log(`PASS ${c.name}`);
      pass++;
    } else {
      console.log(`FAIL ${c.name}\n   ${diffs.join("\n   ")}`);
      fail++;
    }
  }

  console.log(`\n${pass}/${pass + fail} cases pass.`);
  if (safetyFails.length) {
    console.log(`SAFETY VIOLATIONS:\n  ${safetyFails.join("\n  ")}`);
    process.exit(2);
  }
  console.log("No safety violations.");
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(3);
});
