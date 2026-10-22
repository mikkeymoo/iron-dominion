import { describe, expect, it } from "vitest";
import { createCampaign, RIVALS, CORE_REGION } from "./world";

describe("createCampaign", () => {
  const s = createCampaign(7);
  it("has exactly 18 regions", () => expect(s.regions).toHaveLength(18));
  it("is fully connected with symmetric adjacency", () => {
    const seen = new Set([0]);
    const q = [0];
    while (q.length) for (const n of s.regions[q.shift()!].neighbors) if (!seen.has(n)) (seen.add(n), q.push(n));
    expect(seen.size).toBe(18);
    for (const r of s.regions) for (const n of r.neighbors) expect(s.regions[n].neighbors).toContain(r.id);
  });
  it("has one player HQ and three rival HQs", () => {
    const hqs = s.regions.filter((r) => r.kind === "hq");
    expect(hqs.filter((r) => r.owner === "player")).toHaveLength(1);
    expect(RIVALS).toHaveLength(3);
    for (const rival of RIVALS) expect(hqs.filter((r) => r.owner === rival)).toHaveLength(1);
  });
  it("has a dormant rogue core", () => {
    expect(s.regions[CORE_REGION].owner).toBe("rogue");
    expect(s.rogue.stage).toBe("dormant");
  });
  it("is deterministic for a seed", () => expect(JSON.stringify(createCampaign(7))).toBe(JSON.stringify(s)));
});
