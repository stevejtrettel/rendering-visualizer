/**
 * Export: stills and video.
 *
 * The browser cannot write files, so pixels are POSTed to the vite dev server,
 * which drops them on disk and runs ffmpeg (see the capture plugin in
 * vite.config.ts). The result is that video export is one button and ends with
 * a finished .mp4 in out/ — nothing to unzip, nothing to assemble.
 *
 * Video export steps `t` by exactly 1/fps and waits for each frame, so a frame
 * that takes two seconds to render is fine. Playback speed and dropped frames
 * cannot affect the result.
 */

import type { Stage } from './stage';
import { textSettled } from './text';

export interface VideoOptions {
  /** Seconds of footage. Defaults to the stage's loop duration. */
  duration?: number;
  fps?: number;
  /** 'mp4' (H.264, plays everywhere) or 'prores' (huge, pristine, alpha). */
  format?: 'mp4' | 'prores';
  /** Time to start from. Default 0. */
  startTime?: number;
  onProgress?: (done: number, total: number) => void;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/png'),
  );
}

/** Let the browser actually paint before we read pixels back. */
function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

/** Save a single PNG at full export resolution into out/stills/. */
export async function saveStill(stage: Stage, name: string): Promise<string> {
  return stage.atExportSize(async () => {
    await textSettled();
    stage.render();
    await nextFrame();
    const blob = await canvasBlob(stage.canvas);
    const res = await fetch(`/__shot?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      body: blob,
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error ?? 'shot failed');
    console.log(`[still] ${body.path}`);
    return body.path as string;
  });
}

/**
 * Render a frame-stepped sequence and encode it to a movie.
 *
 * Returns the path of the finished file, relative to the repo root.
 */
export async function saveVideo(
  stage: Stage,
  name: string,
  opts: VideoOptions = {},
): Promise<string> {
  const {
    duration = stage.duration,
    fps = 60,
    format = 'mp4',
    startTime = 0,
    onProgress,
  } = opts;

  const total = Math.round(duration * fps);
  const wasRunning = true;
  const savedTime = stage.t;

  // Freeze live playback: from here time is driven only by the loop below.
  stage.stop();

  try {
    return await stage.atExportSize(async () => {
      for (let i = 0; i < total; i++) {
        stage.setTime(startTime + i / fps);
        // Labels changed by that update are still laying out; wait for them,
        // then redraw, or the frame captures the previous frame's numbers.
        await textSettled();
        stage.render();
        await nextFrame();
        const blob = await canvasBlob(stage.canvas);
        const res = await fetch(`/__frame?name=${encodeURIComponent(name)}&i=${i}`, {
          method: 'POST',
          body: blob,
        });
        if (!res.ok) throw new Error(`frame ${i} failed: ${await res.text()}`);
        onProgress?.(i + 1, total);
      }

      const res = await fetch(
        `/__encode?name=${encodeURIComponent(name)}&fps=${fps}&format=${format}`,
        { method: 'POST' },
      );
      const body = await res.json();
      if (!body.ok) throw new Error(body.error ?? 'encode failed');
      console.log(`[video] ${body.path}`);
      return body.path as string;
    });
  } finally {
    stage.t = savedTime;
    if (wasRunning) stage.start();
  }
}
