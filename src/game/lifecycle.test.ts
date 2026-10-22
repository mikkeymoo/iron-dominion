import { describe, expect, it } from "vitest";
import { SimClock, STEP_MS } from "./lifecycle";
import { createCampaign } from "./world";
import { advance } from "./engine";

function drive(clock: SimClock, state: ReturnType<typeof createCampaign>, now: number) {
  const n = clock.frame(now);
  for (let i = 0; i < n; i++) advance(state, STEP_MS / 1000);
  return n;
}

describe("SimClock", () => {
  it("runs fixed 100ms steps", () => {
    const c = new SimClock();
    c.resume(0);
    expect(c.frame(50)).toBe(0);
    expect(c.frame(100)).toBe(1);
    expect(c.frame(350)).toBe(2);
  });
  it("hidden tab with a long gap does not advance until Resume and has no catch-up", () => {
    const c = new SimClock();
    const s = createCampaign(1);
    c.resume(0);
    drive(c, s, 1000);
    const t = s.time;
    const metal = s.factions.player.metal;
    c.hide();
    expect(c.needsResume).toBe(true);
    expect(drive(c, s, 1000 + 3_600_000)).toBe(0);
    expect(drive(c, s, 1000 + 7_200_000)).toBe(0);
    expect(s.time).toBe(t);
    expect(s.factions.player.metal).toBe(metal);
    c.resume(1000 + 7_200_000);
    expect(c.needsResume).toBe(false);
    expect(drive(c, s, 1000 + 7_200_050)).toBe(0);
    expect(drive(c, s, 1000 + 7_200_100)).toBe(1);
    expect(s.time).toBeCloseTo(t + 0.1, 5);
  });
  it("caps a single long frame so stalls never produce big catch-up", () => {
    const c = new SimClock();
    c.resume(0);
    expect(c.frame(60_000)).toBeLessThanOrEqual(3);
  });
  it("manual pause stops steps", () => {
    const c = new SimClock();
    c.resume(0);
    c.pause();
    expect(c.frame(5000)).toBe(0);
  });
});
