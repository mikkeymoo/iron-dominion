export const STEP_MS = 100;
const MAX_FRAME_MS = 250;

/**
 * Wall-clock to fixed-step converter. Never accumulates time while paused/hidden;
 * resume() resets the reference time and accumulator so there is no catch-up.
 */
export class SimClock {
  running = false;
  needsResume = false;
  private last = 0;
  private acc = 0;

  resume(now: number) {
    this.running = true;
    this.needsResume = false;
    this.last = now;
    this.acc = 0;
  }
  pause() {
    this.running = false;
    this.acc = 0;
  }
  hide() {
    this.pause();
    this.needsResume = true;
  }
  frame(now: number): number {
    if (!this.running) return 0;
    const delta = Math.min(Math.max(0, now - this.last), MAX_FRAME_MS);
    this.last = now;
    this.acc += delta;
    const steps = Math.floor(this.acc / STEP_MS + 1e-9);
    this.acc -= steps * STEP_MS;
    return steps;
  }
}
