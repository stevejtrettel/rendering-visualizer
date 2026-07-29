// Shared play/scrub/step control strip for timeline demos. Plain DOM — kept
// out of exports (movies are recorded from the canvas, not the page).
import type { Timeline } from './timeline';

export interface ControlsOptions {
  container: HTMLElement;
  timeline: Timeline;
  onRecordWebM?: () => void;
  onRecordFrames?: () => void;
}

export function attachControls({ container, timeline, onRecordWebM, onRecordFrames }: ControlsOptions): void {
  container.innerHTML = `
    <style>
      .tl-strip { display: flex; gap: 10px; align-items: center; padding: 8px 12px;
                  background: #1a1a1a; font: 13px ui-sans-serif, system-ui, sans-serif; }
      .tl-strip button { background: #2a2a2a; color: #eaeaea; border: 1px solid #444;
                         border-radius: 4px; padding: 4px 12px; cursor: pointer; }
      .tl-strip button:hover { background: #383838; }
      .tl-strip input[type=range] { flex: 1; }
      .tl-strip .tl-time { color: #999; min-width: 7.5em; text-align: right;
                           font-variant-numeric: tabular-nums; }
    </style>
    <div class="tl-strip">
      <button data-act="play">▶</button>
      <button data-act="back">−0.1s</button>
      <button data-act="fwd">+0.1s</button>
      <input type="range" min="0" max="1000" value="0" data-act="scrub">
      <span class="tl-time">0.00 / 0.00 s</span>
      <select data-act="rate">
        <option value="0.25">0.25×</option>
        <option value="0.5">0.5×</option>
        <option value="1" selected>1×</option>
        <option value="2">2×</option>
      </select>
      ${onRecordWebM ? '<button data-act="webm">● webm</button>' : ''}
      ${onRecordFrames ? '<button data-act="frames">● frames</button>' : ''}
    </div>`;

  const el = <T extends HTMLElement>(act: string) =>
    container.querySelector<T>(`[data-act="${act}"]`)!;
  const playBtn = el<HTMLButtonElement>('play');
  const scrub = el<HTMLInputElement>('scrub');
  const timeLabel = container.querySelector<HTMLSpanElement>('.tl-time')!;

  playBtn.addEventListener('click', () => {
    if (timeline.time >= timeline.duration) timeline.setTime(0);
    timeline.playing = !timeline.playing;
    playBtn.textContent = timeline.playing ? '❚❚' : '▶';
  });
  el<HTMLButtonElement>('back').addEventListener('click', () => timeline.setTime(timeline.time - 0.1));
  el<HTMLButtonElement>('fwd').addEventListener('click', () => timeline.setTime(timeline.time + 0.1));
  scrub.addEventListener('input', () => {
    timeline.playing = false;
    playBtn.textContent = '▶';
    timeline.setTime((Number(scrub.value) / 1000) * timeline.duration);
  });
  el<HTMLSelectElement>('rate').addEventListener('change', (e) => {
    timeline.playbackRate = Number((e.target as HTMLSelectElement).value);
  });
  onRecordWebM && el<HTMLButtonElement>('webm').addEventListener('click', onRecordWebM);
  onRecordFrames && el<HTMLButtonElement>('frames').addEventListener('click', onRecordFrames);

  timeline.onTimeChange = (t) => {
    scrub.value = String(Math.round((t / Math.max(timeline.duration, 1e-9)) * 1000));
    timeLabel.textContent = `${t.toFixed(2)} / ${timeline.duration.toFixed(2)} s`;
    if (!timeline.playing) playBtn.textContent = '▶';
  };
  timeline.setTime(0);
}
