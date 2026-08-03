# SMS theory — solving in the fibers of path space

*Steve's account, banked verbatim 2026-08-02 (§12 of his
bidirectional-estimation-and-MIS outline; supersedes the earlier
fixed-endpoints note). This is the mathematical frame design-v5 speaks
in; implementation constants and code references live in sms-notes.md.*

## 12. Specular manifold sampling: solving in the fibers of path space

### 12.1 The constraint locus inside ordinary path space

- Begin with an ordinary path stratum \(\mathcal P_\tau\): fix the number of vertices, the sequence of surfaces, the reflection/refraction branches, and the relevant wavelength and media. Sampling this discrete path type is separate from solving its continuous specular constraints.
- There is no new kind of path here. A specular path is one of our standard scene paths whose designated specular vertices satisfy additional equations.
- If \(S\) indexes those vertices, let

  \[
  F_i(\Gamma)\in\mathbb R^2,
  \qquad i\in S,
  \]

  measure the two tangential components by which the incoming and outgoing directions fail to satisfy the chosen reflection or Snell law. Stack these constraints into

  \[
  F=(F_i)_{i\in S}.
  \]

- The valid specular paths in this stratum are the zero set

  \[
  \boxed{
  \mathcal M_\tau=F^{-1}(0)\subset\mathcal P_\tau.
  }
  \]

- At a regular solution, the regular-value theorem makes \(\mathcal M_\tau\) a local submanifold. Since a surface vertex has two degrees of freedom and an ideal specular event imposes two equations, each specular vertex is locally constrained while the nonspecular vertices remain free.
- This is a local statement. Globally there may be several components, singular points, changes of surface sequence, occlusions, or invalid reflection/refraction branches. The equations alone do not enforce visibility, the intended branch, or the absence of total internal reflection.
- The particular coordinate formula for \(F\) is not the conceptual point. Different constraint maps can describe the same physical zero set while having very different numerical behavior.

### 12.2 Forget the constrained vertices

- Let \(\mathcal B_\tau\) denote the unconstrained path data: the nonspecular vertices, and in particular the endpoints of every maximal specular chain.
- There is a natural projection

  \[
  \boxed{
  \pi:\mathcal M_\tau\longrightarrow\mathcal B_\tau
  }
  \]

  which forgets the specular vertices and remembers only the free data.
- Wherever the derivative of the constraints with respect to the specular vertices is invertible, the implicit-function theorem says that those vertices are locally determined by the free data. Equivalently, \(\pi\) is locally a diffeomorphism onto its image.
- Now isolate one specular chain with fixed endpoints \(a\) and \(b\). The admissible chains are precisely the fiber

  \[
  \boxed{
  \mathcal M_\tau(a,b)=\pi^{-1}(a,b).
  }
  \]

- With \(m\) specular vertices there are \(2m\) unknown surface coordinates and \(2m\) specular equations. Thus a regular fiber is zero-dimensional and locally discrete. Under the usual compactness or properness assumptions it is finite: there may be no connection, one connection, or several distinct connections.
- Exact symmetries can produce a positive-dimensional family of solutions, but that is nongeneric and should be treated as a separate singular case.
- This is the geometric upgrade of the ordinary bidirectional connection step:
  - BDPT fixes two terminal vertices and tests the single straight edge between them;
  - SMS fixes two terminal vertices and searches the fiber for a specular chain connecting them.

### 12.3 How a valid chain is found

- Choose the two endpoints and a tentative chain of points on the prescribed specular surfaces.
- Evaluate \(F\), linearize it, and use a Newton-type correction or manifold walk to drive the residual toward zero.
- Each constraint involves only a vertex and its two neighbors, so the derivative with respect to the specular vertices has a sparse block-tridiagonal structure. This is why the local solve can be efficient even for a chain of several events.
- The method is a local solver, not an oracle. From one seed it may:
  - converge to one admissible root;
  - converge to a different branch;
  - encounter a singular configuration;
  - leave the prescribed surfaces or violate visibility;
  - fail even though another solution exists elsewhere.
- Earlier manifold methods began from a valid path and moved it locally, or used a deterministic seed intended to select one branch. SMS adds randomized seeds so that different isolated roots can be discovered.

### 12.4 Randomized solving defines a conditional probability law

- Conditional on fixed endpoints \((a,b)\), let \(\xi\sim q_{a,b}\) be the random seed and let the deterministic numerical solver send \(\xi\) either to a valid root \(\Gamma_k(a,b)\in\mathcal M_\tau(a,b)\) or to failure.
- Each root has a basin of attraction

  \[
  B_k(a,b)=\{\xi:\operatorname{solve}(a,b,\xi)=\Gamma_k(a,b)\},
  \]

  and hence a discovery probability

  \[
  \boxed{
  p_k(a,b)
  =
  \Pr(\xi\in B_k(a,b)\mid a,b)
  =
  \int_{B_k(a,b)}q_{a,b}(\xi)\,d\xi.
  }
  \]

- This is the precise sense in which randomized root-finding becomes a proposal on the discrete fiber. The roots are geometrically defined; their probabilities are induced by the seed distribution and the solver basins.
- For an unbiased estimator, a contribution obtained through root \(\Gamma_k(a,b)\) must be corrected by \(1/p_k(a,b)\). But the basins are complicated and this probability is normally unavailable in closed form.
- The unbiased SMS construction contains a particularly clean probabilistic device. After finding \(\Gamma_k\), repeat independent seed-and-solve trials until the same root is found again. If \(N\) is the number of trials, then

  \[
  N\sim\operatorname{Geom}(p_k(a,b)),
  \qquad
  \mathbb E[N\mid a,b,\Gamma_k]=\frac1{p_k(a,b)}.
  \]

  Thus \(N\) is an unbiased random estimator of the missing reciprocal probability.
- This statement depends on explicit assumptions: the contributing roots are isolated, each has positive discovery probability, trials are independent, roots can be identified reliably, and the repeat-until-success procedure is not truncated. A fixed trial budget gives a useful but biased approximation and lies outside the clean mathematical story.

### 12.5 Do not confuse the geometric and algorithmic corrections

- A valid specular-chain sample carries two conceptually distinct corrections.
- The **geometric factor** comes from restricting transport to the constraint locus and projecting through the specular chain. It is built from the derivative of \(F\), and is the generalized analogue of the ordinary geometry factor. Together with Fresnel factors, transmittance, and visibility, it belongs to the optical contribution.
- The **discovery factor** \(1/p_k(a,b)\) corrects the conditional probability that the randomized numerical solver selects this root. It belongs to the sampling strategy.
- The first depends on the local differential geometry of the specular equations. The second depends on the global basins of a particular algorithm. A root finder does not become a correct Monte Carlo strategy until both roles have been accounted for.
- In the regular finite-fiber case, the area formula expresses the geometric part schematically as

  \[
  \boxed{
  \int_{\mathcal M_\tau}\Phi(\Gamma)\,d\mu_{\mathcal M}(\Gamma)
  =
  \int_{u\in\mathcal B_\tau}
  \left[
  \sum_{\Gamma\in\pi^{-1}(u)}
  \frac{\Phi(\Gamma)}{J_\pi(\Gamma)}
  \right]du.
  }
  \]

  Here \(J_\pi\) is the Jacobian of the projection with respect to the chosen intrinsic and base measures. This is the mathematically natural nested integral: integrate over free endpoint data, then sum over the specular solutions in its fiber.
- The factor \(J_\pi^{-1}\) is geometric. The factor \(p_k(a,b)^{-1}\), used to estimate the sum over that fiber by randomized solving, is algorithmic.

### 12.6 Caustics as singular projection

- The projection \(\pi:\mathcal M_\tau\to\mathcal B_\tau\) is also the clean geometric language for caustics.
- Away from a caustic, a solution branch varies smoothly with its free endpoints. At a critical point of \(\pi\), the endpoint map loses rank: branches can merge, appear, or disappear, and the projected density acquires the familiar focusing singularity.
- The familiar caustic drawn on a receiving surface is obtained by fixing, or separately integrating over, the emitter-side data and projecting the remaining family to the receiver endpoint.
- The constraint manifold itself may remain smooth. What becomes singular is its projection onto the endpoint or scene variables.
- This is the differential-geometric picture worth emphasizing in the talk:

  > Specular transport is a manifold of valid paths; a caustic is a singularity of the map that forgets the hidden specular vertices.

### 12.7 Returning to the global estimator

- The endpoints \(a,b\) are themselves generated as part of the exterior light path. Conditional on them, SMS samples a root in the interior fiber; inserting that root produces one ordinary complete scene path.
- If \(Q_{\mathrm{base}}\) is the proposal for the free endpoint data and \(K_{a,b}\) is the conditional discrete law on roots induced by the randomized solver, then the SMS proposal disintegrates as

  \[
  \boxed{
  Q_{\mathrm{SMS}}(d\Gamma)
  =
  Q_{\mathrm{base}}(d(a,b))\,K_{a,b}(d\Gamma).
  }
  \]

  The conditional kernel also has a failure mass. Failure contributes zero, but its probability is part of the proposal law.
- Suppressing the geometric factors already displayed above, the apparently nested construction

  \[
  \int_{(a,b)\in\mathcal B_\tau}
  \left[
  \sum_{\Gamma_k\in\pi^{-1}(a,b)}
  \text{contribution}(\Gamma_k)
  \right]
  \,d(a,b)
  \]

  therefore flattens back into the same global path integral. The newly solved specular points are simply additional vertices of the complete path.
- Conceptually, SMS supplies another proposal measure \(Q_{\mathrm{SMS}}\) on that same path space; it does not change the physical contribution measure \(\nu_a\).
- In an idealized measure-theoretic formulation, if the relative proposal measures can be evaluated, it can enter the same mixture:

  \[
  Q
  =
  \sum_{(s,t)\in\mathcal J}\alpha_{s,t}Q_{s,t}
  +
  \alpha_{\mathrm{SMS}}Q_{\mathrm{SMS}}.
  \]

- Do not claim that this makes general practical MIS automatic. The root-selection probability is already nontrivial, and evaluating comparable cross-technique probabilities for arbitrary caustic paths remains a substantive algorithmic issue. The safe statement for the talk is:

  > Once its probability law is correctly accounted for, SMS is another unbiased proposal for the same exact path integral; whenever the relevant relative densities are available, it can be combined with the others by MIS.

### 12.8 Literature anchors for this account

- [Jakob and Marschner, *Manifold Exploration* (2012)](https://www.cs.cornell.edu/projects/manifolds-sg12/) supplies the constraint-manifold formulation, the implicit-function analysis, the sparse derivative, and the projection view of caustics.
- [Hanika, Droske, and Fascione, *Manifold Next Event Estimation* (2015)](https://onlinelibrary.wiley.com/doi/10.1111/cgf.12681) turns a local specular solve into a next-event strategy and makes the one-solution and solver-failure assumptions visible.
- [Speierer et al., *Caustic Connection Strategies for Bidirectional Path Tracing* (2018)](https://graphics.pixar.com/library/CausticConnections/) inserts solved specular chains into bidirectional connection strategies.
- [Zeltner, Georgiev, and Jakob, *Specular Manifold Sampling* (2020)](https://rgl.epfl.ch/publications/Zeltner2020Specular) introduces the randomized many-root construction and the unbiased reciprocal-probability estimator used above.
