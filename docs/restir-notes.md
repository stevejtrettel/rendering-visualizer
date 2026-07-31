# ReSTIR implementation notes (banked research)

*Distilled 2026-07-31 from the SIGGRAPH 2023 course "A Gentle Introduction
to ReSTIR: Path Reuse in Real-Time" (Wyman, Kettunen, Lin, Bitterli,
Yuksel, Jarosz, Kozlowski, De Francesco — course notes rev. 2024-03-04,
intro-to-restir.cwyman.org; equation numbers below are theirs), plus
Bitterli et al. 2020 (ReSTIR DI), Talbot et al. 2005 (RIS), Lin et al.
2022 (GRIS), Bitterli 2022 (pairwise MIS). Written so the design/build
never re-derives; analogous to pbrt-notes.md.*

## Unbiased contribution weights (course §2.4)

The organizing idea: an estimator needs a per-sample weight, not a pdf.
W_X is an *unbiased contribution weight* for X if E[f(X)·W_X] = ∫f dx for
any f within X's support — equivalently E[W_X | X] = 1/p(X) (eq 3.3).
RIS-produced samples have intractable pdfs but cheap exact W_X. The
estimate is ⟨I⟩ = f(X)·W_X (eq 3.4); supp(X) must cover supp(f).

## RIS, generalized formulation (§3, eq 3.2; GRIS form)

Given candidates (X₁…X_M), possibly from different distributions, each
with its own contribution weight W_{Xᵢ} (= 1/pᵢ(Xᵢ) when the pdf is
known):

- resampling weight  wᵢ = mᵢ(Xᵢ) · p̂(Xᵢ) · W_{Xᵢ}
- pick X = X_s with probability w_s / Σwⱼ
- output weight      W_X = (1/p̂(X)) · Σⱼ wⱼ

p̂ is the TARGET FUNCTION (unnormalized; p̂ = f recommended); the output
pdf approaches p̄ = p̂/∫p̂ as candidates increase. The 1/M in the classic
Talbot form is really a resampling MIS weight mᵢ = 1/M, valid ONLY when
all candidates are identically distributed (Tip 3.4). Σwⱼ estimates p̂'s
normalization at X (Tip 3.3).

Null samples: if all wᵢ = 0, return ∅ with W_∅ = 0 — never redraw
(redrawing biases); null realizations still count in other samples' MIS
denominators as distributions, and m(∅) = 0 (Tips 3.13–3.14).

MIS weight requirements (eq 2.6): Σᵢ mᵢ(x) = 1 on supp(f), mᵢ(x) = 0
outside supp(Xᵢ). With per-candidate target functions p̂ᵢ as pdf proxies,
the GENERALIZED BALANCE HEURISTIC (eq 3.11):
  mᵢ(x) = p̂ᵢ(x) / Σⱼ p̂ⱼ(x)      — O(M²) total cost.
Unbiasedness across mixed supports needs a CANONICAL candidate whose
support covers supp(p̂) of the current pixel (Def 3.4.1) — in reuse, the
current pixel's own fresh sample.

## Weighted reservoir sampling (§4.1, Algorithms 2–3)

Streaming RIS in O(1) state. Reservoir = {Y, W_Y, w_sum, c}:
  update(Xᵢ, wᵢ, cᵢ): w_sum += wᵢ; c += cᵢ; replace Y with prob wᵢ/w_sum
  finalize: W_Y = (1/p̂(Y)) · w_sum;  c = min(c, c_cap)
Merging reservoirs = treating each reservoir's (Y, W_Y, c) as one
weighted candidate; chaining RIS across pixels/frames aggregates M₁×M₂
candidates at ~1-candidate cost — that IS ReSTIR.

CONFIDENCE WEIGHTS (§4.4, eq 4.7): mᵢ(x) = cᵢp̂ᵢ(x) / Σⱼ cⱼp̂ⱼ(x). A
fresh sample has c = 1; RIS over M fresh gives c = M; merges sum. Left
uncapped, temporal confidence grows without bound and new samples get
exponentially down-weighted → convergence to a WRONG result. Cap c at
c_cap ∈ [5, 30], start 20 ("M-capping"). Confidence resets may only
depend on G-buffer-style data, never on sample contents (else bias).

## ReSTIR DI (§4.3), the canonical pipeline

Direct lighting = length-3 paths [x₀, x₁, x₂]; treat x₀ (lens), x₁
(primary hit) as fixed per pixel/frame; resample the LIGHT VERTEX x₂ over
emissive surfaces A (eq 4.1–4.3). Integrand f(x₂) = f_s·G·V·L_e.

- TARGET FUNCTION (eq 4.4): p̂ = f_s·G·V·L_e — WITH visibility. (Tip 4.3:
  start with p̂ = f including V; Talbot's unshadowed p̂ = f_s·G·L_e is a
  performance option that worsens the limit distribution.)
- INITIAL CANDIDATES: M light samples from a standard light sampler
  (power-proportional selection recommended — Bitterli et al. used M = 32),
  RIS with mᵢ = 1/M (identical distributions), pdfs in AREA measure.
- ORDER per frame: candidates → temporal reuse → spatial reuse → shade
  with ⟨I⟩ = f(X)·W_X.
- SPATIAL REUSE: pick neighbors from a small disk/box by G-buffer
  similarity heuristics (normals/depth), NEVER by inspecting their stored
  samples (Tip 4.1 — conditioning on samples biases). Repeatable for more
  aggregation at more correlation.
- TEMPORAL REUSE: RIS against the motion-matched previous-frame
  reservoir. Static scenes (ours): identity motion. Correct MIS may need
  the PREVIOUS frame's p̂ (previous BVH etc.); a static scene makes
  p̂_prev = p̂_cur, eliminating that whole hazard class.
- Course-recommended build order (Tip 4.4): candidates-only first —
  validate convergence to ground truth — then spatial, then temporal
  without motion. Validate each stage before the next.

## MIS weights for reuse: the menu (§7.1)

- 1/M everywhere: BIASED when supports differ (visibility/orientation
  make neighbor p̂ vanish where mine doesn't) — visible darkening at
  geometric discontinuities. Bitterli 2020's biased variant + neighbor
  rejection (normal/depth thresholds) ≈ Veach's cutoff heuristic.
- Generalized balance heuristic (eq 3.11): unbiased, O(M²).
- CONTRIBUTION MIS (eq 7.1): evaluate the MIS-style weight only for the
  selected sample inside W_Y — W_Y = [c_s(Y)/m_s(Y)]·(1/p̂(Y))·Σwⱼ with
  Σᵢ cᵢ(y) = 1; O(M), unbiased, but noisier and the sample distribution
  no longer converges to p̂ (needs proper mᵢ for that).
- PAIRWISE MIS (Bitterli 2022; eqs 7.3–7.6): one technique is CANONICAL
  (the current pixel); each non-canonical sample is weighted pairwise
  against the canonical only. Defensive form (eq 7.6), with p̂ proxies:
    mᵢ(x) = (1/M) · p̂ᵢ(x) / (p̂ᵢ(x) + p̂_c(x)/(M−1))          (i ≠ c)
    m_c(x) = (1/M) · (1 + Σⱼ≠c p̂_c(x)/(M−1) / (p̂ⱼ(x) + p̂_c(x)/(M−1)))
  O(M), unbiased, convergence comparable to full balance (ReSTIR PT's
  default for spatial reuse). Confidence-weighted generalizations:
  eqs 7.7 (non-defensive) / 7.8 (defensive); pseudocode Algorithm 7.
  Weights sum to 1 by construction — assertable per sample.

## Reuse across domains (§5) — shift mappings, read 2026-07-31

When the reused sample lives in a different domain (moving geometry,
path suffixes at a different primary hit), reuse needs a SHIFT MAPPING
T: A → B — deterministic, at-most-one image, invertible on its domain
(Def 5.1.1); undefined shifts (e.g. occluded reconnection) return ∅ and
get w = 0, and then no target-domain path may shift back to the source
(invertibility both ways or zero weight). Densities transform by the
Jacobian: p_Y(y) = p_X(x)/|T′(x)|, and contribution weights by
W_Y = W_X·|T′(X)| (eqs 5.2–5.3). GRIS resampling weight:
wᵢ = mᵢ(Yᵢ)·p̂(Yᵢ)·W_{Xᵢ}·|Tᵢ′(Xᵢ)| = mᵢ(Yᵢ)·p̂(Yᵢ)·W_{Yᵢ}
(eqs 5.4–5.5; Algorithm 4). MIS across domains uses "p̂ from i":
p̂_{←i}(y) = p̂ᵢ(Tᵢ⁻¹(y))·|Tᵢ⁻¹′(y)| if y shiftable into Ωᵢ, else 0
(eq 5.9), plugged into the generalized balance heuristic (5.10) or its
confidence-weighted form (5.11); Σmᵢ = 1 holds by construction (5.12).
Validation Tip 5.1: shifting to the SAME pixel must be the identity with
Jacobian 1 — report small discrepancies (finds latent path-tracer bugs).

ReSTIR DI on a static scene needs NONE of this: the light vertex x₂ is
shared in the one world-space domain, identity shift, Jacobian 1
(§6.3: vertex reuse "resembles the direct lighting case").

## ReSTIR PT (§6) — the full-path options, read 2026-07-31

- §6.2, RIS WITH A PATH TRACER: NEE-at-every-vertex creates a path TREE;
  RIS picks ONE path from the tree with p̂(xᵢ) = f(xᵢ), W = 1/p(xᵢ),
  mᵢ = 1 — path subspaces of different lengths are DISJOINT, so no MIS
  needed between them. When both NEE and BSDF-sampled emitter hits exist,
  both enter as candidate paths (doubling candidates) and mᵢ becomes the
  light-technique MIS weight for that length (< 1); eq 6.13 partitions
  the path integral by length AND technique tags.
- §6.3, IDENTITY SHIFT on the free tail [x₂…x_D] (= ReSTIR GI, Ouyang
  2021): reconnect y₁ → x₂; a FAITHFUL implementation re-evaluates two
  BSDFs, the geometry factor, and traces a fresh shadow ray — that is
  unbiased. ReSTIR GI's published shortcut (cache outgoing radiance at
  x₂, assume unchanged after reconnection) is BIASED except for
  Lambertian x₂. Specular/near-specular x₂ makes even unbiased
  reconnection HIGH VARIANCE (near-zero BSDF in the new direction) —
  reuse must be gated to diffuse-enough reconnection vertices.
- §6.4–6.5, GOOD SHIFTS: want p̄ⱼ(T(x))·|∂T/∂x| ≈ p̄ᵢ(x) (eq 6.4);
  reconnection breaks it at glossy vertices and at short reconnection
  segments (geometry-term blowup). Gradient-domain shift mappings
  (half-vector, random replay) transfer directly to path resampling.
- §6.6, HYBRID SHIFT (ReSTIR PT, Lin 2022): random-replay the path's
  random numbers up to the FIRST reconnectible vertex x_k (k ≥ 2), then
  reconnect. Conditions, enforced on base AND offset path (else zero
  weight — invertibility): distance ‖x_k − x_{k−1}‖ ≥ d_min (eqs
  6.6/6.8/6.10) and lobe roughness min(α's) ≥ α_min (6.7/6.9/6.11), with
  "no earlier k′ would qualify" as the uniqueness rule. Path samples are
  LOBE-TAGGED (eq 6.12: (xⱼ, ℓⱼ) per vertex; NEE gets a technique tag)
  so replay reproduces the exact subpath. In PRIMARY-SAMPLE-SPACE
  parameterization the random-replay portion has identity Jacobian and
  only the reconnection step contributes (eqs 6.14–6.18: ratio of joint
  lobe+direction pdfs at x_{k−1} and x_k, times the solid-angle
  reconnection Jacobian |cosθ_y/cosθ_x|·‖x_k−x_{k−1}‖²/‖x_k−y_{k−1}‖²).
  Reservoir stores reconnection vertex + RNG seeds + lobe indices +
  cached partial terms (Algorithm 6). NOTE FOR US: "random replay from a
  stored seed with fixed dimension layout" is this repo's native idiom
  (V0 principle 2) — our sampler already satisfies the replay contract.
- §6.7 volumes: out of scope (no participating media in this renderer).

## Full-integral integration patterns (agreed staging, 2026-07-31)

- V4a (Bitterli-2020 pattern): reservoirs own DIRECT LIGHTING AT THE
  PRIMARY VERTEX only; the walk continues from the primary hit for all
  indirect transport, with ordinary NEE at deeper vertices. Total = the
  full transport integral; converges to pt-nee's image. Delta primary
  vertices (glass pixels): no reservoir — the ordinary specular-chain
  machinery applies until the first non-delta vertex... V4a scope keeps
  the reservoir strictly at the first vertex and lets pt-nee handle the
  rest (see design-v4 decision 4 for the primary-vertex MIS treatment).
- V4b (optional, decide after V4a's measurements): extend reuse to the
  indirect tail via the FAITHFUL reconnection shift gated by the hybrid
  shift's distance + roughness conditions, random-replay portion via our
  seed-replay. This is the unbiased kernel of ReSTIR GI with ReSTIR PT's
  gating — not the published biased shortcut.

## Bias mechanics to remember (§7.1.1, §7.1.4)

Bias enters through MIS denominators using approximations p̃ⱼ of a
neighbor's true pdf/target: p̃ⱼ > pⱼ darkens, p̃ⱼ < pⱼ brightens; e.g.
assuming pⱼ(Xᵢ) = 0 for "samples the neighbor couldn't generate" when it
could (via reuse it received) over-counts → brightening. Every shortcut
in the m's is a controlled trade, never free.

## Correctness assertions our house style can add

- WRS marginal: selection frequency of candidate i ∝ wᵢ (chi-square).
- E[f(X)W_X] = ∫f on an analytic target (unbiasedness of RIS itself).
- Merge associativity: chained merges ≡ one-pass RIS over the union
  (distributional equality).
- Per-sample Σᵢ mᵢ(x) = 1 assertion for pairwise/balance weights (the
  ReSTIR analogue of BDPT's weight-sum check).
- Long-run temporal test: with reuse on, the PASS-AVERAGED image still
  converges to the ground truth (temporal chains are where silent bias
  lives; M-capping makes correlation bounded, not bias).
