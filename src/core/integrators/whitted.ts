// Whitted's 1980 ray tracer, the talk's naive tracer (Steve, 2026-11-03: the
// "fake 1980 tracer", built as passes). Moved here from the rasterize demo so
// whitted-room renders with exactly the same code.
//
// At the first surface a ray meets, the passes record
//
//   albedo      c   the surface colour
//   brightness  b   cos theta, the angle to the light
//   shadow      v   does a ray from there reach the light: 1 or 0
//   phong       h   (R . V)^shininess on a shiny surface (R the direction to
//                   the light mirrored about the normal, V toward the viewer)
//   reflection  r   on the mirror: what the reflected ray sees
//   refraction  t   on the glass: what the ray bent through it sees
//
// and the colour is c (A + (1 - A) b v) + ks h v (lamp colour), each factor
// only once its pass is in, A the ambient floor; on the mirror c r in place
// of the first term, on the glass t (clear, untinted). What a reflected or
// bent ray sees is the whole recipe again where it lands, and if that is the
// mirror or the glass, again, up to maxDepth (then black): the tracer calling
// itself. The glass bends by Snell's law going in and coming out; past the
// critical angle it reflects inside instead; with the reflection pass in too
// it mixes in Fresnel's share of the reflected ray. The light is a point at
// the lamp's centre, so shadows are hard, and shadow rays stop at the glass
// as at anything else (Whitted's, and its known fault: real glass focuses
// light into a caustic). The lamp itself is not shaded.
import { Vec3 } from '../math/vec3';
import { Ray } from '../math/ray';
import { visible } from '../geometry/visibility';
import { offsetRayOrigin } from '../geometry/offset';
import { frDielectric } from '../materials/fresnel';
import { surfaceColors } from './first-hit';
import type { SceneDescription, buildScene } from '../scene/scene';

export const WHITTED_PASSES = ['albedo', 'brightness', 'shadow', 'phong', 'reflection', 'refraction'] as const;
export type WhittedPass = (typeof WHITTED_PASSES)[number];
export type RGB = [number, number, number];
type Aggregate = ReturnType<typeof buildScene>['aggregate'];
export type Hit = NonNullable<ReturnType<Aggregate['intersect']>>;

/** What the passes record where a ray lands. */
export interface Look {
  c: RGB;
  b: number;
  v: number;
  h: number;
  ks: number;
  lamp: boolean;
  /** The glass: clear, so what passes through it is not tinted. */
  glass: boolean;
  /** A partly reflective surface's share of reflection (0 for none; the perfect mirror is not counted here). */
  kr: number;
}

export interface WhittedOptions {
  /** Where shadow rays and bounced rays are traced. */
  agg: Aggregate;
  /** The primitive treated as a perfect mirror, tinted its own colour. */
  mirror?: string | null;
  /**
   * Partly reflective surfaces, each with its share of reflection kr: the
   * colour is (1 - kr) (its own shading) + kr (what its mirror ray sees),
   * untinted, as under a clear coat. Once the reflection pass is in.
   */
  reflective?: Record<string, number>;
  /** The primitive treated as clear glass. */
  glass?: string | null;
  ior?: number;
  ambient?: number;
  shininess?: number;
  /** Phong strength per primitive; 0 (matte) for any not listed. */
  ks?: Record<string, number>;
  /** Phong power per primitive, where it differs from `shininess`. */
  power?: Record<string, number>;
  maxDepth?: number;
}

export const BLACK: RGB = [0, 0, 0];

/**
 * The tracer for one scene. `desc` names the surfaces (their colours, which
 * are two-sided walls, the lamp); `opts.agg` is where the rays go.
 */
export function whittedTracer(desc: SceneDescription, opts: WhittedOptions) {
  const { agg, mirror = null, reflective = {}, glass = null, ior = 1.5, ambient = 0.2, shininess = 30, ks: KS = {}, power = {}, maxDepth = 8 } = opts;
  const colours = surfaceColors(desc);
  const lampDesc = desc.primitives.find((p) => p.emission);
  if (!lampDesc || lampDesc.shape.kind !== 'quad') throw new Error('whittedTracer expects a quad lamp');
  const lampName = lampDesc.name ?? 'light';
  const { q, e1, e2 } = lampDesc.shape;
  const lampV = new Vec3(q[0] + (e1[0] + e2[0]) / 2, q[1] + (e1[1] + e2[1]) / 2, q[2] + (e1[2] + e2[2]) / 2);
  /** The lamp's centre as a surface point, facing down into the room: where shadow rays aim. */
  const lampPoint = { p: lampV, ng: new Vec3(0, -1, 0) };
  const lc = colours.get(lampName)!;
  const lampColour: RGB = [lc.r, lc.g, lc.b];
  const twoSided = new Set(desc.primitives.filter((p) => p.shape.kind === 'quad').map((p) => p.name));

  const nameOf = (hit: Hit) => (hit.primitive as unknown as { name: string }).name;
  const isMirror = (hit: Hit) => mirror !== null && nameOf(hit) === mirror;
  const isGlass = (hit: Hit) => glass !== null && nameOf(hit) === glass;
  /** Partly reflective (see `reflective`). */
  const isGlossy = (hit: Hit) => (reflective[nameOf(hit)] ?? 0) > 0;
  /** Sends a ray on as a mirror does: the mirror, or a partly reflective surface. */
  const reflects = (hit: Hit) => isMirror(hit) || isGlossy(hit);

  /** At a hit seen from `viewer` (a wall is two-sided: its normal turned to the viewer's side). */
  function lookAt(hit: Hit, viewer: Vec3): Look {
    const name = nameOf(hit);
    const col = colours.get(name)!;
    const c: RGB = [col.r, col.g, col.b];
    const isGlassHere = name === glass;
    const kr = reflective[name] ?? 0;
    if (name === lampName) return { c, b: 1, v: 1, h: 0, ks: 0, lamp: true, glass: isGlassHere, kr: 0 };
    let n = hit.ns;
    if (twoSided.has(name) && n.dot(viewer.sub(hit.p)) < 0) n = n.neg();
    const l = lampV.sub(hit.p).normalize();
    const cos = n.dot(l);
    const b = Math.max(0, cos);
    const v = visible(agg, { p: hit.p, ng: hit.ng }, lampPoint) ? 1 : 0;
    const ks = KS[name] ?? 0;
    const R = n.scale(2 * cos).sub(l);
    const h = ks > 0 && cos > 0 ? Math.max(0, R.dot(viewer.sub(hit.p).normalize())) ** (power[name] ?? shininess) : 0;
    return { c, b, v, h, ks, lamp: false, glass: isGlassHere, kr };
  }

  /** The colour where a ray lands, with the passes in `use`; `passed` is what the mirror or glass passes on (null elsewhere). */
  function colourWith(look: Look, use: ReadonlySet<WhittedPass>, passed: RGB | null): RGB {
    if (look.lamp) return look.c;
    const v = use.has('shadow') ? look.v : 1;
    const diffuse = use.has('brightness') ? ambient + (1 - ambient) * look.b * v : use.has('shadow') ? ambient + (1 - ambient) * v : 1;
    const spec = use.has('phong') ? look.ks * look.h * v : 0;
    const own = look.c.map((x) => x * diffuse);
    const base = !passed
      ? own
      : look.glass
        ? passed
        : look.kr > 0
          ? own.map((x, ch) => (1 - look.kr) * x + look.kr * passed[ch]!)
          : look.c.map((x, ch) => x * passed[ch]!);
    return [base[0]! + spec * lampColour[0], base[1]! + spec * lampColour[1], base[2]! + spec * lampColour[2]];
  }

  /** d mirrored about the normal n. */
  const reflectDir = (d: Vec3, n: Vec3) => d.sub(n.scale(2 * d.dot(n)));
  /** Snell's law: d bent through a surface whose normal n faces back against it, eta = n1 / n2; null past the critical angle. */
  function refractDir(d: Vec3, n: Vec3, eta: number): Vec3 | null {
    const cosI = -d.dot(n);
    const k = 1 - eta * eta * (1 - cosI * cosI);
    return k < 0 ? null : d.scale(eta).add(n.scale(eta * cosI - Math.sqrt(k)));
  }
  /** Where a ray leaving the surface at `from` in direction `dir` lands next. */
  const cast = (from: Hit, dir: Vec3) => agg.intersect(new Ray(offsetRayOrigin(from.p, from.ng, dir), dir));
  /** The glass at a hit, for a ray arriving along d: the bent direction (null on total internal reflection), the mirrored one, Fresnel's share reflected. */
  function glassAt(d: Vec3, hit: Hit) {
    const entering = d.dot(hit.ns) < 0;
    const n = entering ? hit.ns : hit.ns.neg();
    return { through: refractDir(d, n, entering ? 1 / ior : ior), off: reflectDir(d, n), F: frDielectric(-d.dot(hit.ns), ior) };
  }
  /** The colour a ray travelling along d sees where it lands: the whole recipe again. */
  function seen(d: Vec3, land: Hit | null, use: ReadonlySet<WhittedPass>, depth: number): RGB {
    if (!land || depth > maxDepth) return BLACK;
    // Inside the glass, the far side is just more glass: no shading there.
    if (isGlass(land) && d.dot(land.ns) > 0 && use.has('refraction')) return passedOn(d, land, use, depth)!;
    return colourWith(lookAt(land, land.p.sub(d)), use, passedOn(d, land, use, depth));
  }
  /**
   * What the mirror or the glass at `hit` passes on to a ray arriving along
   * d (null anywhere else, or before its pass is in).
   */
  function passedOn(d: Vec3, hit: Hit, use: ReadonlySet<WhittedPass>, depth: number): RGB | null {
    if (reflects(hit) && use.has('reflection')) {
      const dir = reflectDir(d, hit.ns);
      return seen(dir, cast(hit, dir), use, depth + 1);
    }
    if (isGlass(hit) && use.has('refraction')) {
      const g = glassAt(d, hit);
      const off = () => seen(g.off, cast(hit, g.off), use, depth + 1);
      if (!g.through) return off();
      const through = seen(g.through, cast(hit, g.through), use, depth + 1);
      if (!use.has('reflection')) return through;
      const r = off();
      return [0, 1, 2].map((ch) => g.F * r[ch]! + (1 - g.F) * through[ch]!) as RGB;
    }
    return null;
  }
  /** For drawing: the path a ray takes from `hit` off the mirror and through the glass, to the first other surface (or a point far out). */
  function bouncePath(d: Vec3, hit: Hit): { pts: Vec3[]; landName: string | null } {
    const pts = [hit.p];
    let cur = hit;
    let dir = d;
    for (let depth = 0; depth < maxDepth; depth++) {
      if (reflects(cur)) dir = reflectDir(dir, cur.ns);
      else if (isGlass(cur)) {
        const g = glassAt(dir, cur);
        dir = g.through ?? g.off;
      } else break;
      const next = cast(cur, dir);
      if (!next) {
        pts.push(cur.p.add(dir.scale(6)));
        return { pts, landName: null };
      }
      pts.push(next.p);
      cur = next;
    }
    return { pts, landName: nameOf(cur) };
  }
  /** A camera ray's colour with the passes in `use`, traced in `primary` (default: agg); black where it meets nothing. */
  function trace(ray: Ray, use: ReadonlySet<WhittedPass>, primary: Aggregate = agg): RGB {
    const hit = primary.intersect(ray);
    if (!hit) return BLACK;
    return colourWith(lookAt(hit, ray.o), use, passedOn(ray.d, hit, use, 0));
  }

  return { nameOf, isMirror, isGlass, isGlossy, reflects, lookAt, colourWith, passedOn, bouncePath, trace, lampColour };
}
