/**
 * Controls and keyboard shortcuts.
 *
 * lil-gui is DOM, and export reads pixels off the canvas, so the panel can
 * never leak into an exported PNG or mp4. It *would* show up in a screen
 * recording though — hence `H` to hide it, and the hint overlay that fades out.
 *
 * Every demo gets Capture controls for free.
 */

import GUI from 'lil-gui';
import type { Stage } from './stage';
import { saveStill, saveVideo } from './capture';
import { C, css } from './style';

export interface UIOptions {
  /**
   * Names exported files: out/<name>.mp4, out/stills/<name>-*.png.
   * Defaults to the demo's folder name, which is what you almost always want.
   */
  name?: string;
  /** Show the play/pause + time controls. Default true. */
  timeline?: boolean;
  /** Default export frame rate. */
  fps?: number;
}

export interface DemoUI {
  gui: GUI;
  /** Add your demo's own controls in here. */
  params: GUI;
  toast(msg: string, ms?: number): void;
}

function styleGui() {
  const s = document.createElement('style');
  s.textContent = `
    .lil-gui {
      --background-color: #14171a;
      --widget-color: #262c31;
      --hover-color: #333b42;
      --focus-color: #3d4750;
      --text-color: ${css(C.bone)};
      --number-color: ${css(C.ochre)};
      --string-color: ${css(C.moss)};
      --font-size: 12px;
      --title-background-color: #0d1013;
      z-index: 100;
    }
    .lil-gui.root { top: 12px; right: 12px; }
  `;
  document.head.appendChild(s);
}

export function createUI(stage: Stage, opts: UIOptions = {}): DemoUI {
  // The host page records which demo it loaded, so exports are named after the
  // folder without every demo having to repeat its own name.
  const { name = (window as any).__DEMO__ ?? 'demo', timeline = true, fps = 60 } = opts;
  styleGui();

  const gui = new GUI({ title: name });

  // --- toast ---------------------------------------------------------------
  const toastEl = document.createElement('div');
  Object.assign(toastEl.style, {
    position: 'fixed',
    bottom: '18px',
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '8px 16px',
    background: 'rgba(12,14,16,0.9)',
    color: css(C.bone),
    font: '13px ui-monospace, Menlo, monospace',
    borderRadius: '6px',
    border: `1px solid ${css(C.slateDeep)}`,
    pointerEvents: 'none',
    opacity: '0',
    transition: 'opacity 160ms',
    zIndex: '200',
  });
  document.body.appendChild(toastEl);
  let toastTimer: number | undefined;
  const toast = (msg: string, ms = 2200) => {
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    if (ms > 0) toastTimer = window.setTimeout(() => (toastEl.style.opacity = '0'), ms);
  };

  // --- timeline ------------------------------------------------------------
  if (timeline) {
    const f = gui.addFolder('Time');
    f.add(stage, 'speed', 0, 3, 0.05).name('speed');
    f.add(stage, 'duration', 0.5, 30, 0.5).name('loop (s)');
    f.add({ restart: () => (stage.t = 0) }, 'restart').name('restart (R)');
  }

  // --- capture -------------------------------------------------------------
  // The export RANGE is `from` -> `to` on the demo's own clock, rather than
  // a bare length: a figure whose interesting part is the first 6 s of a 20 s
  // loop should be exportable without anyone doing arithmetic. Defaults to
  // the whole loop, and stays independently settable — that is how you
  // export a slice.
  const capture = {
    fps,
    format: 'mp4' as 'mp4' | 'prores',
    from: 0,
    to: stage.duration,
  };
  const f = gui.addFolder('Capture');
  f.add({ still: async () => {
      try {
        const p = await saveStill(stage, name);
        toast(`saved ${p}`);
      } catch (e) {
        toast(`still failed: ${e}`, 5000);
      }
    } }, 'still').name('save PNG (S)');
  f.add(capture, 'fps', [24, 30, 60]).name('fps');
  const fromC = f.add(capture, 'from').min(0).step(0.1).name('from (s)');
  const toC = f.add(capture, 'to').min(0).step(0.1).name('to (s)');
  f.add({ whole: () => {
      capture.from = 0;
      capture.to = stage.duration;
      fromC.updateDisplay();
      toC.updateDisplay();
      toast(`export range 0 – ${stage.duration.toFixed(1)} s`, 1400);
    } }, 'whole').name('whole loop');
  f.add(capture, 'format', ['mp4', 'prores']).name('format');

  const runVideo = async () => {
    const from = Math.max(0, capture.from);
    const to = capture.to;
    if (!(to > from)) {
      toast(`export range is empty: from ${from} s, to ${to} s`, 5000);
      return;
    }
    // saveVideo awaits Stage.onReady work itself; say so, or a demo that
    // spends 40 s tracing passes before it can animate looks hung.
    toast('waiting for the demo to be ready…', 0);
    try {
      await stage.settled();
      toast('rendering frames…', 0);
      const p = await saveVideo(stage, name, {
        fps: capture.fps,
        startTime: from,
        duration: to - from,
        format: capture.format,
        onProgress: (d, t) => toast(`frame ${d}/${t}  (${Math.round((100 * d) / t)}%)`, 0),
      });
      toast(`saved ${p}`, 6000);
    } catch (e) {
      toast(`video failed: ${e}`, 6000);
    }
  };
  f.add({ video: runVideo }, 'video').name('render video (V)');

  // --- hint ----------------------------------------------------------------
  const hint = document.createElement('div');
  hint.textContent = 'H hide panel · S still · V video · R restart · space pause';
  Object.assign(hint.style, {
    position: 'fixed',
    bottom: '10px',
    left: '12px',
    color: css(C.slateDeep),
    font: '11px ui-monospace, Menlo, monospace',
    pointerEvents: 'none',
    transition: 'opacity 600ms',
    zIndex: '150',
  });
  document.body.appendChild(hint);
  setTimeout(() => (hint.style.opacity = '0'), 4000);

  // --- keys ----------------------------------------------------------------
  let hidden = false;
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const k = e.key.toLowerCase();
    if (k === 'h') {
      hidden = !hidden;
      gui.domElement.style.display = hidden ? 'none' : '';
      hint.style.display = hidden ? 'none' : '';
    } else if (k === 's') {
      saveStill(stage, name).then((p) => toast(`saved ${p}`)).catch((err) => toast(`${err}`, 5000));
    } else if (k === 'v') {
      void runVideo(); // same range as the button — one code path, one truth
    } else if (k === 'r') {
      stage.t = 0;
    } else if (e.code === 'Space') {
      e.preventDefault();
      stage.speed = stage.speed > 0 ? 0 : 1;
      toast(stage.speed > 0 ? 'play' : 'pause', 900);
    }
  });

  const api: DemoUI = { gui, params: gui.addFolder('Parameters'), toast };
  // Handy from the devtools console, and lets scripted screenshots drive the
  // controls: __ui.params.controllers.find(c => c.property === 'mode').setValue('sweep')
  (window as any).__ui = api;
  return api;
}
