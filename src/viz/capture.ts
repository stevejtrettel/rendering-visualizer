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

/**
 * Render and read back in ONE task.
 *
 * Without preserveDrawingBuffer the drawing buffer is cleared as soon as the
 * browser composites, so anything that yields between the draw and the read
 * — an await, a rAF — captures a blank canvas. toBlob snapshots at call
 * time even though it delivers asynchronously, so this is safe as long as
 * nothing yields in between.
 */
function renderAndRead(stage: Stage): Promise<Blob> {
  stage.render();
  return canvasBlob(stage.canvas);
}

/** Save a single PNG at full export resolution into out/stills/. */
export async function saveStill(stage: Stage, name: string): Promise<string> {
  // Whatever the demo said it was still preparing (see Stage.onReady) —
  // capturing before it lands would save a half-built frame.
  await stage.settled();
  return stage.atExportSize(async () => {
    await textSettled();
    await stage.captureReady();
    const blob = await renderAndRead(stage);
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

  // A demo whose frames depend on work still in flight (a convergence
  // sequence being traced, say) registers it with Stage.onReady. Waiting
  // here is what stops an export from capturing the preparation instead of
  // the figure — `speed = 0` holds the preview but never the exporter,
  // which drives setTime directly.
  await stage.settled();

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
        // Anything the demo cannot draw in one call — a path tracer
        // accumulating this frame's samples, say.
        await stage.captureReady();
        const blob = await renderAndRead(stage);
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
