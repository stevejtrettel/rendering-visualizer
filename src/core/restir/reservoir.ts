// Streaming weighted reservoir sampling with confidence weights (SIGGRAPH
// 2023 ReSTIR course, Algorithm 3; restir-notes.md §WRS). A reservoir holds
// ONE selected sample from a weighted candidate stream in O(1) state; RIS
// theory turns that selection into a sample whose pdf approaches the target
// p̂, carrying an unbiased contribution weight W with E[W | Y] = 1/p(Y) in
// place of the intractable pdf.
//
// Merging IS resampling: to merge reservoir r2 into r1, feed r2's sample as
// one weighted candidate — update(r2.y, m·p̂(r2.y)·r2.W, r2.confidence, u) —
// where m is the resampling MIS weight from mis.ts. There is deliberately no
// special merge method; one code path keeps the theory visible.
//
// Determinism: the reservoir draws nothing. Every stochastic decision takes
// an explicit uniform u ∈ [0, 1) supplied by the caller (the Sampler owns
// all randomness — V0 principle 2, unchanged in V4).
export class Reservoir<T> {
  // The selected sample; null = the null sample ∅ (all-zero-weight stream).
  y: T | null = null;
  wSum = 0;
  // Confidence c: an effective-sample-count proxy (a fresh candidate is 1;
  // aggregation sums; capped at finalize). Used by confidence-weighted MIS.
  confidence = 0;
  // Unbiased contribution weight of y, set by finalize(); 0 for null y.
  W = 0;

  // Consider one candidate with resampling weight w = m·p̂·W_candidate and
  // confidence c. Null candidates (failed shifts, zero-weight realizations)
  // still add their confidence — the DISTRIBUTION counts even when the
  // realization is null (course Tips 3.13-3.14).
  update(candidate: T | null, w: number, c: number, u: number): void {
    this.wSum += w;
    this.confidence += c;
    if (candidate !== null && w > 0 && u < w / this.wSum) {
      this.y = candidate;
    }
  }

  // Compute W = wSum / p̂(y) (eq 3.2) and cap the confidence. `pHatY` is the
  // target function evaluated at the selected sample; pass 0 for null y.
  finalize(pHatY: number, confidenceCap = Number.POSITIVE_INFINITY): void {
    this.W = this.y !== null && pHatY > 0 ? this.wSum / pHatY : 0;
    this.confidence = Math.min(this.confidence, confidenceCap);
  }
}
