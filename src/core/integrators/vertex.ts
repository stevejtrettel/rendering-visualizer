import type { Vec3 } from '../math/vec3';
import type { Color } from '../math/color';
import type { Sample2D } from '../math/sampling';
import type { SurfaceBSDF } from '../materials/surface';
import type { ScenePrimitive } from '../scene/scene';
import type { PinholeCamera } from '../scene/camera';
import type { Light } from '../lights/light';

// One vertex of a materialized transport path. Endpoints (camera, light) are
// first-class entries. Vertices keep live references (bsdf, endpoint object)
// because BDPT's MIS evaluates directions that were never sampled — this is
// why the serializable PathRecord is a lossy flatten of this type.
export interface PathVertex {
  type: 'camera' | 'light' | 'surface';
  p: Vec3;
  ng: Vec3;
  ns: Vec3;
  uv: Sample2D;
  // Cumulative throughput of the path prefix ARRIVING at this vertex
  // (scatter at this vertex not yet applied) — connections need it at
  // every possible junction.
  beta: Color;
  // Area-measure densities. pdfRev is written backward by the walk when the
  // NEXT vertex is sampled; endpoints and path tails keep 0 until a later
  // stage (BDPT) fills their role-dependent values.
  pdfFwd: number;
  pdfRev: number;
  // A delta lobe was sampled LEAVING this vertex. Distinct from bsdf flags;
  // temporarily rewritten by BDPT's MIS.
  delta: boolean;
  // Direction toward the previous vertex (world), null at the path start.
  wo: Vec3 | null;
  // Sampled outgoing direction (world), null at the path end.
  wiSampled: Vec3 | null;
  bsdf: SurfaceBSDF | null; // surface vertices only
  primitive: ScenePrimitive | null; // surface vertices only
  camera: PinholeCamera | null; // camera endpoint only
  light: Light | null; // light endpoint only (V2)
}

export function cameraVertex(camera: PinholeCamera, beta: Color): PathVertex {
  return {
    type: 'camera',
    p: camera.eye,
    ng: camera.eye.scale(0), // no meaningful normal for a pinhole
    ns: camera.eye.scale(0),
    uv: [0, 0],
    beta,
    pdfFwd: 1, // delta position, by the delta convention
    pdfRev: 0,
    delta: false,
    wo: null,
    wiSampled: null,
    bsdf: null,
    primitive: null,
    camera,
    light: null,
  };
}
