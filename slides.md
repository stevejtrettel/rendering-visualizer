---
title: "The Mathematics of Path Tracing — talk narrative"
date: '2026-08-03'
description: "Narrative material for the MAA invited address slides"
draft: true
---

<!-- Narrative tracking document. Records the narrative material going into the
     slides, in talk order. Nothing enters this file without approval. -->

# Opening

<!-- personal story: photography; pandemic hobby project while others made
     sourdough; a simulation of a photograph; the first ones were bad, and the
     improvements led to a ton of beautiful math -->

---

# Cast of Characters

<!-- A math review, not teaching: let the algebraists recall theorems they have not thought
     about, so the names are legible when they appear. CRITERION IS RECURRENCE — only what
     comes back more than once. Met in place instead, each used once: Bochner, Banach,
     Tonelli. Not a dramatis personae; this is machinery for the audience, not a roll-call
     of the talk's objects. -->

### Slide — Three things we will keep needing

- **A measure need not have a density.** It can put mass on a single point as readily as
  spread it across a region, and one measure can do both at once. Nothing in what follows
  will let us assume the smooth case.
- **When one measure dominates another, there is a derivative between them.** If everything
  $\mu$ charges is charged by $Q$, then
  $$\mu = \frac{d\mu}{dQ}\,Q ,$$
  the **Radon–Nikodym** derivative. Domination is a genuine hypothesis: where it fails, the
  derivative does not exist.
- **A positive linear functional is integration against a measure.** **Riesz–Markov.** It is
  how we will get our hands on objects we can describe but cannot write down.

<!-- Radon-Nikodym is currently never NAMED again anywhere in the deck, though d(mu)/dQ is
     used constantly. Name it once at first use in Part VI, or this entry has no callback. -->

---

# Modeling the World

## Part I. Modeling Light

### Slide — Spectrum

**Light is a signal in time.** The light arriving at a point has statistics that do not
drift — it is **stationary** — so its correlation

$$\Gamma(\tau)=\mathbb E\!\left[\mathbf E(t)\cdot\overline{\mathbf E(t+\tau)}\right]$$

is positive-definite.

**Bochner: a positive-definite function is the transform of a positive measure.**

$$\Gamma(\tau)=\int_\Lambda e^{-2\pi i c\tau/\lambda}\,s(d\lambda), \qquad s\in\mathscr M_+(\Lambda).$$

That measure is the spectrum. Positivity, finite total mass, and lines-plus-continuum
come together.

### Slide — Pictures of actual spectra

<!-- real measured spectra -->

### Slide — The ray optics approximation (Fermat)

**Now fix a wavelength.** This could not be done before: the short-wavelength limit
needs a wavelength.

**Assume $\eta$ varies slowly on the scale of $\lambda$, and let $\lambda\to0$.**
Maxwell's leading order becomes the eikonal equation

$$\lvert\nabla S\rvert^{2}=\eta^{2},$$

and its characteristics are the geodesics of the optical metric $\eta^{2}\delta$ —
Fermat's principle, since optical path length $\int\eta\,ds$ *is* length in that
metric.

**Rays.** Light in flight is a point of $T^{1}M$ carrying a spectrum, moved by
geodesic flow.

Two honest footnotes: this needs the medium isotropic, and the expansion fails at
caustics.

### Slide — Radiance

Light in flight is a measure on rays — write $\zeta$ for how much a family of them
carries. To get a brightness, divide by how big a family of rays
is — and ray space supplies its own size, the Liouville measure $m$, invariant under
the flow.

$$\zeta = \ell\,m,\qquad \ell:T^{1}M\to\mathscr S_+ .$$

**Radiance is light per ray.**

The flow carries $\zeta$ and leaves $m$ alone, so

$$\ell\circ\varphi_t=\ell .$$

*Constant along every free ray* — a corollary, not a postulate.

Where $\zeta\ll m$. Point lights and collimated beams are singular and have no $\ell$.

### Slide — Objects

- A scene is a finite collection of **objects**: regions $X_i \subset M$.
- Nothing happens to light while it travels. Everything happens where it meets a
  boundary,
  $$\Sigma = \bigcup_i \partial X_i .$$
- So the part of ray space where the scene acts is
  $$\mathcal X = T^{1}M\big\vert_\Sigma = \bigsqcup_{p\in\Sigma}\mathbb S^{2}_p .$$
- The radiance in the room is $\ell$, and it does not change along geodesics. So we need
  only record it on the boundary:
  $$L = \ell\big\vert_{\mathcal X}.$$
- What we have now is a **density on the boundary of the scene**,
  $$L:\mathcal X\longrightarrow\mathscr S_+ .$$

### Slide — Measuring rays at a surface — SKIP

<!-- SKIP: cut from Part I so that Part I ends on the light field. Sigma does NOT
     reappear anywhere: Part III's Lambertian measure is built from the normal alone.
     If the caustic block in Part X ever needs a reference measure, this is the material
     that would have to come back. -->

- Radiance was light per ray, measured against $m$ on $T^{1}M$. On $\mathcal X$ we need
  a size for families of rays again — and again the geometry supplies it, with nothing
  chosen.
- Rays cross $\mathcal X$ transversally, so $m$ factors there:
  $$dm = d\sigma\,dt ,$$
  with $t$ arclength along the ray. This *produces* $\sigma$; it is not a definition we
  make.
- $\sigma$ measures families of rays **crossing a surface**, as $m$ measured families of
  rays **in flight**.
- In coordinates $d\sigma(p,\omega) = \lvert n_p\cdot\omega\rvert\,dA(p)\,d\omega$. The
  cosine is a Jacobian between a convenient parametrisation and the invariant measure —
  this is where every cosine factor in graphics comes from, and it is bookkeeping, not
  physics.

---

## Part II. Modeling the Light Field

### Slide — The interaction is linear

- Maxwell is linear in the field: a material's polarisation is proportional to $E$, and
  stays so until $E$ approaches the field binding electrons to atoms. Everyday light is
  eight orders of magnitude below that.
- But brightness is the **square** of the field, and squaring is not linear:
  $$(a+b)^{2} = a^{2}+b^{2}+\underbrace{2ab}_{\text{interference}} .$$
- Independent sources have no fixed phase relation, so the cross term averages away over
  any exposure. **That is the incoherence assumption, and it is what makes the squares
  add.**
- So brightnesses superpose: one lamp, then the other, then both — the third picture is
  the sum of the first two.
- The scene therefore responds **linearly to the light field**: a linear map
  $$T:\ L\ \longmapsto\ TL .$$

### Slide — The scene is an affine map

- **Objects may also emit.** Turn every lamp off and the room need not go dark — some
  surfaces glow on their own. That glow is itself a light field: write $E$ for it, the
  **emission part of the scene**.
- **That glow does not depend on what is shining on the object.** A lamp is as bright in
  a dark room as in a lit one.
- **And the two contributions superpose** — emitted light and scattered light add for
  exactly the reason two lamps did: light does not interact with light.
- So the scene's response to a light field is
  $$\boxed{L\ \longmapsto\ E + TL,}$$
  **affine rather than linear, precisely because the lights are on.**

<!-- spoken, not printed: independence of emission fails for fluorescence, and for
     anything that warms up under illumination and then glows differently. Both are
     already on the "what is not here" list. -->

### Slide — Which light field is in the room?

- We know what the scene *does* to a light field. Which one is actually in the room?
- Put any light field you like in the room and apply the scene over and over:
  $$L_{n+1} = E + TL_n .$$
- Every round loses energy: however the room is lit, at most a fraction $c<1$ of it
  survives one round of travel and scattering. So $\lVert T\rVert\le c$, the map is a
  contraction, and by Banach the iterates converge — **to the same field no matter what you
  started with.**
- Whatever you imagined in the room is washed out. What remains is driven entirely by the
  emitters — call it the **equilibrium light field** $L_\star$:
  $$\boxed{L_\star = E + TL_\star .}$$
  Banach gives existence *and* uniqueness, in infinite dimensions exactly as in finite
  ones.
- **When it fails:** two perfect mirrors facing each other. Nothing is absorbed, $c=1$, and
  the light you started with never washes out.

<!-- spoken, not printed: the index counts BOUNCES, NOT SECONDS. The model is stationary,
     so nothing physically evolves — iterating is how we FIND the field, not something the
     room does. -->



## Part III. Modeling Materials

### Slide — What is $T$?

- We know two things about $T$: it is **linear**, and it is **positive** — light in, light
  out. That turns out to be enough to write it down.
- Fix a state $x$ and watch the light arriving there. The map
  $$L\ \longmapsto\ (TL)(x)$$
  is a positive linear functional on light fields.
- **Riesz–Markov:** every positive linear functional is integration against a positive
  measure. So there is a measure $K(x,\cdot)$ on $\mathcal X$ with
  $$(TL)(x) = \int_{\mathcal X} K(x,dy)\,L(y).$$
- Written out, the equilibrium equation reads
  $$L_\star(x) = E(x) + \int_{\mathcal X} K(x,dy)\,L_\star(y),$$
  which in graphics is called the **rendering equation**.

<!-- spoken, not printed: this needs T defined at every state, not merely almost
     everywhere, or "(TL)(x)" means nothing. Physically fine, but it is the assumption
     the Riesz route costs. -->

### Slide — Travel, then scatter

- So what does $K$ look like? Nothing happens to light between surfaces, so a single round
  has two stages: it travels, and then it scatters.
- **Travel.** Assume the scene is **bounded** — a room, or a sky sphere. Then every ray
  meets a surface, and the predecessor map $g:\mathcal X\to\mathcal X$, which follows the ray
  backward to where the light came from, is a bijection. (Note the direction: the
  bookkeeping runs backwards along the light.)
- Light does not change along a ray, so free propagation is just a relabelling,
  $$(PL)(x) = L(g(x)),$$
  and $P$ is invertible because $g$ is.
- **So the split is free.** Set $R := T\circ P^{-1}$:
  $$\boxed{T = R\circ P .}$$

### Slide — What is $R$?

- **We asked this of $T$; now ask it of $R$.** The same two facts hold — $R$ is linear and
  positive — so the same argument gives it a kernel. But that is not enough this time.
- **Locality, an extra assumption.** The interaction happens *at a point*: all the light
  arriving at $p$ goes in, something happens to it, and light comes back out, with nothing
  crossing from one surface point to another. Nothing so far has told us this; we are
  choosing it.
- Then the kernel of $R$ sits on the fibre over $p$ and nowhere else. Writing $\mu_x$ for
  it, at $x = (p,\omega_o)$:
  $$(RL)(p,\omega_o) = \int_{\mathbb S^{2}_p}\mu_x(d\omega_i)\;L(p,\omega_i).$$
- So the optical properties of the material at $p$ are a **measure on the sphere of
  directions** — one for each direction the light leaves in.
- **What is that measure valued in?** A light field assigns a *spectrum* to each direction,
  so $\mu_x$ has to carry a sphere's worth of incoming spectra to the outgoing one. To
  each set of directions it assigns a positive **operator on spectra**:
  $$\mu_x:\mathcal B(\mathbb S^{2}_p)\longrightarrow \mathcal L_+(\mathscr S).$$

### Slide — Simple materials

- To write examples down we restrict the operators to **multiplication by a function of
  wavelength**: light in at $\lambda$ comes out at $\lambda$, attenuated. A choice, and it
  rules out fluorescence.
- Now Part II's hypothesis is something you can read. The response to a full sphere of
  light is multiplication by some $\alpha(\lambda)$, and the condition is
  $$\alpha(\lambda)\le c<1\quad\text{at every wavelength, at every point:}$$
  **every surface absorbs a little, at every colour.**
- **Black.** $\alpha = 0$: nothing comes back. A surface can still glow — emission was a
  separate term.
- **Lambertian.** Equally bright from every direction. The measure that says so is built
  from the normal alone:
  $$\mu^{\mathrm{Lambert}}_x(B) = \frac{\alpha_d}{\pi}\int_{B}\lvert n_p\cdot\omega_i\rvert\,d\omega_i,$$
  taken over the hemisphere the light comes from, where $\int\lvert n_p\cdot\omega\rvert\,d\omega = \pi$.
  Total mass $\alpha_d$: the colour of the surface.

### Slide — The mirror

- A mirror sends one incoming direction to exactly one outgoing direction. So the measure
  is an **atom**:
  $$\mu^{\mathrm{mirror}}_x = \alpha_m\,\delta_{r_p(\omega_o)} .$$
- **No density represents this.** It is a perfectly ordinary positive linear response, and
  it cannot be written as a function times $d\omega$. This is why the material had to be a
  measure.
- A real mirror reflects 95% of what hits it, so $\alpha_m<1$ and the theorem applies.
- A perfect mirror is the idealisation it misses — and two of them facing each other is the
  one room where the light never settles.

### Slide — Glass

- Every material so far returned light to the side it came from. A **dielectric lets it
  cross**. This is the first mass in the transmission half of the fibre — and the first time
  the whole sphere pays for itself, since reflection and transmission are separated only by
  the sign of $n_p\cdot\omega$.
- The response is **two atoms** instead of one:
  $$\mu_x = \alpha^{\mathrm{refl}}_x\,\delta_{\omega_{\mathrm{refl}}} + \alpha^{\mathrm{trans}}_x\,\delta_{\omega_{\mathrm{trans}}},$$
  Snell fixing the transmitted direction, Fresnel splitting the power between them.
- At **total internal reflection** the transmitted atom disappears and all the mass moves to
  reflection.
- A lossless interface splits the power without losing any, so the total mass is exactly
  one. Real glass absorbs a little — and perfectly clear glass can trap light forever by
  total internal reflection, which is the two mirrors again.

<!-- deliberately left out: dispersion, wavelength dependence, and colour. Beer's law is a
     factor along the TRAVEL, not a measure on the sphere, so it is a different kind of
     change rather than another example. The eta^2 factor is also out. -->

### Slide — Roughness

- A real mirror is not perfectly smooth and real glass is not perfectly polished.
  Roughening **spreads each atom into a lobe** around the direction it sat on.
- **Glossy reflection.** $\mu_x$ concentrates near $r_p(\omega_o)$ without sitting on it — a
  peaked density where the mirror had an atom.
- **Rough glass.** Both atoms spread: one lobe around the reflected direction, one around
  the transmitted one.
- Tighten a lobe and the measure converges back to the atom. So the materials form **one
  family** — and the densities are not closed under that limit. That is why we have been
  carrying measures.

## Part IV. Modeling the Camera

### Slide — What a camera produces

- A camera produces an **image**: a finite set of pixels $J$, each holding a **value** in
  $V$. RGB for a screen, CMYK for print, more channels if you want them.
- So a camera is a map from light fields to $\mathcal I = V^J$ — infinite-dimensional in,
  finite out. Where it stands, where it points, its focus, aperture and exposure are all
  choices inside that map.
- It factors into two stages:
  $$\text{light field}\ \longrightarrow\ \underbrace{\text{one spectrum per pixel}}_{\text{measurement}}\ \longrightarrow\ \underbrace{\text{one value per spectrum}}_{\rho}$$
- **Measurement** is optics: which light reaches which pixel. **Response** is
  $\rho:\mathscr S\to V$: what colour that light counts as.
- Independent choices: change the lens and only the first stage moves; change the sensor
  and only the second does.

### Slide — From a spectrum to a value

- A spectrum is not yet a colour. A colour is what a **detector** makes of a spectrum, and
  a detector integrates the spectrum against a response function.
- **Two extremes.** A black-and-white camera has $r=\mathbf 1$: the value is the *total
  integral* of the spectrum, every wavelength counted equally. An ideal colour filter is
  the opposite, $r$ concentrated at a single $\lambda_0$: the value is the mass the
  spectrum puts there.
- **Real detectors sit between.** The eye has three cone types, and the CIE 1931 standard
  observer packages this as
  $$s\ \longmapsto\ \Big(\textstyle\int\bar x\,ds,\ \int\bar y\,ds,\ \int\bar z\,ds\Big),$$
  with $\bar x,\bar y,\bar z$ a linear image of the cone responses, chosen so that $Y$ is
  luminance. RGB is a further linear map onto a display's primaries.
- **This map has an enormous kernel.** Infinitely many spectra give the same three
  numbers — *metamerism*. Two fabrics matching in daylight and clashing under a bulb are
  two spectra in the same fibre of $\rho$, seen under different illumination.

<!-- spoken, not printed: an ideal single-wavelength filter reads ZERO on any spectrum with
     a density — a perfectly narrow filter passes no power. Which is why real filters are
     bands. Also: gamma encoding is nonlinear and belongs to display, not measurement,
     like tone mapping. -->

### Slide — Which light reaches a pixel?

- Fix a pixel. Its response to a light field is positive and linear, so — the third time —
  Riesz gives a measure $\Gamma_j$ on $\mathcal X$:
  $$I(j) = \rho\!\left(\int_{\mathcal X}\Gamma_j(dx)\,L_\star(x)\right).$$
  $\Gamma_j$ says how strongly pixel $j$ sees each family of ray states. Building a camera
  means writing these down.
- **Thin lens.** A ray is fixed by a point on the pixel together with a point on the
  aperture: four parameters onto the four dimensions of $\mathcal X$. So $\Gamma_j$ has an
  honest density.
- **Pinhole.** Collapse the aperture to a point. Every point of the pixel now admits
  exactly one direction, so — even integrating over the whole pixel — the support is
  two-dimensional inside four. Still a perfectly good measure. No density.
- The mirror forced the *material* to be a measure. The pinhole forces the *camera* to be
  one.

<!-- Possibly one sentence, possibly nothing: the pairing is only defined when the two
     measures are not both singular. Point light plus pinhole is the one undefined corner —
     a real photograph with no number to compute. He has not decided whether this earns
     slide space. -->

### Slide — A whole camera

- Parametrise a ray by a point $u$ on the pixel together with a point $a$ on the aperture.
  That pair determines a ray, so there is a map
  $$\kappa:\ P_j\times A\ \longrightarrow\ \mathcal X,$$
  and the lens rule lives inside $\kappa$. The camera measure is a pushforward:
  $$\Gamma_j \;=\; \kappa_*\big(w\,dA(u)\,dA(a)\big).$$
- Written out, a thin-lens camera with RGB filtering is
  $$I_c(j)\;=\;\int_{P_j\times A}\int_\Lambda r_c(\lambda)\; L_\star\big(\kappa(u,a)\big)(d\lambda)\;\,w(u,a)\,dA(u)\,dA(a), \qquad c\in\{R,G,B\},$$
  writing $I_c(j)$ for the channel $c$ of the value $I(j)$.
- **Pinhole is the same formula** with $A$ a single point. The measure-versus-density
  distinction is a change in the domain, not a new object.

<!-- spoken, not printed: a flat sensor weighted uniformly is not a uniform sampler of
     directions, and cos^4 measures exactly how far off it is. One clause, no derivation. -->

<!-- SECOND PASS: this is a good candidate for an "unpacking" slide — writing the thing
     out at full size so the audience sees how big these formulas get. Those slides are
     added later, once all the slides exist. -->

## Defining a Photograph

<!-- Not a Part. A named section closing the MODELING half (Parts I–IV); the COMPUTING
     half (Parts V–X) begins after it. -->

- A **light field** attaches a spectrum to each surface state,
  $$L:\mathcal X\longrightarrow\mathscr S_+ .$$
- A **scene** — geometry, materials, emitters — picks out exactly one of them, the solution
  of $L_\star = E + TL_\star$. A scene together with the equilibrium light field it sustains
  is an **illuminated scene**.
- A **camera** images light fields: measure, then respond.
- A **photograph** is the image of an illuminated scene:
  $$\boxed{\,I = C(L_\star),\qquad L_\star = E + TL_\star.\,}$$
- All of this is exact. Nothing has been approximated, nothing random has appeared, and no
  ray has been traced. What we do not have is any way to compute it.

---

# Photographs are Integrals

## Part V. Solving for the Light Field

### Slide — Inversion

- We want to solve the fixed-point equation $L_\star = E + TL_\star$ for $L_\star$. It is
  **linear** once the fixed source has been separated:
  $$(\operatorname{Id}-T)L_\star = E \qquad\Longrightarrow\qquad L_\star = (\operatorname{Id}-T)^{-1}E.$$
- Every round loses energy, $\lVert T\rVert\le c<1$, so the inverse is a **geometric
  series**:
  $$(\operatorname{Id}-T)^{-1} = \sum_{n\ge0}T^{n}.$$
- Applying it to the emitters:
  $$L_\star = \sum_{n\ge0}T^{n}E = E + TE + T^{2}E + T^{3}E + \cdots$$
- Computing the light field has become: **evaluate powers of a fixed operator $T$ on a
  fixed light field $E$.**

### Slide — Iterating the operator

- One generation was $T = R\circ P$: scatter, then look back along the chosen direction to
  the state that supplied it. Written out,
  $$(TL)(x_0) = \int_{\mathcal X}K(x_0,dx_1)\,L(x_1).$$
- Do it again. The inner kernel starts wherever the outer one landed, so the integrals
  **nest**:
  $$(T^{2}L)(x_0) = \int_{\mathcal X}K(x_0,dx_1)\int_{\mathcal X}K(x_1,dx_2)\,L(x_2).$$
- $n$ generations alternate, $T^{n} = RPRP\cdots RP$ — one scatter and one look-back per
  bounce:
  $$(T^{n}E)(x_0) = \int_{\mathcal X}K(x_0,dx_1)\int_{\mathcal X}K(x_1,dx_2)\cdots \int_{\mathcal X}K(x_{n-1},dx_n)\;E(x_n).$$
- Everything is positive, so those nested integrals are a **single integral over
  $\mathcal X^{n}$**, against the product of the kernels. One point of $\mathcal X^{n}$ is a
  chain of states $(x_1,\ldots,x_n)$.

### Slide — The space of paths

- A **path** is a piecewise geodesic curve starting at $p_0$ and meeting $\Sigma$ exactly at
  its $n$ vertices — inside a transparent object as readily as outside, since an opaque one
  simply gives its material no transmission mass. These form the space $\Omega_n(p_0)$.
- Naming a path by its vertices puts coordinates on it: $\Omega_n(p_0)$ is an open subset of
  $\Sigma^{n}$, of dimension $2n$ — the chains whose segments meet $\Sigma$ only at their
  endpoints. Open, because a segment that clears the boundary still clears it if you move
  its ends a little.
- Nothing is lost in that naming. Each $K$ was the material measure pushed along the ray it
  selects, so it already sits on the states pointing back at the previous vertex — and there
  the direction is pinned by the two points.
- **Which chains in $\mathcal X^{n}$ carry mass?** Only those where each state is reachable
  from the one before; $K(x,\cdot)$ charges nothing else. Those chains are exactly the paths
  in the scene, and recording the vertices identifies them with $\Omega_n(p_0)$ — a
  bijection on that set, since two consecutive vertices pin the direction between them.
- So $\Omega_n(p_0)$ contains the support, and the integral is unchanged by moving there.
  The measure is the one we already have: at each vertex $K$ says where the light could have
  come from and with what weight; at the far end $E$ says how much was emitted there:
  $$d\boldsymbol\nu_{x_0,n} = K(x_0,dx_1)\,K(x_1,dx_2)\cdots K(x_{n-1},dx_n)\,E(x_n),$$
  $$(T^{n}E)(x_0) = \int_{\mathcal X^{n}}d\boldsymbol\nu_{x_0,n} = \int_{\Omega_n(p_0)}d\boldsymbol\nu_{x_0,n}.$$

<!-- indexing, worth keeping straight: the SPACE depends only on the starting point p_0,
     since the vertices are free. The MEASURE depends on the whole state x_0 = (p_0, w_0),
     because mu at the first vertex does. -->

### Slide — All lengths at once

- Now sum over lengths:
  $$L_\star(x_0) = \sum_{n\ge0}\int_{\Omega_n(p_0)}d\boldsymbol\nu_{x_0,n},$$
  the $n=0$ term being the path that goes nowhere — the point $p_0$ itself, contributing the
  emission $E(x_0)$.
- A sum of integrals over disjoint spaces is one integral over their union. Put all the
  lengths together:
  $$\Omega(p_0) = \bigsqcup_{n\ge0}\Omega_n(p_0), \qquad \boldsymbol\nu_{x_0} = \sum_{n\ge0}\boldsymbol\nu_{x_0,n}.$$
- The light leaving one state is a single integral over the space of **all finite paths in
  the scene** rooted there:
  $$\boxed{\;L_\star(x_0) = \int_{\Omega(p_0)}d\boldsymbol\nu_{x_0}.\;}$$
- > Paths were not part of the definition of light. They appeared when we inverted the
  > equilibrium operator.


<!-- spoken, not printed: in a curved geometry you would name a path by its initial
     directions instead, since two points need not determine a geodesic between them. -->


## Part VI. Calculating Big Integrals

### Slide — Two enormous integrals

- Both halves of the photograph are now integrals. The light field at one state,
  $$L_\star(x_0) = \int_{\Omega(p_0)}d\boldsymbol\nu_{x_0} = \sum_{n\ge0}\int_{\Omega_n(p_0)}d\boldsymbol\nu_{x_0,n},$$
  and the camera at one pixel,
  $$I_c(j) = \int_{P_j\times A}\int_\Lambda r_c(\lambda)\;L_\star\big(\kappa(u,a)\big)(d\lambda)\;w(u,a)\,dA(u)\,dA(a).$$
- **Count the coordinates.** The $n$-th term integrates over $\Omega_n(p_0)$, which has $2n$
  of them. The camera adds two on the sensor, two on the aperture, one for wavelength.
- And we sum over every $n$. So the dimension is not merely large — it is **unbounded**.
  There is no $d$ to plug in.
- Everything left to do is one question: **how do you compute an integral like this?**

### Slide — Riemann sums, and dimension

- The classical answer is a **Riemann sum**: chop the domain into cells, evaluate $F$
  somewhere in each, weight by the size of the cell, and add.
  $$\int_D F \;\approx\; \sum_i F(z_i)\,\mathrm{vol}(D_i).$$
  It needs three things — a **partition**, a **volume**, and enough **regularity** that one
  sample speaks for its cell.
- **The cells multiply.** $m$ points per axis in $d$ dimensions is $m^{d}$ cells. Ten
  bounces is twenty dimensions, and even two points per axis is already a million. Halving
  the cell size multiplies the cost by $2^{d}$.
- **And no cleverness escapes it.** So the accuracy you can buy decays as the dimension
  grows, and we have no fixed dimension to grow to.

<!-- The n^{-r/d} optimal-rate bound (Bakhvalov 1959) was CUT: it is a worst-case statement
     about a smoothness class, not about our integrand, and the comparison with N^{-1/2}
     is between two different error criteria. Kept in notes-proposed-updates.md. -->

### Slide — The real problem

- The last slide was about cost. This one is about whether the method applies at all.
- **Nothing to partition.** Path space is not a box. It is an open piece of $\Sigma^{n}$ cut
  out by which surface each ray meets, it carries no canonical volume to weight cells by,
  and it does not have a fixed dimension — we are summing over $n$.
- **And no regularity to exploit.** A Riemann sum works because one sample speaks for its
  cell. Our integrand jumps every time a path crosses a silhouette, and between the finitely
  many points a rule evaluates, nothing constrains it at all. So there is no error guarantee
  to be had — not a slow one, none.

<!-- CUT: the small-bright-lamp bullet. It does not separate grid from random — both
     need N ~ 1/eps. Worked out in notes-proposed-updates.md; it landed in Part X, on
     "Most paths report nothing". -->

### Slide — Sampling an integral

- Go back to one dimension, where we can watch what happens. To find $\int_0^1 F$, throw $N$
  points down at random and average the values you land on:
  $$\frac1N\sum_i F(x_i)\ \longrightarrow\ \int_0^1 F(x)\,dx .$$
  No partition, no cells. The points do not have to be spread out evenly — they only have to
  be *drawn* evenly.
- And they do not have to be drawn evenly either. Draw from a density $q$ instead, and
  correct for it: a point that landed where $q$ is small was unlikely, so it has to stand
  for more.
  $$\frac1N\sum_i \frac{F(x_i)}{q(x_i)}\ \longrightarrow\ \int F(x)\,dx .$$
- **On path space we have no choice about this.** A single stratum $\Omega_n(p_0)$ does
  carry an area measure, but the lengths are summed and their graded union has no natural
  normalisation, so there is no uniform law to draw from. All we can do is run a process we
  already have: stand at a vertex, pick a direction, follow it, repeat.
- So sample from whatever law $Q$ that process gives, and divide by how likely the path we
  drew was. With no volume in sight, "how likely" is a comparison between the measure we
  want the total of and the measure we drew from:
  $$\widehat J(Z) = F(Z)\,\frac{d\mu}{dQ}(Z),\qquad \mathbb E_Q\big[\widehat J\big] = J .$$

<!-- How the derivative factorises over the walk: notes-proposed-updates.md. -->

### Slide — What that buys

- **Unbiased for any dominating proposal.** Domination is the correctness condition —
  everything that can contribute has to be reachable. Everything else is efficiency.
- **A guarantee where there was none.** Average $N$ samples and the answer has standard
  deviation
  $$\sqrt{\operatorname{Var}\big(\widehat J\big)/N}.$$
  Finite variance is the only hypothesis — no smoothness, no partition, no cells — and in
  exchange we get a number that shrinks, and we know how fast.
- **No dimension in the exponent.** $N^{-1/2}$ whatever the path length — and no fixed $d$ is
  required anywhere, which is what lets us sum over $n$ at all.

<!-- No talk about WHICH proposal here. Importance sampling is Part IX. -->

## Part VII. Our First Photograph

<!-- [TITLE PROVISIONAL — alternative "Storing the Light Field".] WRITTEN, six slides.
     No roulette, no adjoint, no throughput recursion — all cut as too much detail.
     HE HAS DEMOS FOR THIS PART; they land on "One field, many photographs". -->

### Slide — Two stages, in order

- **The aim is the whole light field, not one picture.** Nothing in $L_\star = E + TL_\star$
  mentions a camera. The field belongs to the scene, so compute it once and photograph it as
  many times as you like, from wherever you like.
- **Both halves are integrals, and we have one method for integrals.** So run it twice:
  Monte Carlo for the field, then Monte Carlo for the camera.
- **The two are chained.** $L_\star$ is what the first stage produces and what the second
  stage integrates — it sits inside the camera integrand, evaluated wherever the lens happens
  to look.
- **So the first stage has to return a function and keep it.** One estimate gives the field
  at one state, and we do not know in advance which states a camera will ask about.

$$\text{scene}\ \xrightarrow{\ \text{Monte Carlo}\ }\ L_\star\ \xrightarrow{\ \text{Monte Carlo}\ }\ I$$

<!-- Schematic only — do NOT re-display the two integrals, Part VI slide 1 already did.
     He is adding his own drawings and notation to this. -->

### Slide — Storing a light field

- **The first stage has to hand over a function on a four-dimensional space.** A light field
  assigns a spectrum to every state — a point of $\Sigma$ together with a direction — and no
  computer holds that.
- **So discretise the domain and store values on it.** Pick a finite set of states
  $x_{\vec\imath}\subset\mathcal X$ and interpolate between them. The geometry makes this
  easy: $\mathcal X$ is a sphere bundle over the surfaces, so the four dimensions come
  already split two and two — chop up the surfaces, chop up the sphere of directions at each
  point.
- **At each stored state we solve a path integral.** $L_\star(x_{\vec\imath})$ is exactly the
  rooted integral of Part V: all finite paths starting at that state. So run thousands of
  samples, average them, and write down the result. Do that at every $\vec\imath$ and the
  array is the field.

### Slide — Computing the path integrals

- **A sample is a path, and what it returns is a spectrum.** Not a brightness at one
  wavelength — the whole spectrum, from a single walk through the geometry.
- **At every vertex we ask the material what it returns.** Part III made the material a
  measure on directions *valued in multipliers*, so the answer is a multiplier: the fraction
  of each wavelength sent onward.
- **The path ends somewhere emitting, and that emission is a spectrum.** Apply the
  accumulated product of multipliers to it. That is what the path contributes.
- **Then weight it by how likely it was.** We did not draw paths in proportion to the measure
  we are integrating, so the sample is corrected by comparing the two — one factor per
  vertex, accumulated as the walk proceeds.

### Slide — Photographing what we stored

- **What we stored is a light field, so every state carries a spectrum.** The sensor takes
  that spectrum and turns it into a value — there is no wavelength left to sample.
- **Monte Carlo again.** The camera integral runs over the pixel and the aperture. So sample
  it: a random point in the pixel, a random point on the lens. The lens rule turns that pair
  into a ray; look up the stored field along it, and average.
- **Four dimensions is small.** This integral is done in a fraction of a second.

### Slide — One field, many photographs

- **The field belongs to the scene, not to the camera.**
- **So photograph it again.** Refocus, change the aperture, move the camera, turn it around.
  Each new picture is a fraction of a second.

<!-- His visuals go here. -->

### Slide — Too good to be true?

- **We made a choice before computing anything.** Where to store values, and how finely.
  Everything since has been computed against that choice.
- **So what we photograph is not the light field.** It is the field reconstructed from
  finitely many stored values, and those are two different functions.
- **And running longer does not close the gap.** More samples make each stored value more
  accurate; they do not add values. The pictures converge — to the field we chose to
  represent, not to the one in the room.
- **Only finer storage moves it, and storage is four-dimensional.** Halve the spacing and pay
  sixteen times the memory.




## Part VIII. The Pathtracing Algorithm

<!-- [TITLE PROVISIONAL — alternative "Following the Camera".] WRITTEN, six slides.
     The story is EXACTNESS. The adjoint and the mathematics-to-program correspondence
     table are both cut from the talk. -->

### Slide — What we are asking for

- **We know how to compute an integral.** Hand Monte Carlo a space, a measure and an
  integrand, give it a proposal that reaches everywhere the integrand lives, and the average
  of the samples converges to the integral.
- **And it gives more than a limit.** The expectation of a single sample is already the
  integral, exactly — for every number of samples, including one. There is no systematic
  offset that averaging grinds away; there was never an offset. That is what **unbiased**
  means.
- **But it is exact about the integral you hand it.** All of that strength is aimed at
  whatever was written down. Approximate something before writing it down and Monte Carlo
  will faithfully, unbiasedly, converge to the wrong number.
- **So the whole job is to write each pixel as one integral.** One space, one measure, one
  integrand, with total exactly $I(j)$ — and "one" is not a fiction, since Part V already put
  every path length into a single space.

### Slide — One integral, not two

- **We asked for a single integral, and we have two.** The pixel value is the camera applied
  to the light field, and the light field is itself an integral over paths. Two integrals,
  chained.
- **Chaining is what forced the storage.** The output of the first has to be available as the
  integrand of the second, wherever the camera happens to look — so it has to be written down
  somewhere first, and writing it down is the approximation.
- **So substitute instead of storing.** Compose the two before evaluating anything:
  $$I = C\,(\operatorname{Id}-T)^{-1}E.$$
  The field appears only as a subexpression. It never becomes an object, so there is nothing
  to store and nothing to discretise.
- **And that is the single integral we asked for.** The camera's variables and the path's
  vertices now sit in one domain, integrated once.

<!-- Operator form only here — the expansion at full size is the next slide's job. -->

### Slide — The path is still carrying a spectrum

- **One approximation is gone. There is another.** Nothing is stored between the two integrals
  now, but look at what a path returns: the emission it reaches, filtered by every surface
  along the way. That is a spectrum — a measure on wavelengths.
- **No computer holds a spectrum.** It is a function on $\Lambda$, so anything carrying one is
  really carrying a finite stand-in: a few bins, a few coefficients. The same approximation as
  before, moved inside the path.
- **So expand the sensor response.** Part IV defined it as an integral over wavelength. Write
  that integral out, and $\lambda$ stops being packaged inside the spectrum and becomes an
  integration variable alongside the pixel point, the lens point and the vertices.

### Slide — The whole thing

- **Substitute the path integral into the camera integral and write out every factor.** For
  pixel $j$ and channel $c$:
  $$I_c(j)\;=\;\sum_{n\ge0}\;\int_{P_j}\!\int_{A}\!\int_{\Lambda}\!\int_{\Omega_n(p_0)}
  r_c(\lambda)\;w(u,a)\;K_\lambda(x_0,dx_1)\,K_\lambda(x_1,dx_2)\cdots K_\lambda(x_{n-1},dx_n)
  \;E(x_n,d\lambda)\;dA(u)\,dA(a),$$
  where $x_0=\kappa(u,a)$ is the state the camera ray starts in.
- **Every piece of it was built in this talk.** $r_c$ and $w$ and $\kappa$ are the camera,
  $K_\lambda$ is the material at one wavelength, $E$ is the emission, $\Omega_n$ is the paths.
- **Name the states the lens can look along.** Part V wrote $\Omega_n(p_0)$ for the paths of
  $n$ vertices leaving a single state. Let $\Omega_n(U)$ mean the same with the starting state
  anywhere in a set $U\subseteq\mathcal X$. Then $\kappa$ carries the film and the lens into a
  set $\mathcal C_j$, and the paths this integral runs over are $\Omega_n(\mathcal C_j)$.
- **What the domain is.** A wavelength bundle over $\Omega_n(\mathcal C_j)$ — a path now starts
  *inside the camera*, at a point on the film and a point on the lens, before it ever reaches
  a surface, and over each such path sits a copy of the visible spectrum. The fibres are the
  same set every time but not the same measure: how much sits over a path depends on which
  emitter it reached.
- **And it is one integral.** Take the lengths disjointly and add their measures:
  $$\boxed{\;I_c(j)=\int_{\mathcal P_j} r_c\;d\boldsymbol\mu_j\;}$$
- **Nothing in it is approximated.** No stored field, no binned spectrum, no discretisation
  anywhere — which is exactly what we asked for.

<!-- Display should look BIG. Do not compactify the sum or the chain of kernels.
     The inner domain stays Omega_n(p_0): inside the (u,a) integral the root IS fixed.
     Omega_n(C_j) is what you get after collecting the outer integrals. -->



### Slide — What a sample looks like

- **One sample is one walk, starting at the camera.** A point in the pixel and a point on the
  lens name a ray; the ray finds a first vertex.
- **A colour is chosen before anything moves — but the light is at the far end.** Materials
  respond differently at every wavelength, so we must pick one to begin. We only learn which
  emitter we reached when we stop, so we choose up front and pay there.
- **Then the walk, in scalar arithmetic.** Ask each material which way to go, follow it, and
  stop after a randomly drawn number of bounces — the length is a coordinate like any other —
  taking the emission where you land, divided by the chance of that length. No spectra are
  carried — every factor is a number at our wavelength.
- **Draw the wavelength from every lamp at once.** A mixture of the emitters' spectra reaches
  anything any of them can emit, sharp lines included.
- **The sensor makes it a colour.** Evaluate the response at our wavelength and deposit. The
  response is a vector, so one walk lands in every channel.

### Slide — Our first unbiased photograph

- **Average many walks per pixel.** Noisy at one sample, clean at a thousand — and converging
  to the photograph itself, with no floor to stop at.
- **The camera is fixed from the start.** The viewpoint entered the integral at the first
  vertex. Move it, or refocus, and the whole render begins again.
- **And you have to be patient.** [samples per pixel, and how long these actually took.]

<!-- His images go here. -->


## Part IX. Getting Better at Integration: Statistics

<!-- The image is already correct. Everything in Parts IX and X is optional. -->

### Slide — What we are still free to choose

- **More samples buys less and less.** Four times the samples halves the noise. Ten times
  gets you a factor of three. The price rises faster than the payoff.
- **So improve the samples, not the count.** How good a picture is after an hour depends on
  two things: how long one sample takes, and how much one sample tells us.
- **How long a sample takes.** We have been walking until a randomly chosen length, and
  spending most of that walk on vertices whose contribution is negligible.
- **How much a sample tells us.** The spread is the variance of the weight
  $\dfrac{d\boldsymbol\mu}{dQ}$, divided by $\sqrt N$. It depends on two things, and the scene
  fixes one of them: $\boldsymbol\mu$ is given. $Q$ — the law we drew paths from — was never
  determined by anything. We chose directions from the materials because it was convenient
  while walking.

### Slide — Summing a Series

- **We sample the length like anything else, and then use one term of it.** A walk drawn at
  length $N$ reports the $N$-bounce contribution, though it visited every shorter path on the
  way there.
- **Count every prefix.** Each vertex the walk reaches ends a shorter path we have already
  paid for. Collect what it emits, and one walk reports them all.
- **Reweighting is what makes that legitimate.** Keep the terms up to a random $J$, each
  divided by the chance of having got that far:
  $$\widehat S=\sum_{j\le J}\frac{\Delta_j}{\Pr(J\ge j)},\qquad \mathbb E\big[\widehat S\big]=S.$$
  One line of Fubini, and nothing is assumed about the terms.
- **And $\Pr(J\ge j)$ is ours to choose.** So stop when continuing has become useless — when
  what the path carries is too small to matter.

<!-- This is Russian roulette; the name is not used. Mathematically it is unbiased
     randomized truncation of a series. Aside if wanted: von Neumann and Ulam
     invented it to invert matrices, Kahn carried it into neutron transport,
     Arvo & Kirk brought it to ray tracing forty years later. -->

### Slide — Where the samples go

- **Monte Carlo was always defined against a distribution.** The estimate averages
  $d\boldsymbol\mu/dQ$ over draws from $Q$, and any $Q$ reaching everywhere the integrand
  lives is correct. We have only ever used the one that was convenient.
- **One dimension, one bump.** Integrate a narrow Gaussian across a wide interval. Draw
  uniformly and nearly every sample lands where the integrand is nothing; the answer rides on
  the rare few, and the average takes forever to settle.
- **Draw from the bump instead.** Sample a normal matched to it and every sample lands where
  the mass is. The closer the law is to the shape of the integrand, the less the weights
  vary — and the fewer samples you need.
- **Nothing there mentioned dimension.** It is the same move on path space, and we have been
  making it all along: directions come from the material's own measure, wavelengths from the
  lamps' spectra, lengths from what the path still carries.

<!-- Glossy materials in speech, not on the slide: a strong glossy reflection is
     sampled from a law peaked toward the reflected direction rather than scattering
     over the sphere. -->

## Part X. Getting Better at Integration: Geometry

<!-- Everything here is derived in PATH SPACE. The adjoint stays in the notes.
     Frame: growing and joining, never cutting. -->

### Slide — Most paths report nothing

- **A path that ends on a wall is worth nothing.** A perfectly good chain, a perfectly good
  weight, and nothing at the far end that emits — so the whole product is zero.
- **Shrink the lamp and nearly every path is one of those.** The walk finds the emitter by
  accident, and accidents get rarer as the target gets smaller.
- **With a point light it never finds it.** A single point has no mass in the material's
  measure, so those paths are not merely rare — they are never proposed at all.

### Slide — Reverse it?

- **Start at the lamp and every path begins on emission.** No accident required at that end —
  the chain is emitting from its first vertex.
- **But now it has to arrive at the lens.** Grow it outward and it lands wherever it lands,
  and almost never on the aperture. A pinhole is a point, so it never does at all.
- **And these are worse than wasted.** A camera path that misses the light is a point of the
  integral contributing zero. A light path that misses the camera is not a point of the
  integral at all — it was never one of the things we were summing.

### Slide — Start at both ends

- **The lights are a set of states too.** A panel emits along many directions from each of its
  points, so there is no single root to name — the light subpaths are
  $\Omega_s(\operatorname{supp}E)$, exactly as the camera subpaths are $\Omega_t(\mathcal C_j)$.
- **Grow $t$ vertices from one and $s$ from the other, and concatenate.**
  $$\Omega_t(\mathcal C_j)\times\Omega_s(\operatorname{supp}E)\longrightarrow \Sigma^{s+t}$$
  is injective once the split is known, and it lands in path space exactly where the one new
  edge is unoccluded — an open subset of the product.
- **So visibility is not a factor; it is the domain.** Nothing about the joining edge is
  sampled, since both its endpoints are already in hand. Whether it is clear is the condition
  cutting the image out.
- **And the measure nearly factors.** Every edge of the finished chain belongs to one side or
  the other except the join:
  $$\underbrace{K(x_0,dx_1)\cdots K(x_{t-2},dx_{t-1})}_{\text{camera side}}\;
  \underbrace{K(x_{t-1},dy_{s-1})}_{\text{the join}}\;
  \underbrace{K(y_{s-1},dy_{s-2})\cdots K(y_1,dy_0)\,E(y_0)}_{\text{light side}}$$
  Two independent walks, one connecting factor.
- **Read the light side backwards.** Those kernels run from the camera outward, but the light
  walk generated those vertices in the opposite order. That the two agree is **reciprocity** —
  a hypothesis about materials, not a theorem, and one that fails for refraction.

### Slide — The same path, many ways

- **Every split is a strategy.** How many vertices come from each end is ours to choose, and
  each choice is a different way of producing complete paths.
- **A path with $k$ vertices comes only from the splits with $s+t=k$.** The ways of building
  one path form a diagonal, and moving along it slides the connecting edge along the path.
- **Not every split on that diagonal can produce it.** The connection demands the material's
  response along one specified direction. A mirror's response is concentrated at a single
  direction, so unless the edge lands exactly there — probability zero — there is nothing to
  evaluate, and that split yields nothing.

### Slide — Sharing a path

- **Add them up and the light is counted several times.** Every split is a fine estimator on
  its own, but a chain produced by five of them is reported five times.
- **Keeping only one is worse.** Each split is good exactly where the others are bad, which is
  why we built them all — discard the rest and you discard the paths they were for.
- **So share the contribution.** Divide each path among the splits that produce it, in shares
  summing to one. Any such division is correct; the expectation is untouched.
- **Share it by who was likely to find it.** Give each split the share of the mixture it
  accounts for at that path, so the one that produces it easily carries it and the one that
  stumbles on it rarely stays quiet. The mixture is its own reference — no split needs a
  density, so the singular ones are legal too.

### Slide — A set of measure zero

- **Fix the combinatorics.** Which surfaces the chain meets, in what order, and which of those
  are specular. Call it $\tau$, with $k$ specular vertices. The candidate chains form a stratum
  $$\Omega_\tau \subset \Sigma^{\,k+2}, \qquad \dim\Omega_\tau = 2(k+2).$$
- **The physical ones satisfy two conditions per specular vertex.**
  $$\mathcal M_\tau \subset \Omega_\tau, \qquad \operatorname{codim}\mathcal M_\tau = 2k .$$
- **So no proposal with a density reaches it.** A connection fixes two vertices and tests the
  straight line between them, and $Q(\mathcal M_\tau)=0$ for any $Q\ll$ the area measure.
  Reweighting moves responsibility between the strategies we hold; it does not supply one we
  lack.

### Slide — They are a critical set

- **Hold the two ends and let the specular vertices move.** Coordinates
  $u=(u_1,\dots,u_k)$, two per vertex, and optical path length is a function of them alone:
  $$\ell(u) = \sum_i \eta_i\,\lvert x_{i+1}-x_i\rvert .$$
- **The physical chains are its critical points.** At one vertex,
  $$\frac{\partial\ell}{\partial x_i} = \eta_{i-1}\hat d_{i-1}-\eta_i\hat d_i ,$$
  and $x_i$ is confined to a surface, so criticality asks only that this be normal — which
  *is* the law of reflection when $\eta_{i-1}=\eta_i$, and Snell's when they differ.
  $$\boxed{\;\mathcal M_\tau = \{\,\nabla_{\!S}\,\ell = 0\,\}\;}$$
- **And $2k$ equations in $2k$ unknowns.** Forgetting the specular vertices,
  $$\pi:\mathcal M_\tau\longrightarrow \Sigma\times\Sigma,$$
  is a map between spaces of the same dimension: over a fixed pair of ends, finitely many
  chains.

<!-- Nothing about reflection is assumed here; both laws fall out of one derivative. -->

### Slide — Solve instead of sampling

- **Newton on the gradient.**
  $$u_{m+1} = u_m - \big(\operatorname{Hess}_{\!S}\,\ell(u_m)\big)^{-1}\nabla_{\!S}\,\ell(u_m),$$
  then reproject onto the surfaces. Both halves come from differentiating one function twice,
  and $\operatorname{Hess}_S\ell$ is block tridiagonal, since $\ell$ couples only adjacent
  vertices.
- **Weight what you land on.** Materials, emission, and the density of $\pi$ — which by the
  implicit function theorem is $\lvert\det\operatorname{Hess}_S\ell\rvert^{-1}$.
- **Then pay for the guess.** We need $1/p$, the chance a random seed converges here, and $p$
  is the area of a set in seed space we cannot measure. So repeat from fresh seeds until the
  same chain returns:
  $$\Big\langle \tfrac1p\Big\rangle = \#\{\text{trials until it reappears}\},\qquad
  \mathbb E\Big[\Big\langle\tfrac1p\Big\rangle\Big] = \tfrac1p .$$
- **Everything degenerates together.** $\det\operatorname{Hess}_S\ell=0$: two chains merge and
  vanish, the weight blows up, and Newton stalls. That is the arc.

<!-- UNVERIFIED: the geometry factor is written as |det Hess|^-1, the right shape by the
     implicit function theorem. The SMS paper's generalised geometry term carries further
     factors that were NOT checked. Verify before this is final. -->

### Slide — The pictures

<!-- His final images. §50 is NARRATED over this, not on a slide: the arc is the
     set of critical values of the ray map; by Whitney only folds and cusps are
     stable, so real caustics are arcs meeting at cusps and never a point; and the
     closed-form curve for the circle laid over what the sampler found. -->
