// Recording = stepping the clock, not capturing the screen. Both writers
// advance the timeline in fixed increments and render each frame however
// long it takes — which is what makes arbitrarily expensive frames (tubes,
// eventually per-frame path-traced beauty renders) possible.

export interface FrameSource {
  canvas: HTMLCanvasElement;
  // Set the clock and render one frame; may be async and arbitrarily slow.
  renderFrame(t: number): Promise<void> | void;
}

export interface RecordOptions {
  fps: number;
  duration: number; // seconds of timeline to record
}

// Quick capture to a .webm download via MediaRecorder. Frame-accurate: we
// request each frame explicitly on a zero-fps capture stream.
export async function recordWebM(source: FrameSource, opts: RecordOptions): Promise<void> {
  const stream = source.canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
  recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
  recorder.start();

  const frames = Math.ceil(opts.duration * opts.fps);
  for (let i = 0; i <= frames; i++) {
    await source.renderFrame(i / opts.fps);
    track.requestFrame();
    // MediaRecorder timestamps by wall clock; pace roughly to the target
    // rate so playback speed is right. (Frame DUMPS have no such coupling.)
    await new Promise((r) => setTimeout(r, 1000 / opts.fps));
  }

  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
    recorder.stop();
  });
  const url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'timeline.webm';
  a.click();
  URL.revokeObjectURL(url);
}

// Robust route for expensive frames: PNG per frame into a user-picked
// directory (File System Access API), stitched offline with e.g.
//   ffmpeg -framerate 30 -i frame_%05d.png -pix_fmt yuv420p out.mp4
export async function recordFrames(source: FrameSource, opts: RecordOptions): Promise<void> {
  const dir = await (window as unknown as {
    showDirectoryPicker(o?: object): Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker({ mode: 'readwrite' });

  const frames = Math.ceil(opts.duration * opts.fps);
  for (let i = 0; i <= frames; i++) {
    await source.renderFrame(i / opts.fps);
    const blob = await new Promise<Blob>((resolve, reject) =>
      source.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
    );
    const name = `frame_${String(i).padStart(5, '0')}.png`;
    const file = await dir.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    await writable.write(blob);
    await writable.close();
  }
}
