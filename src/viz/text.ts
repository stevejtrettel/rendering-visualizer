/**
 * Text in the scene.
 *
 * This has to be *inside* the canvas, not a DOM overlay, because export reads
 * pixels off the canvas — DOM text would be invisible in every PNG and mp4.
 * troika-three-text renders signed-distance-field glyphs as real geometry, so
 * labels export cleanly and stay sharp at 1080p.
 *
 * The font is vendored (STIX Two Text, OFL) and imported as a bundled asset
 * rather than fetched from a CDN, so renders work offline and never blank out
 * mid-sequence because a font request was slow.
 *
 * Note: the bundled subset is Latin only — no ∫ or Σ. Labels here spell things
 * out ("sum", "exact") instead, which reads better on a projected slide anyway.
 */

import { Text } from 'troika-three-text';
import fontUrl from './assets/stix-two-text-regular.woff?url';
import { C } from './style';

export interface LabelOptions {
  /** Height of the text in world units. */
  size?: number;
  color?: number;
  opacity?: number;
  /** 'left' | 'center' | 'right', or a number. Default 'left'. */
  anchorX?: 'left' | 'center' | 'right' | number;
  /** 'top' | 'middle' | 'bottom', or a number. Default 'bottom'. */
  anchorY?: 'top' | 'top-baseline' | 'middle' | 'bottom-baseline' | 'bottom' | number;
  /** Space between lines, as a multiple of size. */
  lineHeight?: number;
  /** Extra letter spacing, in world units. */
  letterSpacing?: number;
  position?: [number, number, number];
}

/**
 * A text label. Remember to add it to the scene, and to call `setText` rather
 * than assigning `.text` directly when the string changes.
 */
export function label(text: string, opts: LabelOptions = {}): Text {
  const {
    size = 0.2,
    color = C.bone,
    opacity = 1,
    anchorX = 'left',
    anchorY = 'bottom',
    lineHeight = 1.35,
    letterSpacing = 0,
    position = [0, 0, 0],
  } = opts;

  const t = new Text();
  t.text = text;
  t.font = fontUrl;
  t.fontSize = size;
  t.color = color;
  t.anchorX = anchorX;
  t.anchorY = anchorY;
  t.lineHeight = lineHeight;
  t.letterSpacing = letterSpacing;
  t.material.transparent = opacity < 1;
  t.material.opacity = opacity;
  // Labels are overlay-ish: they should not be hidden by geometry behind them.
  t.material.depthTest = false;
  t.renderOrder = 10;
  t.position.set(...position);
  trackedSync(t);
  return t;
}

// troika lays glyphs out asynchronously, so a label changed during this frame
// is still showing its old string when the frame is drawn. Live, that one-frame
// lag is invisible. In a frame-stepped export it is not: every frame where a
// number changes gets captured with the *previous* value. Tracking outstanding
// syncs lets the exporter wait for the text to catch up before it grabs pixels.
let pendingSyncs = 0;
let waiters: (() => void)[] = [];

function trackedSync(t: Text): void {
  pendingSyncs++;
  t.sync(() => {
    pendingSyncs--;
    if (pendingSyncs === 0) {
      const w = waiters;
      waiters = [];
      for (const fn of w) fn();
    }
  });
}

/**
 * Change a label's string. troika needs an explicit `sync()` to re-lay-out the
 * glyphs; skip it and the text silently never updates.
 */
export function setText(t: Text, text: string): void {
  if (t.text === text) return; // sync() is not free — skip no-op updates
  t.text = text;
  trackedSync(t);
}

/**
 * Resolves once every outstanding label layout has finished. The exporter
 * awaits this before capturing, so numbers in a video are never a frame stale.
 *
 * Times out rather than hanging: if a font fails to load, a sync callback may
 * never fire, and a stuck export would be far worse than a slightly late label.
 */
export function textSettled(timeoutMs = 2000): Promise<void> {
  if (pendingSyncs === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    waiters.push(finish);
    setTimeout(finish, timeoutMs);
  });
}

/** Fixed-width number formatting, so a changing readout does not jitter. */
export function fixed(x: number, digits = 3): string {
  return x.toFixed(digits);
}
