// Fuzzy text comparison for round-trip verification. ASR output won't be
// character-perfect (casing, punctuation, the odd substitution), so we compare
// at the word level after normalizing.

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeForCompare(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(s) {
  const n = normalizeForCompare(s);
  return n ? n.split(" ") : [];
}

/**
 * Recall-style match: fraction of the expected words that appear in the heard
 * transcript (multiset-aware so duplicate words must actually recur).
 * @returns {{ratio:number, matched:number, total:number, missing:string[]}}
 */
export function wordMatchRatio(expected, heard) {
  const exp = tokens(expected);
  if (exp.length === 0) return { ratio: 1, matched: 0, total: 0, missing: [] };

  const pool = new Map();
  for (const w of tokens(heard)) pool.set(w, (pool.get(w) ?? 0) + 1);

  let matched = 0;
  const missing = [];
  for (const w of exp) {
    const c = pool.get(w) ?? 0;
    if (c > 0) {
      matched++;
      pool.set(w, c - 1);
    } else {
      missing.push(w);
    }
  }
  return { ratio: matched / exp.length, matched, total: exp.length, missing };
}
