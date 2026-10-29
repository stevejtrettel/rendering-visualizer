// Where the three.js eye sits for each scene. This is a VIZ concern, not a
// scene one — the CPU camera lives in the SceneDescription; this is the
// separate vantage the trajectory pages look at the box from.
export interface VizView {
  eye: readonly [number, number, number];
  target: readonly [number, number, number];
}

// The Cornell box is deep and only visible through its ghosted front wall,
// so the view axis stays close to the box axis — a near-head-on eye with a
// small offset for depth cues. It sits close enough that the box's near
// walls fall outside the frame: these pages are about the PATHS, which have
// to be big enough to read, and a wider vantage leaves them a few pixels
// long. Dead-centre in x so both side walls frame symmetrically, and low
// enough to look UP at the ceiling — the emitter is flush with the ceiling,
// so an eye at ceiling height hides the very thing a path ends on.
const CORNELL_VIEW: VizView = { eye: [0, 2.8, 15.5], target: [0, 1.5, 1.0] };
const OPEN_STAGE_VIEW: VizView = { eye: [7.5, 5.5, 13], target: [0, 1.2, 0] };
const MATERIAL_ROW_VIEW: VizView = { eye: [4.5, 3.2, 11], target: [0, 0.8, 0] };
// material-test is a SMALL box — 2.6 x 2.3 x 3.9, sized to the sphere rather
// than to a room — so the vantage sits close. The Cornell one is ten units
// out and would leave this scene a thumbnail in the middle of the frame.
const MATERIAL_TEST_VIEW: VizView = { eye: [2.2, 2.9, 6.1], target: [0, 1.0, 0.4] };

// cornell-short is a cube with an open front and the camera outside it: a
// near-head-on view, offset to one side, looks in through the opening with
// the eye and film in front of it (a side view hides one wall's interior),
// from below ceiling height so the lamp on the ceiling is in view.
const CORNELL_SHORT_VIEW: VizView = { eye: [6.4, 2.7, 13.2], target: [0, 2.1, 2.4] };

export function vizViewFor(name: string): VizView {
  if (name === 'cornell-short') return CORNELL_SHORT_VIEW;
  if (name === 'open-stage') return OPEN_STAGE_VIEW;
  if (name === 'material-row') return MATERIAL_ROW_VIEW;
  if (name === 'material-test') return MATERIAL_TEST_VIEW;
  return CORNELL_VIEW;
}
