/**
 * Banglish / Bangla normalization layer (S2 / §10.4).
 * Maps romanized Bangla, Bangla script, and mixed Banglish onto canonical
 * English intent tokens BEFORE rule matching, so the deterministic engine works
 * regardless of input language. Covers common terms, not the whole language.
 */

/** [pattern, canonical token]. Patterns are matched case-insensitively as words. */
const SYNONYMS: Array<[RegExp, string]> = [
  // money / amount
  [/\b(taka|tk|tka|৳|takay|takar)\b/gi, "money"],
  [/\bbdt\b/gi, "money"],

  // send / transfer
  [/\b(pathai?(?:lam|chi|si)?|pathiyechi|transfer|send\s?money|sendmoney|trnsfr)\b/gi, "transfer"],

  // wrong number / wrong recipient — Bangla vul/bhul stands alone; English
  // "wrong" must be followed by a recipient noun so "something is wrong with
  // my account" does NOT classify as a wrong transfer.
  [/\b(vul|bhul)\s*(number|nombor|num|nmbr|account|accnt)?\b/gi, "wrong_recipient"],
  [/\bwrong\s+(number|nombor|recipient|person|receiver|account\s?number)\b/gi, "wrong_recipient"],

  // deducted / cut from balance
  [/\b(kete\s?niyeche|kete\s?nise|deduct(?:ed)?|cut|kata|kete|balance\s?theke)\b/gi, "deducted"],

  // failed
  [/\b(fail(?:ed)?|hoy\s?nai|hoini|hyni|doibo|hocche\s?na|hochche\s?na|unsuccessful)\b/gi, "failed"],

  // not received / didn't get
  [/\b(pai\s?nai|paini|pelam\s?na|did\s?n?o?t\s?(?:receive|get)|receive\s?kori\s?nai|ase\s?nai|asheni)\b/gi, "not_received"],

  // refund / money back
  [/\b(refund|ferot|firiye|money\s?back|taka\s?ferot|ferot\s?chai|refund\s?chai)\b/gi, "refund"],

  // duplicate / twice
  [/\b(duplicate|dui\s?bar|duibar|twice|double\s?charge|dubar)\b/gi, "duplicate"],

  // OTP / PIN / password / credentials (phishing signal)
  [/\b(otp|pin|password|pass\s?word|verification\s?code|kod|code)\b/gi, "credential"],
  [/\b(otp\s?chaiche|pin\s?chaiche|chaiche|cheyeche)\b/gi, "credential_request"],

  // suspicious call / sms / fraud
  [/\b(suspicious|sondeho|fraud|protarona|prtarona|scam|fake\s?call|fake\s?sms|unknown\s?call)\b/gi, "suspicious"],

  // merchant / shop
  [/\b(merchant|dokan|dokaan|shop|store|payment\s?merchant)\b/gi, "merchant"],

  // settlement
  [/\b(settlement|settle|payout|disbursement)\b/gi, "settlement"],

  // agent cash in/out
  [/\b(agent|cash\s?in|cashin|cash\s?out|cashout|cash\s?in\s?kor)\b/gi, "agent"],

  // time refs
  [/\b(kalke|kal|aj|aaj|ajke|gotokal|ekhon|ekhun)\b/gi, "time_ref"],

  // complaint / problem
  [/\b(problem|somossa|shomosha|issue|jhamela)\b/gi, "problem"],
];

export interface Normalized {
  /** Lowercased original + appended canonical tokens, for keyword matching. */
  text: string;
  /** Distinct canonical tokens that fired. */
  tokens: string[];
}

/**
 * Returns the original text (lowercased) with canonical tokens appended, plus a
 * deduped token list. Appending (not replacing) keeps amounts/numbers/phone
 * fragments intact for the signal extractor.
 */
export function normalize(complaint: string): Normalized {
  const base = (complaint ?? "").toLowerCase();
  const tokens = new Set<string>();
  for (const [re, token] of SYNONYMS) {
    re.lastIndex = 0;
    if (re.test(base)) tokens.add(token);
  }
  const tokenList = [...tokens];
  return {
    text: tokenList.length ? `${base} ${tokenList.join(" ")}` : base,
    tokens: tokenList,
  };
}
