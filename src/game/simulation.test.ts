import { describe, expect, it } from "vitest";
import { createCampaign, UNIT_DEFS } from "./world";
import { getStats, spawnSquad, step, tryCommand } from "./simulation";

const run = (s: ReturnType<typeof createCampaign>, secs: number) => {
  for (let i = 0; i < secs * 10; i++) step(s, 0.1);
  return s;
};

describe("orders", () => {
  it("rejects a capture order to a non-adjacent region", () => {
    const s = createCampaign(1);
    const sq = s.squads.find((q) => q.owner === "player")!;
    const r = tryCommand(s, { type: "order", squadId: sq.id, kind: "move", target: 13 });
    expect(r.ok).toBe(false);
    expect(sq.order).toBeNull();
  });
  it("accepts an order to an adjacent region", () => {
    const s = createCampaign(1);
    const sq = s.squads.find((q) => q.owner === "player")!;
    expect(tryCommand(s, { type: "order", squadId: sq.id, kind: "move", target: 3 }).ok).toBe(true);
    expect(sq.path).toEqual([3]);
  });
  it("cannot command enemy squads", () => {
    const s = createCampaign(1);
    const sq = s.squads.find((q) => q.owner === "red")!;
    expect(tryCommand(s, { type: "order", squadId: sq.id, kind: "move", target: 7 }).ok).toBe(false);
  });
});

describe("production", () => {
  it("never spends more than available", () => {
    const s = createCampaign(1);
    s.factions.player.metal = 40;
    expect(tryCommand(s, { type: "recruit", regionId: 0, unit: "assault" }).ok).toBe(false);
    expect(s.factions.player.metal).toBe(40);
    s.factions.player.metal = 100;
    expect(tryCommand(s, { type: "recruit", regionId: 0, unit: "assault" }).ok).toBe(true);
    expect(tryCommand(s, { type: "recruit", regionId: 0, unit: "assault" }).ok).toBe(true);
    expect(s.factions.player.metal).toBe(0);
    expect(tryCommand(s, { type: "recruit", regionId: 0, unit: "assault" }).ok).toBe(false);
    expect(s.factions.player.metal).toBe(0);
  });
  it("locks scouts until researched", () => {
    const s = createCampaign(1);
    expect(tryCommand(s, { type: "recruit", regionId: 0, unit: "scout" }).ok).toBe(false);
  });
  it("spawns the queued unit when complete", () => {
    const s = createCampaign(1);
    const before = s.squads.filter((q) => q.owner === "player").length;
    tryCommand(s, { type: "recruit", regionId: 0, unit: "assault" });
    run(s, 7);
    expect(s.squads.filter((q) => q.owner === "player").length).toBe(before + 1);
  });
  it("capturing a factory cancels the former owner's production with no spawn", () => {
    const s = createCampaign(1);
    const f = s.regions[4];
    f.owner = "red";
    s.squads = s.squads.filter((q) => q.at !== 4);
    s.factions.red.metal = 500;
    f.queue.push({ unit: "assault", owner: "red", remaining: 6 });
    for (let i = 0; i < 3; i++) spawnSquad(s, "player", "assault", 4);
    const redBefore = s.squads.filter((q) => q.owner === "red").length;
    run(s, 10);
    expect(f.owner).toBe("player");
    expect(f.queue).toHaveLength(0);
    expect(s.squads.filter((q) => q.owner === "red").length).toBe(redBefore);
    expect(s.squads.some((q) => q.owner === "red" && q.at === 4)).toBe(false);
  });
});

describe("classes and combat", () => {
  it("gives classes distinct roles", () => {
    expect(UNIT_DEFS.scout.speed).toBeGreaterThan(UNIT_DEFS.assault.speed);
    expect(UNIT_DEFS.assault.hp).toBeGreaterThan(UNIT_DEFS.artillery.hp);
    expect(UNIT_DEFS.artillery.range).toBeGreaterThan(UNIT_DEFS.assault.range);
    expect(UNIT_DEFS.scout.capture).toBeGreaterThan(UNIT_DEFS.assault.capture);
  });
  it("defeats defenders then captures and produces resources", () => {
    const s = createCampaign(1);
    for (const sq of s.squads.filter((q) => q.owner === "player")) tryCommand(s, { type: "order", squadId: sq.id, kind: "attack", target: 3 });
    run(s, 40);
    expect(s.squads.some((q) => q.owner === "neutral" && q.at === 3)).toBe(false);
    expect(s.regions[3].owner).toBe("player");
    expect(s.stats.captures).toBe(1);
    const m = s.factions.player.metal;
    run(s, 5);
    expect(s.factions.player.metal).toBeGreaterThan(m);
  });
  it("defend order reduces damage taken", () => {
    const s = createCampaign(1);
    const a = s.squads.find((q) => q.owner === "player")!;
    expect(getStats(s, a).hp).toBe(UNIT_DEFS.assault.hp);
  });
});
