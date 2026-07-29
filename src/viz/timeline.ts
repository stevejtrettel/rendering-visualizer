// The shared clock. Elements are pure functions of time — drawAt(t) fully
// determines their appearance — so play, scrub, single-step, and offline
// frame-stepping are all the same operation: setTime.
export interface TimelineElement {
  drawAt(t: number): void;
  dispose(): void;
}

export class Timeline {
  private elements: TimelineElement[] = [];
  private t = 0;
  duration = 0;
  playing = false;
  playbackRate = 1;
  onTimeChange: ((t: number) => void) | null = null;

  add(element: TimelineElement, duration: number): void {
    this.elements.push(element);
    this.duration = Math.max(this.duration, duration);
    element.drawAt(this.t);
  }

  clear(): void {
    for (const e of this.elements) e.dispose();
    this.elements = [];
    this.duration = 0;
    this.t = 0;
  }

  get time(): number {
    return this.t;
  }

  setTime(t: number): void {
    this.t = Math.min(Math.max(0, t), this.duration);
    for (const e of this.elements) e.drawAt(this.t);
    this.onTimeChange?.(this.t);
  }

  // Advance by real elapsed seconds while playing (call from the rAF loop).
  tick(deltaSeconds: number): void {
    if (!this.playing) return;
    const next = this.t + deltaSeconds * this.playbackRate;
    this.setTime(next);
    if (this.t >= this.duration) this.playing = false;
  }
}
