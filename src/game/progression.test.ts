import { describe, expect, it } from "vitest";
import { createCampaign, RESEARCH_DEFS } from "./world";
import { getStats, isDisrupted, spawnSquad, step, tryCommand } from "./simulation";

const run = (s: ReturnType<typeof createCampaign>, secs: number) => {
  for (let i = 0; i < Math.round(secs * 10); i++) step(s, 0.1);
};

describe("research", () => {
  it("spends resources exactly once", () => {
    const s = createCampaign(2);
    s.factions.player.metal = 500;
    s.factions.player.energy = 500;
    expect(tryCommand(s, { type: "research", id: "armor1" }).ok).toBe(true);
    const m = s.factions.player.metal;
    expect(m).toBe(500 - RESEARCH_DEFS.armor1.metal);
    expect(tryCommand(s, { type: "research", id: "armor1" }).ok).toBe(false);
    expect(s.factions.player.metal).toBe(m);
    run(s, RESEARCH_DEFS.armor1.time + 1);
    expect(s.research.done).toContain("armor1");
    expect(tryCommand(s, { type: "research", id: "armor1" }).ok).toBe(false);
  });
  it("gates research behind objectives", () => {
    const s = createCampaign(2);
    s.factions.player.metal = 500;
    s.factions.player.energy = 500;
    expect(tryCommand(s, { type: "research", id: "hacking" }).ok).toBe(false);
    expect(tryCommand(s, { type: "research", id: "scoutTech" }).ok).toBe(false);
  });
});

describe("modules", () => {
  it("changes robot stats", () => {
    const s = createCampaign(2);
    const sq = s.squads.find((q) => q.owner === "player")!;
    const base = getStats(s, sq).hp;
    expect(tryCommand(s, { type: "module", unit: "assault", module: "plating" }).ok).toBe(false);
    s.research.done.push("modules");
    expect(tryCommand(s, { type: "module", unit: "assault", module: "plating" }).ok).toBe(true);
    expect(getStats(s, sq).hp).toBeGreaterThan(base);
    expect(tryCommand(s, { type: "module", unit: "assault", module: "shells" }).ok).toBe(false);
  });
});

describe("hacking", () => {
  it("disruption expires", () => {
    const s = createCampaign(2);
    s.research.done.push("hacking");
    s.factions.player.energy = 200;
    expect(tryCommand(s, { type: "hack", ability: "disrupt", regionId: 3 }).ok).toBe(true);
    expect(isDisrupted(s, 3)).toBe(true);
    run(s, 8.5);
    expect(isDisrupted(s, 3)).toBe(false);
  });
  it("drone swarm respects cooldown", () => {
    const s = createCampaign(2);
    s.research.done.push("hacking");
    s.factions.player.energy = 500;
    const target = spawnSquad(s, "red", "assault", 7);
    const hp = target.hp;
    expect(tryCommand(s, { type: "hack", ability: "swarm", regionId: 7 }).ok).toBe(true);
    expect(target.hp).toBeLessThan(hp);
    expect(tryCommand(s, { type: "hack", ability: "swarm", regionId: 7 }).ok).toBe(false);
    run(s, 46);
    expect(tryCommand(s, { type: "hack", ability: "swarm", regionId: 7 }).ok).toBe(true);
  });
});
