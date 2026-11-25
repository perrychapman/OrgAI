/**
 * Word sets for the skill checks and the run digest (store/runDigest.ts hashes tokenSet's words). A leaf module with no
 * imports, so the digest and evaluate.ts can both use it without an import cycle. evaluate.ts re-exports both functions.
 */

const STOPWORDS = new Set(
  ('a an the and or but of to in on for with at by from as is are was were be been it its this that these those you your we our they them their ' +
    'i me my can could should would will may might do does did done not no if then than so such into onto over under up down out about any all ' +
    'also just only more most other some each every which who whom what where how why there here has have had having use used using when whenever').split(' ')
)

/** Lowercased alphanumeric words minus stopwords, as a set. */
export function tokenSet(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w.length > 1 && !STOPWORDS.has(w)) out.add(w)
  return out
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const x of small) if (large.has(x)) inter++
  return inter / (a.size + b.size - inter)
}
