// Resampling MIS weights for reservoir reuse, identity-shift specialization
// (static scene, world-space light vertices: p̂_{←i} = p̂_i, Jacobian 1 —
// restir-notes §Reuse across domains). All functions are pure and operate on
// PRE-EVALUATED target values p̂_j(y) at the point y in question — the
// caller owns the (potentially expensive) shading evaluations.
//
// Contract (course eq 5.12): for any y with p̂ values as given and a
// canonical candidate with p̂_c(y) > 0, the weights over all candidates sum
// to 1 — asserted by misWeightSum in tests and behind debug flags.

// Confidence-weighted generalized balance heuristic (course eq 5.11):
//   m_i(y) = c_i·p̂_i(y) / Σ_j c_j·p̂_j(y).
// O(M) per weight, O(M²) for all — exact, the correctness reference.
export function balanceMisWeight(
  pHatAt: readonly number[], // p̂_j(y) for each candidate j
  confidences: readonly number[],
  i: number,
): number {
  const num = confidences[i]! * pHatAt[i]!;
  if (num === 0) return 0;
  let den = 0;
  for (let j = 0; j < pHatAt.length; j++) den += confidences[j]! * pHatAt[j]!;
  return num / den;
}

// Defensive pairwise MIS with confidence weights (course eq 7.8; Bitterli
// 2022). Each non-canonical candidate is weighted pairwise against the
// canonical only — O(1) per non-canonical weight — and the canonical
// absorbs the defensive remainder. With all p̂ equal this reduces to
// confidence-proportional weights lerped toward the canonical (Tip 7.2).
export function pairwiseMisWeight(
  pHatAt: readonly number[],
  confidences: readonly number[],
  canonical: number,
  i: number,
): number {
  let cTotal = 0;
  for (const c of confidences) cTotal += c;
  const cCanon = confidences[canonical]!;
  const cOthers = cTotal - cCanon;
  if (cTotal === 0) return 0;
  const pCanon = pHatAt[canonical]!;

  if (i !== canonical) {
    const num = confidences[i]! * pHatAt[i]!;
    if (num === 0) return 0;
    const den = cOthers * pHatAt[i]! + cCanon * pCanon;
    return den > 0 ? (cOthers / cTotal) * (num / den) : 0;
  }

  // Canonical: defensive base share plus the pairwise remainders.
  if (pCanon === 0) return 0;
  let m = cCanon / cTotal;
  for (let j = 0; j < pHatAt.length; j++) {
    if (j === canonical) continue;
    const den = cOthers * pHatAt[j]! + cCanon * pCanon;
    if (den > 0) m += (confidences[j]! / cTotal) * ((cCanon * pCanon) / den);
  }
  return m;
}

export type MisKind = 'balance' | 'pairwise' | 'oneOverM';

// Uniform 1/M weights: BIASED whenever candidate supports differ (the
// darkening-at-edges artifact) — kept as an explicit toggle: it is both a
// figure and the negative control that proves the bias tests can detect
// bias (design-v4 decision 5).
export function misWeight(
  kind: MisKind,
  pHatAt: readonly number[],
  confidences: readonly number[],
  canonical: number,
  i: number,
): number {
  if (kind === 'oneOverM') return pHatAt[i]! > 0 ? 1 / pHatAt.length : 0;
  if (kind === 'balance') return balanceMisWeight(pHatAt, confidences, i);
  return pairwiseMisWeight(pHatAt, confidences, canonical, i);
}

// Σ_i m_i(y) — must equal 1 for balance and pairwise whenever the canonical
// covers y (p̂_c(y) > 0). The house weight-sum assertion, third appearance.
export function misWeightSum(
  kind: MisKind,
  pHatAt: readonly number[],
  confidences: readonly number[],
  canonical: number,
): number {
  let sum = 0;
  for (let i = 0; i < pHatAt.length; i++) {
    sum += misWeight(kind, pHatAt, confidences, canonical, i);
  }
  return sum;
}
