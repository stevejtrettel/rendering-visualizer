// Multiple importance sampling heuristics (Veach). Both pdfs must be in the
// SAME measure — for NEE/BSDF combination, solid angle at the scattering
// vertex. Weights for the two strategies sum to 1 by construction.

// Power heuristic, beta = 2 — Veach's empirically best default.
export function powerHeuristic(pdfThis: number, pdfOther: number): number {
  const f = pdfThis * pdfThis;
  const g = pdfOther * pdfOther;
  if (f + g === 0) return 0;
  return f / (f + g);
}
