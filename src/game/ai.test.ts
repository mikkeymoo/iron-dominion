import { describe, expect, it } from "vitest";
import { createCampaign, CORE_REGION, RIVALS } from "./world";
import { changeOwner, spawnSquad, step } from "./simulation";
import { updateAI } from "./ai";
import { advance } from "./engine";

describe("rival AI", () => {
  it("recruits by spending its own resources", () => {
    const s = createCampaign(3);
    s.factions.red.metal = 200;
    updateAI(s, 1);
    expect(s.factions.red.metal).toBeLessThan(200);
    expect(s.regions.find((r) => r.owner === "red" && r.kind === "hq")!.queue.length).toBeGreaterThan(0);
  });
  it("attacks only regions adjacent to its territory", () => {
    const s = createCampaign(3);
    for (let i = 0; i < 5; i++) spawnSquad(s, "red", "assault", 6);
    s.ai.red.attackTimer = 0;
    updateAI(s, 1);
    const ordered = s.squads.filter((q) => q.owner === "red" && q.order);
    expect(ordered.length).toBeGreaterThan(0);
    for (const q of ordered) {
      const t = s.regions[q.order!.target];
      const ok = t.owner === "red" || t.neighbors.some((n) => s.regions[n].owner === "red");
      expect(ok).toBe(true);
    }
  });
  it("rivals keep respecting adjacency over a long simulated run", () => {
    const s = createCampaign(11);
    const seen = new Map<number, unknown>();
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      advance(s, 0.1);
      for (const q of s.squads) {
        if (!RIVALS.includes(q.owner as never) || !q.order || seen.get(q.id) === q.order) continue;
        seen.set(q.id, q.order);
        const t = s.regions[q.order.target];
        expect(t.owner === q.owner || t.neighbors.some((n) => s.regions[n].owner === q.owner)).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(5);
    for (const r of RIVALS) expect(s.factions[r].metal).toBeGreaterThanOrEqual(0);
  });
});

describe("rogue threat", () => {
  it("grows only through simulation steps", () => {
    const s = createCampaign(3);
    expect(s.threat).toBe(0);
    JSON.parse(JSON.stringify(s));
    expect(s.threat).toBe(0);
    for (let i = 0; i < 100; i++) advance(s, 0.1);
    expect(s.threat).toBeGreaterThan(0);
  });
  it("grows faster with more player territory", () => {
    const a = createCampaign(3);
    const b = createCampaign(3);
    for (const id of [1, 2, 3, 7, 8]) changeOwner(b, id, "player");
    for (let i = 0; i < 100; i++) (advance(a, 0.1), advance(b, 0.1));
    expect(b.threat).toBeGreaterThan(a.threat);
  });
  it("telegraphs before awakening", () => {
    const s = createCampaign(3);
    s.threat = 69.99;
    updateAI(s, 1);
    expect(s.rogue.stage).toBe("stirring");
    expect(s.events.some((e) => e.text.includes("stirring"))).toBe(true);
  });
  it("raids hit both rivals and the player", () => {
    const s = createCampaign(3);
    s.threat = 100;
    s.rogue.stage = "awake";
    for (let i = 0; i < 4; i++) {
      s.rogue.raidTimer = 0;
      s.squads = s.squads.filter((q) => q.owner !== "rogue" || q.at === CORE_REGION);
      updateAI(s, 1);
    }
    expect(s.rogue.raidHistory).toContain("player");
    expect(s.rogue.raidHistory.some((f) => RIVALS.includes(f as never))).toBe(true);
    expect(s.squads.some((q) => q.owner === "rogue" && q.order)).toBe(true);
  });
});

describe("end conditions", () => {
  it("losing headquarters defeats the player", () => {
    const s = createCampaign(3);
    changeOwner(s, 0, "red");
    step(s, 0.1);
    expect(s.status).toBe("defeat");
  });
  it("destroying the core and controlling the map wins", () => {
    const s = createCampaign(3);
    s.rogue.coreHp = 0;
    s.rogue.stage = "destroyed";
    step(s, 0.1);
    expect(s.status).toBe("playing");
    for (const id of [1, 2, 3, 4, 5, 7, 8, 11, 12, 14, 15]) changeOwner(s, id, "player");
    step(s, 0.1);
    expect(s.status).toBe("playing");
    for (const r of s.regions) changeOwner(s, r.id, "player");
    step(s, 0.1);
    expect(s.status).toBe("victory");
  });
});
