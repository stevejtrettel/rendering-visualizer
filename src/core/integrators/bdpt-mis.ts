// BDPT multiple importance sampling as a PURE function (pbrt v3 §16.3.4's
// math without ScopedAssignment): the role-dependent values pbrt patches by
// mutate-and-restore arrive as explicit overrides instead, so the vertex
// arrays are never touched and the function is unit-testable in isolation.
//
// The weight of strategy (s, t) is 1 / (1 + sum of r_i) where each r_i is
// the ratio p_i / p_(s,t) of another strategy's area-product path density to
// this one's. Walking outward from the junction, each step multiplies one
// local ratio pdfRev/pdfFwd — pdfFwd is the density with which THIS side's
// walk generated the vertex, pdfRev the density with which the opposite side
// would have. remap0 (0 -> 1) realizes the delta-pdf cancellation: a term
// only joins the sum when neither vertex flanking its hypothetical junction
// is a delta scatterer. The power heuristic (beta = 2) squares each ratio at
// the moment it joins the sum.

export type MisHeuristic = 'balance' | 'power';

// The fields misWeight reads from a vertex — structurally satisfied by
// PathVertex, or by plain objects in tests and the weight-sum debug check.
export interface MisVertex {
  pdfFwd: number;
  pdfRev: number;
  delta: boolean;
}

// Role-dependent patches for strategy (s, t), computed by the caller from
// live vertex refs (these depend on the junction and cannot be baked in
// during the walks). Indices refer to the subpath arrays: pt = cameraVs[t-1],
// ptMinus = cameraVs[t-2], qs = lightVs[s-1], qsMinus = lightVs[s-2].
export interface MisOverrides {
  ptPdfRev?: number; // density of the light side generating pt
  ptMinusPdfRev?: number; // density of pt scattering back toward ptMinus
  qsPdfRev?: number; // density of the camera side generating qs
  qsMinusPdfRev?: number; // density of qs scattering back toward qsMinus
  // s = 1 resamples the light (sampleLi); reads of lightVs[0] use the
  // substituted vertex's origin density pdfLightOrigin = pmf x pdfPos
  // (area measure) — the classic silent-wrong-weights bug lives here.
  qsSubstitutePdfFwd?: number;
  // Delta-light guard (pbrt's IsDeltaLight on lightVs[0]). Structure kept
  // for completeness; no delta lights exist in our scenes.
  lightIsDelta?: boolean;
}

const remap0 = (x: number): number => (x !== 0 ? x : 1);

export function misWeight(
  cameraVs: readonly MisVertex[],
  lightVs: readonly MisVertex[],
  s: number,
  t: number,
  overrides: MisOverrides,
  heuristic: MisHeuristic,
): number {
  if (s + t === 2) return 1; // direct emission has exactly one strategy

  // Effective per-index reads with the strategy's patches applied. The two
  // junction vertices (cameraVs[t-1], lightVs[s-1]) read delta = false: the
  // strategy DID form this connection, so for ratio purposes they are
  // ordinary vertices whatever lobe the walk happened to sample there.
  const camPdfRev = (i: number): number => {
    if (i === t - 1 && overrides.ptPdfRev !== undefined) return overrides.ptPdfRev;
    if (i === t - 2 && overrides.ptMinusPdfRev !== undefined) return overrides.ptMinusPdfRev;
    return cameraVs[i]!.pdfRev;
  };
  const camDelta = (i: number): boolean => (i === t - 1 ? false : cameraVs[i]!.delta);
  const lightPdfFwd = (i: number): number =>
    i === 0 && overrides.qsSubstitutePdfFwd !== undefined
      ? overrides.qsSubstitutePdfFwd
      : lightVs[i]!.pdfFwd;
  const lightPdfRev = (i: number): number => {
    if (i === s - 1 && overrides.qsPdfRev !== undefined) return overrides.qsPdfRev;
    if (i === s - 2 && overrides.qsMinusPdfRev !== undefined) return overrides.qsMinusPdfRev;
    return lightVs[i]!.pdfRev;
  };
  const lightDelta = (i: number): boolean => (i === s - 1 ? false : lightVs[i]!.delta);

  const join = (ri: number): number => (heuristic === 'power' ? ri * ri : ri);

  let sumRi = 0;

  // Hypothetical strategies with shorter camera subpaths: the term after
  // folding index i corresponds to (s' = s+t-i, t' = i).
  let ri = 1;
  for (let i = t - 1; i > 0; i--) {
    ri *= remap0(camPdfRev(i)) / remap0(cameraVs[i]!.pdfFwd);
    if (!camDelta(i) && !camDelta(i - 1)) sumRi += join(ri);
  }

  // Hypothetical strategies with shorter light subpaths: the term at index i
  // corresponds to (s' = i, t' = s+t-i); i = 0 is the s'=0 emitter hit.
  ri = 1;
  for (let i = s - 1; i >= 0; i--) {
    ri *= remap0(lightPdfRev(i)) / remap0(lightPdfFwd(i));
    const deltaAdjacent = i > 0 ? lightDelta(i - 1) : (overrides.lightIsDelta ?? false);
    if (!lightDelta(i) && !deltaAdjacent) sumRi += join(ri);
  }

  return 1 / (1 + sumRi);
}
